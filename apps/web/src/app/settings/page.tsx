"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CircleHelp, GitBranch, Globe, Link2, Plus, Trash2, Unplug, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ConfirmDialog, type ConfirmRequest } from "@/components/confirm-dialog";
import { SearchableSelect } from "@/components/searchable-select";
import { api, apiUrl, fmtDate, statusLabels } from "@/lib/api";
import { useMe, useProjects, useToast } from "@/lib/hooks";

interface BillingSummary {
  subscription: { status: string; currentPeriodEnd: string | null; stripeCustomerId: string; hasStripeSubscription: boolean } | null;
  plan: { key: string; name: string; monthlyPriceUsd: number; tokenQuotaMonthly: number; warningThresholdPct: number; executionSlotLimit: number; retentionDays: number } | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  remainingTokens: number;
  tokenQuotaMonthly: number;
  executionSlotLimit: number;
  availablePlans: Array<{ key: string; name: string; monthlyPriceUsd: number; tokenQuotaMonthly: number; executionSlotLimit: number }>;
}
interface EnvironmentDto { id: string; name: string; url: string; isDefault: boolean; hasCredentials?: boolean; loginUrl?: string | null }
interface ConnectionDto { id: string; provider: string; accountLogin: string; createdAt: string; updatedAt: string }

const repositoryProviders = [
  { key: "github", label: "GitHub", hint: "Connect a GitHub account to analyze repositories and run repository analysis." },
  { key: "bitbucket", label: "Bitbucket", hint: "Connect a Bitbucket workspace account with read access to your repositories." },
  { key: "gitlab", label: "GitLab", hint: "Connect a GitLab account with read_api access to your projects." }
] as const;

export default function SettingsPage() {
  const me = useMe();
  const { projects, selected } = useProjects();
  const { toast, notify } = useToast();
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentDto[]>([]);
  const [newEnvironment, setNewEnvironment] = useState<{ name: string; url: string }>({ name: "", url: "" });
  const [showAuth, setShowAuth] = useState(false);
  const [auth, setAuth] = useState<{ loginUrl: string; username: string; password: string }>({ loginUrl: "", username: "", password: "" });
  const [connections, setConnections] = useState<ConnectionDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [envProjectId, setEnvProjectId] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(null);

  const isAdmin = me?.role === "ADMIN";

  const reload = useCallback(async () => {
    try {
      setBilling(await api<BillingSummary>("/v1/billing/summary"));
      const envProject = envProjectId || selected?.id;
      if (envProject) setEnvironments(await api<EnvironmentDto[]>(`/v1/projects/${envProject}/environments`));
      setConnections(await api<ConnectionDto[]>("/v1/repository-connections"));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load settings", "error");
    }
  }, [selected, envProjectId, notify]);

  useEffect(() => { void reload(); }, [reload]);

  // Return trip from an OAuth callback: /settings?connected=github | connected=error&provider=x
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (!connected) return;
    const provider = params.get("provider");
    const label = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "account";
    if (connected === "error") {
      notify(`${label} connection was not completed. GitHub may have denied access or the attempt expired — try Connect ${label} again.`, "error");
    } else {
      notify(`${connected.charAt(0).toUpperCase()}${connected.slice(1)} account connected. You can now analyze its repositories.`, "success");
    }
    window.history.replaceState({}, "", "/settings");
  }, [notify]);

  function connectProvider(provider: string) {
    void (async () => {
      setBusy(`connect-${provider}`);
      try {
        const result = await api<{ url: string }>(`/v1/repository-connections/${provider}/authorize`);
        window.location.assign(result.url);
      } catch (error) {
        notify(error instanceof Error ? error.message : "Unable to start the connection", "error");
        setBusy(null);
      }
    })();
  }

  function disconnectProvider(connection: ConnectionDto) {
    const providerLabel = connection.provider.charAt(0) + connection.provider.slice(1).toLowerCase();
    setPendingConfirm({
      title: `Disconnect ${providerLabel}?`,
      body: `${connection.accountLogin} will be removed from this organization. Analysis and generation using this account stop working until you reconnect — your projects, tests, and run history are not affected.`,
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
  const usagePct = billing && billing.tokenQuotaMonthly > 0 ? Math.min(100, Math.round((billing.usage.totalTokens / billing.tokenQuotaMonthly) * 100)) : 0;

  return (
    <AppShell activePath="/settings">
      <header className="page-header">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>Organization settings</h1>
          <p className="muted">{me?.organization?.name ?? ""}{me?.organization?.industry ? ` · ${me.organization.industry}` : ""}</p>
        </div>
      </header>

      <section className="settings-grid">
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">ORGANIZATION</p><h2>Profile</h2></div></div>
          <dl className="detail-grid stacked">
            <div><dt>Name</dt><dd>{me?.organization?.name ?? "—"}</dd></div>
            <div><dt>Industry</dt><dd>{me?.organization?.industry ?? "—"}</dd></div>
            <div><dt>Your role</dt><dd>{me?.role ?? "—"}</dd></div>
            <div><dt>Organization id</dt><dd><code>{me?.organization?.id ?? "—"}</code></dd></div>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">BILLING</p><h2>{billing?.plan?.name ?? "Plan"} plan</h2></div>
            {billing?.subscription && <span className={`status ${billing.subscription.status === "ACTIVE" || billing.subscription.status === "TRIALING" ? "approved" : "needs-review"}`}>{statusLabels[billing.subscription.status] ?? billing.subscription.status}</span>}
          </div>
          {billing && (
            <>
              <div className="usage-meter">
                <div className="usage-row"><span>AI tokens this month</span><strong>{billing.usage.totalTokens.toLocaleString()} / {billing.tokenQuotaMonthly.toLocaleString()}</strong></div>
                <div className="progress"><span className={usagePct >= (billing.plan?.warningThresholdPct ?? 80) ? "has-failures" : ""} style={{ width: `${usagePct}%` }} /></div>
                <small>{billing.remainingTokens.toLocaleString()} remaining · renews {billing.subscription?.currentPeriodEnd ? new Date(billing.subscription.currentPeriodEnd).toLocaleDateString() : "—"} · {billing.executionSlotLimit} concurrent execution slots</small>
              </div>
              <h3 className="modal-subhead">Available plans</h3>
              <div className="plan-list">
                {billing.availablePlans.map((plan) => (
                  <div className={`plan-option ${billing.plan?.key === plan.key ? "current" : ""}`} key={plan.key}>
                    <div><strong>{plan.name}</strong><small>{plan.tokenQuotaMonthly.toLocaleString()} tokens · {plan.executionSlotLimit} slots · ${plan.monthlyPriceUsd}/mo</small></div>
                    {billing.plan?.key === plan.key ? <span className="chip tag">Current</span> : <small className="dim">Contact sales to change</small>}
                  </div>
                ))}
              </div>
              <p className="dim">Stripe manages payment collection. When a payment fails the organization enters Past due, then Billing locked after the due date — blocking generation and execution.</p>
            </>
          )}
        </section>

        <section className="panel span-full">
          <div className="panel-heading"><div><p className="eyebrow">CONNECTED ACCOUNTS</p><h2>Repository providers</h2></div></div>
          <p className="muted">Connect the GitHub, Bitbucket, or GitLab accounts your repositories live on. Tokens are stored encrypted and are only used server-side. Analysis and generation currently speak the GitHub API; Bitbucket and GitLab connections manage repository browsing.</p>
          <div className="connections-grid">
            {repositoryProviders.map((provider) => {
              const connected = connections?.filter((connection) => connection.provider === provider.key.toUpperCase()) ?? [];
              return (
                <div className="connection-card" key={provider.key}>
                  <div className="connection-head"><GitBranch size={16} /><strong>{provider.label}</strong></div>
                  <p className="hint">{provider.hint}</p>
                  {connections === null ? <small className="dim">Loading…</small>
                    : connected.length === 0 ? (
                      <button className="secondary-button" onClick={() => connectProvider(provider.key)} disabled={!isAdmin || busy !== null}><Link2 size={14} />{busy === `connect-${provider.key}` ? "Redirecting…" : `Connect ${provider.label}`}</button>
                    ) : connected.map((connection) => (
                      <div className="connection-row" key={connection.id}>
                        <span className="avatar">{connection.accountLogin.slice(0, 2).toUpperCase()}</span>
                        <div className="connection-copy"><strong>{connection.accountLogin}</strong><small>connected {fmtDate(connection.createdAt)}</small></div>
                        <button className="mini-button danger" title="Disconnect account" onClick={() => disconnectProvider(connection)} disabled={!isAdmin || busy !== null}><Unplug size={13} />Disconnect</button>
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel span-full">
          <div className="panel-heading"><div><p className="eyebrow">ENVIRONMENTS</p><h2>{envProjectName}</h2></div><SearchableSelect
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
                <div className="environment-row" key={environment.id}>
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
                    username: auth.username,
                    password: auth.password
                  } : {})
                };
                void act("add-env", () => api(`/v1/projects/${envProjectId2}/environments`, { method: "POST", body: payload }), "Environment added.");
                setNewEnvironment({ name: "", url: "" });
                setAuth({ loginUrl: "", username: "", password: "" });
              }} disabled={!isAdmin || busy !== null || !newEnvironment.name.trim() || !newEnvironment.url.trim()}><Plus size={14} />Add environment</button>
            </div>
            {newEnvironment.name.trim() && newEnvironment.url.trim() && (
              <details className="env-auth-config">
                <summary>Optional: login credentials for authenticated testing</summary>
                <div className="env-auth-grid">
                  <label>Login URL <span className="optional-tag">optional</span><input value={auth.loginUrl} onChange={(event) => setAuth({ ...auth, loginUrl: event.target.value })} placeholder={newEnvironment.url} /><small className="field-hint">Leave empty if the app shows a login popup/modal on the site itself — the runner will trigger it automatically.</small></label>
                  <label>Username<input value={auth.username} onChange={(event) => setAuth({ ...auth, username: event.target.value })} autoComplete="off" placeholder="qa-bot@example.com" /></label>
                  <label>Password<input type="password" value={auth.password} onChange={(event) => setAuth({ ...auth, password: event.target.value })} autoComplete="new-password" placeholder="store encrypted" /></label>
                  <small className="dim">Stored encrypted. In test steps, reference them as {'{{username}}'} and {'{{password}}'} — the runner logs in once per run and reuses the session for every test.</small>
                </div>
              </details>
            )}
          </>}
        </section>

        <section className="panel span-full">
          <div className="panel-heading"><div><p className="eyebrow">SECURITY</p><h2>Session</h2></div></div>
          <p className="muted">Signed in as <strong>{me?.email ?? "…"}</strong>. Access tokens expire after 8 hours; sign out to end this session.</p>
        </section>
      </section>

      {pendingConfirm && <ConfirmDialog request={pendingConfirm} onClose={() => setPendingConfirm(null)} />}

      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </AppShell>
  );
}
