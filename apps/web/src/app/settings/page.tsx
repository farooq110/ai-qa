"use client";

import Link from "next/link";
import { Fragment, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Building2, Check, CircleHelp, Globe, Link2, Pencil, Plus, Server, Trash2, Unplug, UserRound, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ConfirmDialog, type ConfirmRequest } from "@/components/confirm-dialog";
import { GitlabInstanceModal } from "@/components/gitlab-instance-modal";
import { SearchableSelect } from "@/components/searchable-select";
import { BitbucketIcon, GithubIcon, GitlabIcon } from "@/components/brand-icons";
import { api, apiUrl, fmtDate, statusLabels } from "@/lib/api";
import { can, requireSubscription, useMe, useProjects, useToast, type MePayload } from "@/lib/hooks";
import { PersonalSettings } from "./personal-settings";
import { PERMISSIONS } from "@ai-qa/domain";

interface EnvironmentDto { id: string; name: string; url: string; isDefault: boolean; hasCredentials?: boolean; loginUrl?: string | null; routeFixtures?: Record<string, Record<string, string> | Array<Record<string, string>>> }
interface ConnectionDto { id: string; provider: string; baseUrl: string; accountLogin: string; createdAt: string; updatedAt: string }
interface GitlabInstanceDto { baseUrl: string | null; clientId: string | null; redirectUri: string }

const repositoryProviders = [
  { key: "github", label: "GitHub", hint: "Install the Proofline GitHub App on an account or organization and choose which repositories it can see." },
  { key: "bitbucket", label: "Bitbucket", hint: "Authorize Proofline on Bitbucket to import repositories from your workspaces." },
  { key: "gitlab", label: "GitLab", hint: "Authorize Proofline on gitlab.com, or add your own self-managed GitLab instance." }
] as const;

type Tab = "organization" | "personal";
type Notify = ReturnType<typeof useToast>["notify"];

const hostOf = (url: string) => url.replace(/^https?:\/\//, "");

const tabs: { key: Tab; label: string; icon: typeof Building2 }[] = [
  { key: "organization", label: "Organization", icon: Building2 },
  { key: "personal", label: "Personal", icon: UserRound }
];

export default function SettingsPage() {
  return <Suspense><Settings /></Suspense>;
}

function Settings() {
  const me = useMe();
  const { toast, notify } = useToast();
  const [tab, setTab] = useState<Tab>(useSearchParams().get("tab") === "personal" ? "personal" : "organization");

  function selectTab(next: Tab) {
    setTab(next);
    // Keep the tab in the URL so reloads and shared links land on it.
    window.history.replaceState({}, "", next === "organization" ? "/settings" : `/settings?tab=${next}`);
  }

  return (
    <AppShell activePath="/settings">
      <header className="page-header settings-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">{tab === "organization" ? `${me?.organization?.name ?? ""}${me?.organization?.industry ? ` · ${me.organization.industry}` : ""}` : (me?.email ?? "")}</p>
        </div>
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {tabs.map(({ key, label, icon: Icon }) => <button key={key} id={`tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`panel-${key}`} className={tab === key ? "active" : ""} onClick={() => selectTab(key)}><Icon size={15} />{label}</button>)}
        </div>
      </header>

      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "organization" ? <OrganizationSettings me={me} notify={notify} /> : <PersonalSettings me={me} notify={notify} />}
      </div>

      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </AppShell>
  );
}

function OrganizationSettings({ me, notify }: { me: MePayload | null; notify: Notify }) {
  const { projects, selected } = useProjects();
  const [environments, setEnvironments] = useState<EnvironmentDto[]>([]);
  const [newEnvironment, setNewEnvironment] = useState<{ name: string; url: string }>({ name: "", url: "" });
  const [showAuth, setShowAuth] = useState(false);
  const [fixtureDraft, setFixtureDraft] = useState<Record<string, string>>({});
  const [auth, setAuth] = useState<{ loginUrl: string; loginTrigger: string; username: string; password: string }>({ loginUrl: "", loginTrigger: "", username: "", password: "" });
  const [connections, setConnections] = useState<ConnectionDto[] | null>(null);
  const [gitlabInstance, setGitlabInstance] = useState<GitlabInstanceDto | null>(null);
  const [configuringGitlab, setConfiguringGitlab] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [envProjectId, setEnvProjectId] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(null);

  const isAdmin = can(me, PERMISSIONS.SETTINGS_MANAGE);

  const reload = useCallback(async () => {
    try {
      const envProject = envProjectId || selected?.id;
      if (envProject) setEnvironments(await api<EnvironmentDto[]>(`/v1/projects/${envProject}/environments`));
      setConnections(await api<ConnectionDto[]>("/v1/repository-connections"));
      setGitlabInstance(await api<GitlabInstanceDto>("/v1/repository-connections/gitlab/self-managed"));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load settings", "error");
    }
  }, [selected, envProjectId, notify]);

  // Connected accounts load exactly once per page. `reload` must NOT be a mount-effect
  // dependency here: it is recreated when the project selection settles (selected: null → id),
  // and re-running it fetched this panel twice. Environments are project-scoped and get
  // their own selection-driven effect below.
  const connectionsLoaded = useRef(false);
  useEffect(() => {
    if (connectionsLoaded.current) return;
    connectionsLoaded.current = true;
    void (async () => {
      try {
        setConnections(await api<ConnectionDto[]>("/v1/repository-connections"));
        setGitlabInstance(await api<GitlabInstanceDto>("/v1/repository-connections/gitlab/self-managed"));
      } catch (error) {
        connectionsLoaded.current = false;
        notify(error instanceof Error ? error.message : "Unable to load settings", "error");
      }
    })();
  }, []);

  // Environments follow the selected project: load when the selection settles, refetch on switch.
  useEffect(() => {
    const envProject = envProjectId || selected?.id;
    if (!envProject) return;
    let cancelled = false;
    api<EnvironmentDto[]>(`/v1/projects/${envProject}/environments`)
      .then((rows) => { if (!cancelled) setEnvironments(rows); })
      .catch((error) => { if (!cancelled) notify(error instanceof Error ? error.message : "Unable to load environments", "error"); });
    return () => { cancelled = true; };
  }, [envProjectId, selected?.id, notify]);

  // Return trip from an OAuth callback: /settings?connected=github | connected=error&provider=x.
  // That return is a fresh page load, so the panel above already fetched everything once —
  // reload() here would show the loading state a second time. Only report the outcome.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (!connected) return;
    const provider = params.get("provider");
    const label = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "account";
    if (connected === "error") {
      notify(`${label} connection was not completed. The attempt may have expired or been denied — try Connect ${label} again.`, "error");
    } else if (connected === "pending") {
      notify(`${label} installation requested. An owner of that ${label} organization must approve it, then connect again.`, "info");
    } else {
      notify(`${connected.charAt(0).toUpperCase()}${connected.slice(1)} account connected. You can now analyze its repositories.`, "success");
    }
    window.history.replaceState({}, "", "/settings");
  }, [notify]);

  function connectProvider(provider: string, selfManaged = false) {
    if (requireSubscription(me)) return;
    void (async () => {
      setBusy(`connect-${provider}${selfManaged ? "-self" : ""}`);
      try {
        const result = await api<{ url: string }>(`/v1/repository-connections/${provider}/authorize?returnTo=/settings${selfManaged ? "&selfManaged=true" : ""}`);
        window.location.assign(result.url);
      } catch (error) {
        notify(error instanceof Error ? error.message : "Unable to start the connection", "error");
        setBusy(null);
      }
    })();
  }

  function removeGitlabInstance(baseUrl: string) {
    setPendingConfirm({
      title: `Remove ${hostOf(baseUrl)}?`,
      body: "The instance's OAuth application is deleted from Proofline. Accounts connected through it keep working until their access tokens expire (about two hours) and then need the instance added again.",
      confirmLabel: "Remove",
      action: () => act("remove-gitlab-instance", () => api("/v1/repository-connections/gitlab/self-managed", { method: "DELETE" }), `${hostOf(baseUrl)} removed.`)
    });
  }

  function disconnectProvider(connection: ConnectionDto) {
    const providerLabel = connection.baseUrl ? hostOf(connection.baseUrl) : repositoryProviders.find((provider) => provider.key === connection.provider.toLowerCase())?.label ?? connection.provider;
    setPendingConfirm({
      title: `Disconnect ${providerLabel}?`,
      body: `${connection.accountLogin} will be removed from this organization. Projects imported through it stop analyzing until you reconnect — their tests and run history are not affected.${connection.provider === "GITHUB" ? " To revoke repository access on GitHub too, uninstall the app from that account's GitHub settings." : ""}`,
      confirmLabel: "Disconnect",
      action: () => act(`disconnect-${connection.id}`, () => api(`/v1/repository-connections/${connection.id}`, { method: "DELETE" }), `${connection.accountLogin} disconnected.`)
    });
  }

  async function act(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try { await fn(); notify(success, "success"); await reload(); }
    catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); }
    finally { setBusy(null); }
  }

  const envProjectId2 = envProjectId || selected?.id || "";
  const envProjectName = envProjectId ? (projects ?? []).find((project) => project.id === envProjectId)?.name ?? "Project" : (selected?.name ?? "Select a project");

  return (
    <>
      <section className="settings-grid">
        <section className="panel">
          <div className="panel-heading"><div><h2>Profile</h2></div></div>
          <dl className="detail-grid stacked">
            <div><dt>Name</dt><dd>{me?.organization?.name ?? "—"}</dd></div>
            <div><dt>Industry</dt><dd>{me?.organization?.industry ?? "—"}</dd></div>
            <div><dt>Your role</dt><dd>{me?.role ?? "—"}</dd></div>
            <div><dt>Organization id</dt><dd><code>{me?.organization?.id ?? "—"}</code></dd></div>
          </dl>
        </section>

        {can(me, PERMISSIONS.BILLING_VIEW) && <section className="panel">
          <div className="panel-heading"><div><h2>{me?.organization?.subscription?.plan?.name ?? "No"} plan</h2></div></div>
          <p className="muted">Plan, trial, usage, invoices and cancellation are managed on the Billing page.</p>
          <Link className="secondary-button" href="/billing">Open billing</Link>
        </section>}

        <section className="panel span-full">
          <div className="panel-heading"><div><h2>Repository providers</h2></div></div>
          <p className="muted">Connect the accounts your repositories live on, then import repositories from Projects → New project. Tokens stay server-side.</p>
          <div className="provider-grid">
            {repositoryProviders.map((provider) => {
              const connected = connections?.filter((connection) => connection.provider === provider.key.toUpperCase()) ?? [];
              const loading = connections === null || (provider.key === "gitlab" && gitlabInstance === null);
              const Icon = provider.key === "github" ? GithubIcon : provider.key === "bitbucket" ? BitbucketIcon : GitlabIcon;
              const instance = provider.key === "gitlab" && gitlabInstance?.baseUrl ? gitlabInstance.baseUrl : null;
              return (
                <div className="provider-tile" key={provider.key}>
                  <div className="provider-tile-head" title={provider.hint}>
                    <Icon size={15} />
                    <strong>{provider.label}</strong>
                    {loading ? <span className="skel" style={{ width: 74, height: 18, borderRadius: 999, marginLeft: "auto" }} /> : <span className={`status ${connected.length ? "approved" : "archived"}`}>{connected.length ? "connected" : "not connected"}</span>}
                  </div>
                  {connected.map((connection) => (
                    <div className="connection-row" key={connection.id}>
                      <span className="avatar">{connection.accountLogin.slice(0, 2).toUpperCase()}</span>
                      <div className="connection-copy"><strong>{connection.accountLogin}</strong><small>{connection.baseUrl ? `${hostOf(connection.baseUrl)} · ` : ""}since {fmtDate(connection.createdAt)}</small></div>
                      <button className="mini-button danger ghost" aria-label={`Disconnect ${connection.accountLogin}`} title="Disconnect account" onClick={() => disconnectProvider(connection)} disabled={!isAdmin || busy !== null}><Unplug size={12} /></button>
                    </div>
                  ))}
                  {!loading && <div className="provider-actions">
                    <button className="secondary-button" onClick={() => connectProvider(provider.key)} disabled={!isAdmin || busy !== null} title={isAdmin ? provider.hint : "Ask an organization admin to connect accounts"}><Link2 size={13} />{busy === `connect-${provider.key}` ? "Redirecting…" : connected.length ? "Add account" : provider.key === "gitlab" ? "Connect gitlab.com" : "Connect"}</button>
                    {provider.key === "gitlab" && isAdmin && !instance && <button className="mini-button ghost" onClick={() => setConfiguringGitlab(true)} disabled={busy !== null} title="Connect GitLab running on your own servers"><Server size={12} />Self-managed</button>}
                  </div>}
                  {instance && <div className="provider-actions">
                    <button className="secondary-button" onClick={() => connectProvider("gitlab", true)} disabled={!isAdmin || busy !== null}><Server size={13} />{busy === "connect-gitlab-self" ? "Redirecting…" : `Connect ${hostOf(instance)}`}</button>
                    {isAdmin && <>
                      <button className="mini-button ghost" aria-label={`Edit ${hostOf(instance)}`} title="Update instance OAuth app" onClick={() => setConfiguringGitlab(true)} disabled={busy !== null}><Pencil size={12} /></button>
                      <button className="mini-button danger ghost" aria-label={`Remove ${hostOf(instance)}`} title="Remove instance" onClick={() => removeGitlabInstance(instance)} disabled={busy !== null}><Trash2 size={12} /></button>
                    </>}
                  </div>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel span-full">
          <div className="panel-heading"><div><h2>{envProjectName}</h2></div><SearchableSelect
            value={envProjectId}
            onChange={setEnvProjectId}
            placeholder={selected ? selected.name : "Select project"}
            ariaLabel="Project whose environments to manage"
            options={(projects ?? []).filter((project) => project.id !== (selected?.id ?? "")).map((project) => ({ value: project.id, label: project.name, hint: project.defaultBranch }))}
          /></div>
          <p className="muted">Target URLs used by executions. The selected code revision must match the environment you run against.</p>
          {selected && <>
            <div className="environment-list">
              {environments.map((environment) => (
                <Fragment key={environment.id}>
                <div className="environment-row">
                  <Globe size={15} />
                  <div><strong>{environment.name}{environment.isDefault && <span className="chip tag">default</span>}</strong><small>{environment.url}</small>{environment.hasCredentials && <small className="env-auth"><Check size={10} />login credentials saved</small>}</div>
                  {!environment.isDefault && <button className="mini-button" onClick={() => act(`default-${environment.id}`, () => api(`/v1/projects/${envProjectId2}/environments/${environment.id}/default`, { method: "PATCH" }), "Default environment updated.")} disabled={!isAdmin || busy !== null}>Make default</button>}
                  <button className="mini-button danger" aria-label={`Delete ${environment.name}`} onClick={() => setPendingConfirm({
                    title: `Delete environment "${environment.name}"?`,
                    body: `${environment.url} will no longer be a run target for this project. Runs that already used it keep their recorded URL; future runs need another environment.`,
                    confirmLabel: "Delete environment",
                    action: () => act(`delete-${environment.id}`, () => api(`/v1/projects/${envProjectId2}/environments/${environment.id}`, { method: "DELETE" }), "Environment deleted.")
                  })} disabled={!isAdmin || busy !== null}><Trash2 size={13} /></button>
                </div>
                <details className="env-auth-config">
                  <summary>Parameter values for pages that need them{Object.keys(environment.routeFixtures ?? {}).length ? ` (${Object.keys(environment.routeFixtures ?? {}).length} route${Object.keys(environment.routeFixtures ?? {}).length === 1 ? "" : "s"})` : ""}</summary>
                  <div className="env-auth-grid">
                    <textarea
                      rows={6}
                      spellCheck={false}
                      value={fixtureDraft[environment.id] ?? JSON.stringify(environment.routeFixtures ?? {}, null, 2)}
                      onChange={(event) => setFixtureDraft({ ...fixtureDraft, [environment.id]: event.target.value })}
                      placeholder={'{\n  "/orders/:id": { "id": "1042" },\n  "/customizer": [\n    { "projectId": "193", "modelCode": "112" },\n    { "projectId": "193", "modelCode": "168" }\n  ]\n}'}
                    />
                    <small className="dim">Route → real parameter values that exist in this environment. Tests open the page with {'{{name}}'} placeholders filled from here. Give a route a list of value sets (one per product, model or account) to run its tests once per set; analysis and generation use the first set. Use {'{}'} for a route that needs no values. Analyze again after changing.</small>
                    <button className="secondary-button" disabled={!isAdmin || busy !== null || fixtureDraft[environment.id] === undefined} onClick={() => {
                      let parsed: unknown;
                      try { parsed = JSON.parse(fixtureDraft[environment.id] ?? "{}"); } catch { notify("Parameter values must be valid JSON", "error"); return; }
                      void act(`fixtures-${environment.id}`, () => api(`/v1/projects/${envProjectId2}/environments/${environment.id}`, { method: "PATCH", body: { routeFixtures: parsed } }), "Parameter values saved.")
                        .then(() => setFixtureDraft(({ [environment.id]: _saved, ...rest }) => rest));
                    }}>Save values</button>
                  </div>
                </details>
                </Fragment>
              ))}
              {environments.length === 0 && <p className="dim">No environments yet — add one so executions have a target.</p>}
            </div>
            <div className="environment-form">
              <input value={newEnvironment.name} onChange={(event) => setNewEnvironment({ ...newEnvironment, name: event.target.value })} placeholder="Name, e.g. Staging" />
              <input value={newEnvironment.url} onChange={(event) => setNewEnvironment({ ...newEnvironment, url: event.target.value })} placeholder="https://staging.example.com" />
              <button className="secondary-button" onClick={() => {
                const payload = {
                  ...newEnvironment,
                  ...(auth.loginUrl.trim() || auth.username.trim() || auth.password.trim() ? {
                    loginUrl: auth.loginUrl,
                    loginTrigger: auth.loginTrigger,
                    username: auth.username,
                    password: auth.password
                  } : {})
                };
                void act("add-env", () => api(`/v1/projects/${envProjectId2}/environments`, { method: "POST", body: payload }), "Environment added.");
                setNewEnvironment({ name: "", url: "" });
                setAuth({ loginUrl: "", loginTrigger: "", username: "", password: "" });
              }} disabled={!isAdmin || busy !== null || !newEnvironment.name.trim() || !newEnvironment.url.trim()}><Plus size={14} />Add environment</button>
            </div>
            {newEnvironment.name.trim() && newEnvironment.url.trim() && (
              <details className="env-auth-config">
                <summary>Optional: login credentials for authenticated testing</summary>
                <div className="env-auth-grid">
                  <label>Login URL (optional)<input value={auth.loginUrl} onChange={(event) => setAuth({ ...auth, loginUrl: event.target.value })} placeholder={newEnvironment.url} /><small className="field-hint">Leave empty if the app shows a login popup/modal on the site itself — the runner will trigger it automatically.</small></label>
                  <label>Username<input value={auth.username} onChange={(event) => setAuth({ ...auth, username: event.target.value })} autoComplete="off" placeholder="qa-bot@example.com" /></label>
                  <label>Password<input type="password" value={auth.password} onChange={(event) => setAuth({ ...auth, password: event.target.value })} autoComplete="new-password" placeholder="store encrypted" /></label>
                  <label>Login button (optional)<input value={auth.loginTrigger} onChange={(event) => setAuth({ ...auth, loginTrigger: event.target.value })} placeholder="Sign in" /><small className="field-hint">Text of the button that opens the login popup, when it is not "Log in" or "Sign in" (e.g. "Product Rack").</small></label>
                  <small className="dim">Stored encrypted. In test steps, reference them as {'{{username}}'} and {'{{password}}'} — the runner logs in once per run and reuses the session for every test.</small>
                </div>
              </details>
            )}
          </>}
        </section>

      </section>

      {configuringGitlab && <GitlabInstanceModal
        baseUrl={gitlabInstance?.baseUrl ?? null}
        clientId={gitlabInstance?.clientId ?? null}
        redirectUri={gitlabInstance?.redirectUri ?? `${apiUrl}/v1/repository-connections/gitlab/callback`}
        onClose={() => setConfiguringGitlab(false)}
        onSaved={() => { setConfiguringGitlab(false); connectProvider("gitlab", true); }}
      />}

      {pendingConfirm && <ConfirmDialog request={pendingConfirm} onClose={() => setPendingConfirm(null)} />}
    </>
  );
}
