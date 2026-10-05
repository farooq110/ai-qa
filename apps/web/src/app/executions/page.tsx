"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, Check, ChevronDown, CircleHelp, PlayCircle, RefreshCw, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, apiToken, apiUrl, fmtRelative, shortSha, statusClass, statusLabels } from "@/lib/api";
import { useProjects, useToast } from "@/lib/hooks";



interface PlanItem { testCaseId: string; status: string; errorMessage: string | null; durationMs: number | null; testCase: { id: string; title: string; capability: string | null; category: string | null } }
interface PlanSummary {
  id: string; status: string; trigger: string; branch: string; commitSha: string | null; environmentUrl: string;
  project?: { id: string; name: string; defaultBranch: string };
  createdAt: string; startedAt: string | null; completedAt: string | null;
  counts: { total: number; passed: number; failed: number; running: number; queued: number; blocked: number; skipped: number };
}
interface PlanDetail extends PlanSummary {
  items: PlanItem[];
  artifacts: Array<{ id: string; kind: string; testCaseId: string | null; url: string }>;
}
interface EnvironmentDto { id: string; name: string; url: string; isDefault: boolean }

function ArtifactViewer({ artifact, onClose }: { artifact: { kind: string; url: string }; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; objectUrl?: string; text?: string; error?: string; name: string }>({ loading: true, name: artifact.kind === "SCREENSHOT" ? "failure-screenshot.png" : "steps.json" });

  useEffect(() => {
    let cancelled = false;
    let createdObjectUrl: string | undefined;
    void (async () => {
      try {
        const response = await fetch(`${apiUrl}${artifact.url}`, { headers: { Authorization: `Bearer ${apiToken.get() ?? ""}` } });
        if (!response.ok) throw new Error("Artifact is unavailable");
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("image/")) {
          const blob = await response.blob();
          createdObjectUrl = URL.createObjectURL(blob);
          if (!cancelled) setState({ loading: false, objectUrl: createdObjectUrl, name: "failure-screenshot.png" });
        } else {
          const text = await response.text();
          if (!cancelled) setState({ loading: false, text, name: "steps.json" });
        }
      } catch (error) {
        if (!cancelled) setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Artifact is unavailable" }));
      }
    })();
    return () => { cancelled = true; if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl); };
  }, [artifact.url]);

  function download() {
    const href = state.objectUrl ?? URL.createObjectURL(new Blob([state.text ?? ""], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = state.name;
    link.click();
    if (!state.objectUrl) URL.revokeObjectURL(href);
  }

  return (
    <div className="modal-backdrop artifact-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal artifact-viewer" onClick={(event) => event.stopPropagation()}>
        <header className="artifact-head">
          <div>
            <p className="eyebrow">{artifact.kind === "SCREENSHOT" ? "FAILURE SCREENSHOT" : "STEP LOG"}</p>
            <h2>{state.name}</h2>
          </div>
          <div className="artifact-actions">
            <button className="secondary-button" onClick={download} disabled={state.loading || Boolean(state.error)}>Download</button>
            <button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
          </div>
        </header>
        <div className="artifact-body">
          {state.loading && <div className="artifact-loading">Loading artifact…</div>}
          {state.error && <div className="artifact-error">{state.error}</div>}
          {state.objectUrl && <img src={state.objectUrl} alt="Failure screenshot" />}
          {state.text && <pre className="artifact-pre">{(() => { try { return JSON.stringify(JSON.parse(state.text), null, 2); } catch { return state.text; } })()}</pre>}
        </div>
      </div>
    </div>
  );
}

export default function ExecutionsPage() {
  const { projects, selected } = useProjects();
  const { toast, notify } = useToast();
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentDto[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [artifactView, setArtifactView] = useState<{ kind: string; url: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const query = projectFilter ? `?projectId=${projectFilter}` : "";
      const plans = await api<PlanSummary[]>(`/v1/executions${query}`);
      setPlans(plans);
      const envProject = projectFilter || selected?.id;
      const environments = envProject ? await api<EnvironmentDto[]>(`/v1/projects/${envProject}/environments`) : [];
      setEnvironments(environments);
      setEnvironmentId((current) => environments.find((environment) => environment.id === current)?.id ? current : environments.find((environment) => environment.isDefault)?.id ?? environments[0]?.id ?? "");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load executions", "error");
    }
  }, [projectFilter, notify]);

  useEffect(() => { void reload(); const timer = window.setInterval(() => { void reload(); }, 5000); return () => window.clearInterval(timer); }, [reload]);

  async function act(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try { await fn(); notify(success, "success"); await reload(); if (detail) setDetail(await api<PlanDetail>(`/v1/projects/${detailProjectId(detail.id)}/executions/${detail.id}`)); }
    catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); }
    finally { setBusy(null); }
  }

  function runAll() {
    const project = projectFilter || selected?.id;
    if (!project) return;
    void act("runall", () => api(`/v1/projects/${project}/executions/run-all`, { method: "POST", body: environmentId ? { environmentId } : {} }), "Approved suite queued.");
  }

  function detailProjectId(planId: string) {
    return plans?.find((plan) => plan.id === planId)?.project?.id ?? (projectFilter || selected?.id);
  }

  const openDetail = async (planId: string) => {
    try {
      setDetail(await api<PlanDetail>(`/v1/projects/${detailProjectId(planId)}/executions/${planId}`));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load the run", "error");
    }
  };

  return (
    <AppShell activePath="/executions">
      <header className="page-header">
        <div>
          <p className="eyebrow">EXECUTION HISTORY</p>
          <h1>Executions</h1>
          <p className="muted">{selected ? `${selected.name} · immutable plans with per-test results and artifacts` : "Select a project to inspect its runs."}</p>
        </div>
        <div className="heading-actions">
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label="Project filter">
            <option value="">All projects</option>
            {(projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} aria-label="Environment">
            {environments.length === 0 && <option value="">No environments configured</option>}
            {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}{environment.isDefault ? " (default)" : ""}</option>)}
          </select>
          <button className="primary-button" onClick={runAll} disabled={!selected || busy !== null || plans?.length === undefined}><PlayCircle size={17} />Run all approved</button>
          <button className="icon-button" aria-label="Refresh" onClick={() => reload()}><RefreshCw size={16} /></button>
        </div>
      </header>

      {!plans ? <section className="loading-state">Loading executions…</section>
        : plans.length === 0 ? <section className="empty-state"><h2>No executions yet</h2><p>Runs you start from the Test Cases page or CI appear here across all projects.</p></section>
        : <section className="plans">
          {plans.map((plan) => {
            const pct = plan.counts.total ? Math.round(((plan.counts.passed + plan.counts.failed) / plan.counts.total) * 100) : 0;
            return (
              <article className="plan-card" key={plan.id}>
                <div className="plan-main">
                  <div className="plan-id"><span className={`status ${statusClass(plan.status)}`}>{statusLabels[plan.status] ?? plan.status}</span><strong>{fmtRelative(plan.createdAt)}</strong><small><span className="plan-project">{plan.project?.name ?? ""}</span> · {plan.trigger.toLowerCase()} · {plan.branch}{plan.commitSha ? <> · <code>{shortSha(plan.commitSha)}</code></> : null}</small></div>
                  <div className="plan-progress"><div className="progress"><span className={plan.counts.failed ? "has-failures" : ""} style={{ width: `${pct}%` }} /></div><small>{plan.counts.passed} passed · {plan.counts.failed} failed · {plan.counts.running + plan.counts.queued} pending of {plan.counts.total}</small></div>
                </div>
                <div className="plan-actions">
                  <button className="secondary-button" onClick={() => openDetail(plan.id)}>Details <ChevronDown size={14} /></button>
                  {(plan.status === "FAILED" || plan.counts.failed > 0) && <button className="secondary-button" onClick={() => act(`rerun-${plan.id}`, () => api(`/v1/projects/${detailProjectId(plan.id)}/executions/${plan.id}/rerun-failed`, { method: "POST" }), "Failed tests re-queued.")} disabled={busy !== null}><RefreshCw size={14} />Rerun failed</button>}
                  {(plan.status === "QUEUED" || plan.status === "RUNNING") && <button className="mini-button danger" onClick={() => act(`cancel-${plan.id}`, () => api(`/v1/projects/${detailProjectId(plan.id)}/executions/${plan.id}/cancel`, { method: "PATCH" }), "Execution canceled.")} disabled={busy !== null}><Ban size={13} />Cancel</button>}
                </div>
              </article>
            );
          })}
        </section>}

      {detail && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal wide">
            <header><div><p className="eyebrow">{statusLabels[detail.status]} · {detail.trigger}</p><h2>Run from {fmtRelative(detail.createdAt)}</h2></div><button className="icon-button" aria-label="Close" onClick={() => setDetail(null)}><X size={16} /></button></header>
            <div className="modal-body">
              <p className="muted"><code>{shortSha(detail.commitSha)}</code> · {detail.branch} · {detail.environmentUrl}</p>
              <div className="detail-items">
                {detail.items.map((item) => (
                  <div className={`detail-item ${statusClass(item.status)}`} key={item.testCaseId}>
                    <span className={`status ${statusClass(item.status)}`}>{statusLabels[item.status] ?? item.status}</span>
                    <div className="detail-item-copy">
                      <strong>{item.testCase.title}</strong>
                      {item.errorMessage && <small className="error-text">{item.errorMessage}</small>}
                      {item.durationMs != null && <small>{(item.durationMs / 1000).toFixed(1)}s</small>}
                    </div>
                    <span className="artifact-links">
                      {detail.artifacts.filter((artifact) => artifact.testCaseId === item.testCaseId).map((artifact) => (
                        <button key={artifact.id} className="artifact-link" title={`Open ${artifact.kind.toLowerCase()}`} onClick={() => setArtifactView({ kind: artifact.kind, url: artifact.url })}>{artifact.kind === "SCREENSHOT" ? "Screenshot" : "Log"}</button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <footer>
              {(detail.status === "FAILED" || detail.counts.failed > 0) && <button className="secondary-button" onClick={() => act("rerun-detail", () => api(`/v1/projects/${selected!.id}/executions/${detail.id}/rerun-failed`, { method: "POST" }), "Failed tests re-queued.")} disabled={busy !== null}><RefreshCw size={14} />Rerun failed</button>}
              <button className="primary-button" onClick={() => setDetail(null)}>Close</button>
            </footer>
          </div>
        </div>
      )}

      {artifactView && <ArtifactViewer artifact={artifactView} onClose={() => setArtifactView(null)} />}

      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </AppShell>
  );
}
