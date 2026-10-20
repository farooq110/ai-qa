"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, CircleHelp, ExternalLink, GitBranch, GitPullRequest, Plus, Save, ShieldCheck, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Select } from "@/components/select";
import { SearchableSelect } from "@/components/searchable-select";
import { api, fmtRelative, type RepositoryProviderName } from "@/lib/api";
import { can, requireSubscription, useMe, useProjects, useToast } from "@/lib/hooks";
import { PERMISSIONS } from "@ai-qa/domain";

interface BranchRule { pattern: string; environmentId?: string }
type TriggerMode = "DEPLOYMENT" | "PIPELINE";
/** The server only ever returns names; `value` exists while the user is typing a new or replacement secret. */
interface AccessHeader { name: string; value?: string }
interface SettingsDto { provider: RepositoryProviderName; imported: boolean; enabled: boolean; triggerMode: TriggerMode; workflowName: string; branchRules: BranchRule[]; pullRequests: boolean; environmentFilter: string; bypassHeaders: AccessHeader[]; webhookRegistered: boolean }
const MAX_HEADERS = 5;
const VERCEL_BYPASS = "x-vercel-protection-bypass";
interface RunDto { id: string; branch: string; commitSha: string; pullRequest: number | null; environmentName: string; environmentUrl: string; status: string; reason: string | null; createdAt: string; plan: { id: string; total: number; passed: number; failed: number } | null }
interface EnvironmentDto { id: string; name: string; url: string; isDefault?: boolean }

const modeOptions = [
  { value: "DEPLOYMENT", label: "The deployed URL", hint: "preview deploys: Vercel, Netlify, Render, or a deploy job with an environment url" },
  { value: "PIPELINE", label: "A saved environment", hint: "a fixed URL such as staging; runs after the pipeline succeeds" }
];

/** What has to happen on the customer's side for a run to start, per provider and trigger mode. */
function triggerHelp(provider: RepositoryProviderName, mode: TriggerMode) {
  if (provider === "BITBUCKET") return "Bitbucket does not report deployment URLs. When a matching branch's Pipelines build succeeds, Proofline tests the environment you map to it.";
  if (mode === "PIPELINE") return provider === "GITHUB"
    ? "When the workflow you pick succeeds on a matching branch, Proofline tests the environment mapped to that branch. Make the deploy the workflow's last job so the new version is live first."
    : "When a pipeline succeeds on a matching branch, Proofline tests the environment mapped to that branch. Make the deploy the pipeline's last job so the new version is live first.";
  return provider === "GITHUB"
    ? "Runs when GitHub reports a successful deployment of a matching branch: Vercel, Netlify, Render and Railway do this automatically. Deploying from GitHub Actions? Give the deploy job an environment with a url."
    : "Runs when GitLab records a successful deployment of a matching branch. In .gitlab-ci.yml, give the deploy job an environment with a url.";
}

export default function CiCdPage() {
  const me = useMe();
  const { projects, selected, setSelected } = useProjects();
  const { toast, notify } = useToast();
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [draft, setDraft] = useState<SettingsDto | null>(null);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentDto[]>([]);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [pattern, setPattern] = useState("");
  const [saving, setSaving] = useState(false);
  const canEdit = can(me, PERMISSIONS.CI_CD_EDIT);

  // Skipped-run links on GitHub/GitLab/Bitbucket point at /ci-cd?project=<id>: open that project.
  useEffect(() => {
    const projectId = new URLSearchParams(window.location.search).get("project");
    const linked = projectId && projects?.find((project) => project.id === projectId);
    if (!linked) return;
    setSelected(linked);
    window.history.replaceState({}, "", "/ci-cd");
  }, [projects, setSelected]);

  const reload = useCallback(async () => {
    if (!selected) return;
    try {
      const [loaded, loadedRuns] = await Promise.all([api<SettingsDto>(`/v1/projects/${selected.id}/ci`), api<RunDto[]>(`/v1/projects/${selected.id}/ci/runs`)]);
      setSettings(loaded);
      setDraft(loaded);
      setRuns(loadedRuns);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load CI settings", "error");
    }
  }, [selected, notify]);

  useEffect(() => { setSettings(null); setDraft(null); setRuns([]); void reload(); }, [reload]);

  // Branch picker options and (Bitbucket) environment targets.
  useEffect(() => {
    if (!selected?.repositoryConnectionId) { setBranches([]); return; }
    api<Array<{ name: string }>>(`/v1/repository-connections/${selected.repositoryConnectionId}/branches?repository=${encodeURIComponent(selected.repoFullName)}`)
      .then((rows) => setBranches(rows.map((row) => row.name)))
      .catch(() => setBranches([]));
    api<EnvironmentDto[]>(`/v1/projects/${selected.id}/environments`).then(setEnvironments).catch(() => setEnvironments([]));
    api<string[]>(`/v1/projects/${selected.id}/ci/workflows`).then(setWorkflows).catch(() => setWorkflows([]));
  }, [selected]);

  // Runs move on their own (queued → running → passed); keep the list fresh while one is in flight.
  useEffect(() => {
    if (!selected || !runs.some((run) => run.status === "QUEUED" || run.status === "RUNNING")) return;
    const timer = window.setInterval(() => { api<RunDto[]>(`/v1/projects/${selected.id}/ci/runs`).then(setRuns).catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [selected, runs]);

  const defaultEnvironmentId = (environments.find((environment) => environment.isDefault) ?? environments[0])?.id;

  function addRule(value: string) {
    const trimmed = value.trim();
    if (!draft || !trimmed || draft.branchRules.some((rule) => rule.pattern === trimmed)) return;
    const environmentId = draft.triggerMode === "PIPELINE" ? defaultEnvironmentId : undefined;
    setDraft({ ...draft, branchRules: [...draft.branchRules, { pattern: trimmed, ...(environmentId ? { environmentId } : {}) }] });
    setPattern("");
  }

  function updateHeader(index: number, patch: Partial<AccessHeader>) {
    if (!draft) return;
    setDraft({ ...draft, bypassHeaders: draft.bypassHeaders.map((header, position) => position === index ? { ...header, ...patch } : header) });
  }

  /** Every PIPELINE rule needs a target environment; pre-fill the default so switching modes is one click. */
  function changeMode(triggerMode: TriggerMode) {
    if (!draft) return;
    setDraft({
      ...draft, triggerMode,
      branchRules: triggerMode === "PIPELINE" ? draft.branchRules.map((rule) => rule.environmentId || !defaultEnvironmentId ? rule : { ...rule, environmentId: defaultEnvironmentId }) : draft.branchRules
    });
  }

  async function save() {
    if (!selected || !draft || requireSubscription(me)) return;
    setSaving(true);
    try {
      const saved = await api<SettingsDto>(`/v1/projects/${selected.id}/ci`, { method: "PUT", body: draft });
      setSettings(saved);
      setDraft(saved);
      notify(saved.enabled ? "CI is on. The next matching deployment runs your approved tests." : "CI settings saved.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to save CI settings", "error");
    } finally {
      setSaving(false);
    }
  }

  const dirty = JSON.stringify(settings) !== JSON.stringify(draft);
  const bitbucket = draft?.provider === "BITBUCKET";
  const pipelineMode = draft?.triggerMode === "PIPELINE";

  return (
    <AppShell activePath="/ci-cd">
      <header className="page-header">
        <div>
          <h1>CI on deploy</h1>
          <p className="muted">{selected ? `${selected.name} · ${selected.repoFullName}` : "Select a project to configure CI."}</p>
        </div>
        <div className="heading-actions">
          {(projects?.length ?? 0) > 1 && <SearchableSelect
            value=""
            onChange={(projectId) => { const next = projects?.find((project) => project.id === projectId); if (next) setSelected(next); }}
            placeholder={selected?.name ?? "Select project"}
            ariaLabel="Project"
            options={(projects ?? []).filter((project) => project.id !== selected?.id).map((project) => ({ value: project.id, label: project.name, hint: project.repoFullName }))}
          />}
          {canEdit && draft && <button className="primary-button" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} />{saving ? "Saving…" : "Save"}</button>}
        </div>
      </header>

      {!selected ? <section className="empty-state"><h2>No project selected</h2><p>Import a repository first.</p></section>
        : !draft ? <section className="panel"><span className="skel" style={{ height: 120 }} /></section>
        : !draft.imported ? <section className="empty-state"><h2>Re-import this repository</h2><p>{selected.name} was created from a pasted URL, so Proofline cannot receive its deployments. Delete it and import the repository from <Link className="text-link" href="/projects">Projects</Link>.</p></section>
        : <>
          <section className="panel ci-settings">
            <label className="ci-toggle">
              <input type="checkbox" checked={draft.enabled} disabled={!canEdit} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
              <div><strong>Run approved tests when a commit is deployed</strong><small>{triggerHelp(draft.provider, draft.triggerMode)}</small></div>
              {settings?.enabled && <span className={`status ${settings.webhookRegistered ? "approved" : "needs-review"}`}>{settings.webhookRegistered ? "listening" : "webhook missing"}</span>}
            </label>

            {!bitbucket && <div className="ci-field">
              <h3>Run tests against</h3>
              <Select value={draft.triggerMode} disabled={!canEdit} ariaLabel="Run tests against" onChange={(mode) => changeMode(mode as TriggerMode)} options={modeOptions} />
            </div>}

            {pipelineMode && draft.provider === "GITHUB" && <label className="ci-field">
              <h3>Deploy workflow</h3>
              <input value={draft.workflowName} disabled={!canEdit} list="ci-workflows" onChange={(event) => setDraft({ ...draft, workflowName: event.target.value })} placeholder="e.g. Deploy" maxLength={100} />
              <datalist id="ci-workflows">{workflows.map((name) => <option key={name} value={name} />)}</datalist>
              <small className="field-hint">The workflow whose success means the app is deployed. Several workflows run per push; only this one starts a test run.{workflows.length === 0 ? " Type its name exactly as it appears in the Actions tab." : ""}</small>
            </label>}

            <div className="ci-field">
              <h3><GitBranch size={13} />Branches</h3>
              <p className="dim">{pipelineMode ? "Each branch runs against the environment you pick for it." : "Deployments of these branches are tested. Use * as a wildcard, e.g. release/*."}</p>
              {pipelineMode && environments.length === 0 && <p className="form-error">Add an environment first: <Link className="text-link" href="/settings">Settings → environments</Link>.</p>}
              {draft.branchRules.length > 0 && <ul className="ci-rules">
                {draft.branchRules.map((rule) => <li key={rule.pattern}>
                  <code>{rule.pattern}</code>
                  {pipelineMode && <Select value={rule.environmentId ?? ""} disabled={!canEdit} ariaLabel={`Environment for ${rule.pattern}`} placeholder={environments.length ? "Pick environment" : "Add an environment in Settings"}
                    onChange={(environmentId) => setDraft({ ...draft, branchRules: draft.branchRules.map((candidate) => candidate.pattern === rule.pattern ? { ...candidate, environmentId } : candidate) })}
                    options={environments.map((environment) => ({ value: environment.id, label: environment.name, hint: environment.url }))} />}
                  {canEdit && <button className="mini-button ghost" aria-label={`Remove ${rule.pattern}`} onClick={() => setDraft({ ...draft, branchRules: draft.branchRules.filter((candidate) => candidate.pattern !== rule.pattern) })}><X size={12} /></button>}
                </li>)}
              </ul>}
              {canEdit && <div className="ci-add">
                <SearchableSelect value="" onChange={addRule} placeholder="Add a branch" ariaLabel="Add a branch" options={branches.filter((name) => !draft.branchRules.some((rule) => rule.pattern === name)).map((name) => ({ value: name, label: name }))} />
                <input value={pattern} onChange={(event) => setPattern(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addRule(pattern); }} placeholder="or a pattern, e.g. release/*" aria-label="Branch pattern" />
                <button className="secondary-button" disabled={!pattern.trim()} onClick={() => addRule(pattern)}><Plus size={13} />Add</button>
              </div>}
            </div>

            <div className="ci-field">
              <h3><ShieldCheck size={13} />Protected deployments <span className="optional-tag">optional</span></h3>
              <p className="dim">Previews behind a login wall (Vercel Deployment Protection, Cloudflare Access) answer tests with a 401. Add the access headers they accept. They are sent to the tested site only, never to other sites it loads from.</p>
              {draft.bypassHeaders.length > 0 && <ul className="ci-headers">
                {draft.bypassHeaders.map((header, index) => {
                  const saved = Boolean(settings?.bypassHeaders.some((candidate) => candidate.name.toLowerCase() === header.name.trim().toLowerCase()));
                  return <li key={index}>
                    <input value={header.name} disabled={!canEdit} onChange={(event) => updateHeader(index, { name: event.target.value })} placeholder="Header name" aria-label="Header name" maxLength={64} autoComplete="off" spellCheck={false} />
                    <input type="password" value={header.value ?? ""} disabled={!canEdit} onChange={(event) => updateHeader(index, { value: event.target.value })} placeholder={saved ? "Saved · leave blank to keep" : "Secret value"} aria-label={`Value for ${header.name || "header"}`} maxLength={512} autoComplete="new-password" />
                    {canEdit && <button className="mini-button ghost" aria-label={`Remove ${header.name || "header"}`} onClick={() => setDraft({ ...draft, bypassHeaders: draft.bypassHeaders.filter((_, position) => position !== index) })}><X size={12} /></button>}
                  </li>;
                })}
              </ul>}
              {canEdit && draft.bypassHeaders.length < MAX_HEADERS && <div className="ci-header-add">
                <button className="secondary-button" onClick={() => setDraft({ ...draft, bypassHeaders: [...draft.bypassHeaders, { name: "" }] })}><Plus size={13} />Add header</button>
                {!draft.bypassHeaders.some((header) => header.name.toLowerCase() === VERCEL_BYPASS) && <button className="mini-button ghost" onClick={() => setDraft({ ...draft, bypassHeaders: [...draft.bypassHeaders, { name: VERCEL_BYPASS }] })}>Vercel bypass</button>}
              </div>}
              <small className="field-hint">Secrets are stored encrypted and never shown again. Leave a saved value blank to keep it.</small>
            </div>

            {!pipelineMode && <>
              <label className="ci-toggle">
                <input type="checkbox" checked={draft.pullRequests} disabled={!canEdit} onChange={(event) => setDraft({ ...draft, pullRequests: event.target.checked })} />
                <div><strong><GitPullRequest size={13} />PR previews</strong><small>Also test preview deployments of any branch with an open {draft.provider === "GITLAB" ? "merge request" : "pull request"}. The result shows on the {draft.provider === "GITLAB" ? "MR" : "PR"}.</small></div>
              </label>
              <label className="ci-field">
                <h3>Deployment environment <span className="optional-tag">optional</span></h3>
                <input value={draft.environmentFilter} disabled={!canEdit} onChange={(event) => setDraft({ ...draft, environmentFilter: event.target.value })} placeholder="e.g. Preview – web" maxLength={100} />
                <small className="field-hint">Only for repositories that deploy several apps. Matches the provider&apos;s environment name; * is a wildcard. Empty tests every deployment of a matching branch.</small>
              </label>
            </>}
          </section>

          <section className="panel span-full ci-runs-panel">
            <div className="panel-heading"><div><h2>Recent runs</h2></div></div>
            {runs.length === 0 ? <p className="dim">No deployments received yet.</p> : (
              <div className="ci-requests ci-runs">
                <div className="ci-req-head"><span>When</span><span>Branch</span><span>Commit</span><span>Target</span><span>Result</span></div>
                {runs.map((run) => (
                  <div className="ci-req-row" key={run.id}>
                    <small>{fmtRelative(run.createdAt)}</small>
                    <code title={run.branch}>{run.pullRequest ? `#${run.pullRequest} · ` : ""}{run.branch}</code>
                    <code>{run.commitSha.slice(0, 7)}</code>
                    <small title={run.environmentName}>{run.environmentUrl ? <a className="text-link" href={run.environmentUrl} target="_blank" rel="noreferrer">{run.environmentUrl.replace(/^https?:\/\//, "")}<ExternalLink size={10} /></a> : "—"}</small>
                    <span className="ci-result">
                      <span className={`status ${run.status.toLowerCase()}`} title={run.reason ?? undefined}>{run.status.toLowerCase()}</span>
                      {run.plan ? <Link className="text-link" href={`/executions?plan=${run.plan.id}&project=${selected.id}`}>{run.plan.passed}/{run.plan.total}</Link> : run.reason && <small>{run.reason}</small>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>}

      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </AppShell>
  );
}
