"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Check, CircleHelp, Download, PlayCircle, RefreshCw, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Select } from "@/components/select";
import { SegBar } from "@/components/seg-bar";
import { useFitViewport } from "@/components/use-fit-viewport";
import { api, apiToken, apiUrl, fmtRelative, shortSha, statusClass, statusLabels } from "@/lib/api";
import { can, requireSubscription, useMe, useProjects, useToast } from "@/lib/hooks";
import { PERMISSIONS } from "@ai-qa/domain";



interface StepLogEntry { index: number; action: string; target: string; status: "PENDING" | "RUNNING" | "PASSED" | "FAILED"; durationMs?: number; error?: string; matchedBy?: string; loose?: boolean }
interface VariantResult { label: string; status: string; error?: string; durationMs: number }
interface PlanItem { testCaseId: string; status: string; errorMessage: string | null; durationMs: number | null; stepLog?: StepLogEntry[] | null; variants?: VariantResult[] | null; testCase: { id: string; title: string; capability: string | null; category: string | null } }
interface PlanSummary {
  id: string; status: string; trigger: string; branch: string; commitSha: string | null; environmentUrl: string;
  project?: { id: string; name: string; defaultBranch: string };
  createdAt: string; startedAt: string | null; completedAt: string | null;
  counts: { total: number; passed: number; failed: number; running: number; queued: number; blocked: number; skipped: number };
}
interface PlanDetail extends PlanSummary {
  items: PlanItem[];
  artifacts: Array<{ id: string; kind: string; testCaseId: string | null; name?: string; url: string }>;
}
interface EnvironmentDto { id: string; name: string; url: string; isDefault: boolean }

/** Live step-by-step progress of one test; fed by the worker's per-step writes. */
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\[\d+m/g, "");

function StepLog({ steps }: { steps: StepLogEntry[] }) {
  return (
    <ol className="run-steps">
      {steps.map((step) => (
        <li key={step.index} className={`run-step-row ${step.status.toLowerCase()}`}>
          <span className="run-step-mark" aria-hidden="true">
            {step.status === "PASSED" ? <Check size={12} /> : step.status === "FAILED" ? <X size={12} /> : step.status === "RUNNING" ? <span className="run-step-spin" /> : <span className="run-step-dot" />}
          </span>
          <span className="run-step-text">
            <span><b>{step.action}</b> {step.target}</span>
            {step.matchedBy && <small className={step.loose ? "loose" : undefined}>{step.loose ? "loose match · " : "found by "}{step.matchedBy}</small>}
            {step.error && <small className="error-text">{plain(step.error)}</small>}
          </span>
          <span className="run-step-time">{step.status === "RUNNING" ? "running…" : step.durationMs != null ? `${(step.durationMs / 1000).toFixed(1)}s` : ""}</span>
        </li>
      ))}
    </ol>
  );
}

/** The failure screenshot shown right under the failed test's steps: no modal round-trip to see what the page looked like. */
function InlineScreenshot({ url, onOpen }: { url: string; onOpen: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | undefined;
    let cancelled = false;
    fetch(`${apiUrl}${url}`, { headers: { Authorization: `Bearer ${apiToken.get() ?? ""}` } })
      .then((response) => (response.ok ? response.blob() : Promise.reject()))
      .then((blob) => { objectUrl = URL.createObjectURL(blob); if (!cancelled) setSrc(objectUrl); })
      .catch(() => undefined);
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);
  if (!src) return null;
  return <button type="button" className="inline-shot" title="Open full size" onClick={onOpen}><img src={src} alt="Page at the moment the test failed" /></button>;
}

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
            <h2 className="mono" style={{ fontSize: 13 }}>{state.name}</h2>
            <p className="meta">{artifact.kind === "SCREENSHOT" ? "failure screenshot" : "step log"}</p>
          </div>
          <div className="artifact-actions">
            <button className="secondary-button" onClick={download} disabled={state.loading || Boolean(state.error)}><Download size={14} />Download</button>
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
  const me = useMe();
  const canRun = can(me, PERMISSIONS.EXECUTIONS_RUN);
  const { projects, selected } = useProjects();
  const { toast, notify } = useToast();
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentDto[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [artifactView, setArtifactView] = useState<{ kind: string; url: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const inspectorRef = useRef<HTMLElement | null>(null);
  useFitViewport(inspectorRef);

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
  }, [projectFilter, selected?.id, notify]);

  useEffect(() => { void reload(); const timer = window.setInterval(() => { void reload(); }, 5000); return () => window.clearInterval(timer); }, [reload]);

  // The list polls every 5s, but the open run needs step-level progress: refresh it every 2s while it is live.
  const liveDetailId = detail && ["QUEUED", "RUNNING"].includes(detail.status) ? detail.id : null;
  useEffect(() => {
    if (!liveDetailId) return;
    const timer = window.setInterval(() => {
      const projectId = plans?.find((plan) => plan.id === liveDetailId)?.project?.id ?? selected?.id;
      if (!projectId) return;
      api<PlanDetail>(`/v1/projects/${projectId}/executions/${liveDetailId}`)
        .then((next) => setDetail((current) => (current?.id === next.id ? next : current)))
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [liveDetailId, plans, selected?.id]);

  async function act(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try { await fn(); notify(success, "success"); await reload(); if (detail) setDetail(await api<PlanDetail>(`/v1/projects/${detailProjectId(detail.id)}/executions/${detail.id}`)); }
    catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); }
    finally { setBusy(null); }
  }

  function runAll() {
    const project = projectFilter || selected?.id;
    if (!project || requireSubscription(me)) return;
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

  // Deep link from a GitHub check / commit status or the CI page: /executions?plan=<id>&project=<id>.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const planId = params.get("plan");
    const projectId = params.get("project");
    if (!planId || !projectId) return;
    api<PlanDetail>(`/v1/projects/${projectId}/executions/${planId}`).then(setDetail).catch(() => notify("That run is not available in this organization", "error"));
    window.history.replaceState({}, "", "/executions");
  }, [notify]);

  const tally = (statuses: string[]) => plans?.filter((plan) => statuses.includes(plan.status)).length ?? 0;
  const filterGroups: Record<string, string[]> = { PASSED: ["PASSED", "COMPLETED"], CANCELED: ["CANCELED", "BLOCKED"] };
  const visiblePlans = (plans ?? []).filter((plan) => !statusFilter || (filterGroups[statusFilter] ?? [statusFilter]).includes(plan.status));

  return (
    <AppShell activePath="/executions">
      <header className="page-header">
        <div>
          <h1>Executions</h1>
          <p className="muted">{selected ? `${selected.name} · immutable plans with per-test results and artifacts` : "Select a project to inspect its runs."}</p>
        </div>
        <div className="heading-actions">
          <Select className="w-wide" value={projectFilter} onChange={setProjectFilter} ariaLabel="Project filter" options={[{ value: "", label: "All projects" }, ...(projects ?? []).map((project) => ({ value: project.id, label: project.name }))]} />
          <Select className="w-wide" value={environmentId} onChange={setEnvironmentId} ariaLabel="Environment" placeholder="No environments configured" disabled={environments.length === 0} options={environments.map((environment) => ({ value: environment.id, label: environment.name, hint: environment.isDefault ? "default" : undefined }))} />
          <button className="icon-button" style={{ width: 32, height: 32 }} aria-label="Refresh" title="Refresh (auto every 5s)" onClick={() => reload()}><RefreshCw size={14} /></button>
          {canRun && <button className="run-button" onClick={runAll} disabled={!selected || busy !== null || plans?.length === undefined}><PlayCircle size={14} />Run all approved</button>}
        </div>
      </header>

      {plans && plans.length > 0 && (
        <nav className="lifecycle-tabs" aria-label="Filter runs by status">
          {([["", "All runs", "", plans.length], ["RUNNING", "Running", "running", tally(["RUNNING"])], ["QUEUED", "Queued", "pending-review", tally(["QUEUED"])], ["FAILED", "Failed", "rejected", tally(["FAILED"])], ["PASSED", "Passed", "approved", tally(["PASSED", "COMPLETED"])], ["CANCELED", "Canceled", "archived", tally(["CANCELED", "BLOCKED"])]] as const).map(([key, label, tone, count]) => (
            <button type="button" key={label} aria-pressed={statusFilter === key} onClick={() => setStatusFilter(statusFilter === key ? "" : key)}><span><i className={tone ? `t-${tone}` : undefined} />{label}</span><strong>{count}</strong></button>
          ))}
        </nav>
      )}

      {!plans ? <section className="plans" aria-busy="true" aria-label="Loading executions">{Array.from({ length: 6 }, (_, i) => <div className="plan-card" key={i} style={{ cursor: "default" }}><span className="skel" style={{ width: 70, height: 18, borderRadius: 999 }} /><span style={{ display: "grid", gap: 6 }}><span className="skel" style={{ width: "60%", height: 11 }} /><span className="skel" style={{ width: "40%", height: 9 }} /></span><span className="skel" style={{ width: "70%", height: 10 }} /><span className="skel" style={{ width: "90%", height: 6 }} /><span /></div>)}</section>
        : plans.length === 0 ? <section className="empty-state"><h2>No executions yet</h2><p>Runs started from the test library, the overview, or a CI push appear here across all projects, each pinned to the commit it ran against.</p></section>
        : <div className={detail ? "library-frame inspecting" : "library-frame"}>
          <section className="plans">
            <div className="plans-head"><span>status</span><span>run</span><span>ref</span><span>results</span><span /></div>
            {visiblePlans.length === 0 && <div className="empty-inline">No runs with this status.</div>}
            {visiblePlans.map((plan) => {
              const pending = plan.counts.running + plan.counts.queued;
              return (
                <article className={`plan-card${detail?.id === plan.id ? " selected" : ""}`} key={plan.id} onClick={() => openDetail(plan.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") void openDetail(plan.id); }} aria-label={`Run ${fmtRelative(plan.createdAt)}, ${statusLabels[plan.status] ?? plan.status}`}>
                  <span className={`status ${statusClass(plan.status)}`}>{statusLabels[plan.status] ?? plan.status}</span>
                  <div className="plan-id"><strong>{plan.project?.name ?? "Run"}</strong><small>{plan.trigger.toLowerCase()} · {fmtRelative(plan.createdAt)}</small></div>
                  <div className="plan-ref"><b>{plan.branch}</b><span>{plan.commitSha ? `@ ${shortSha(plan.commitSha)}` : "no commit"}</span></div>
                  <div className="plan-progress"><SegBar passed={plan.counts.passed} failed={plan.counts.failed} running={pending} total={plan.counts.total} /><small>{plan.counts.passed} passed · {plan.counts.failed} failed{pending ? ` · ${pending} pending` : ""} / {plan.counts.total}</small></div>
                  <div className="plan-actions" onClick={(event) => event.stopPropagation()}>
                    {canRun && (plan.status === "FAILED" || plan.counts.failed > 0) && <button className="mini-button" onClick={() => act(`rerun-${plan.id}`, () => api(`/v1/projects/${detailProjectId(plan.id)}/executions/${plan.id}/rerun-failed`, { method: "POST" }), "Failed tests re-queued.")} disabled={busy !== null}><RefreshCw size={12} />Rerun failed</button>}
                    {canRun && (plan.status === "QUEUED" || plan.status === "RUNNING") && <button className="mini-button danger" onClick={() => act(`cancel-${plan.id}`, () => api(`/v1/projects/${detailProjectId(plan.id)}/executions/${plan.id}/cancel`, { method: "PATCH" }), "Execution canceled.")} disabled={busy !== null}><Ban size={12} />Cancel</button>}
                  </div>
                </article>
              );
            })}
          </section>

          {detail && (
            <aside className="inspector" aria-label="Run details" ref={inspectorRef}>
              <header className="inspector-head">
                <div className="inspector-top">
                  <span className={`status ${statusClass(detail.status)}`}>{statusLabels[detail.status] ?? detail.status}</span>
                  <span className="meta">{detail.trigger.toLowerCase()}</span>
                  <button className="icon-button" aria-label="Close run details" onClick={() => setDetail(null)}><X size={14} /></button>
                </div>
                <h2>Run from {fmtRelative(detail.createdAt)}</h2>
                <p className="meta"><strong>{detail.branch}</strong>@ {shortSha(detail.commitSha)}<span className="dot">·</span>{detail.environmentUrl}</p>
                <SegBar passed={detail.counts.passed} failed={detail.counts.failed} running={detail.counts.running + detail.counts.queued} total={detail.counts.total} />
              </header>
              <div className="inspector-body">
                <div className="detail-items">
                  {detail.items.length === 0 && <div className="empty-inline">This plan has no test items.</div>}
                  {detail.items.map((item) => (
                    <div className={`detail-item ${statusClass(item.status)}`} key={item.testCaseId}>
                      <span className={`status ${statusClass(item.status)}`}>{statusLabels[item.status] ?? item.status}</span>
                      <div className="detail-item-copy">
                        <strong>{item.testCase.title}</strong>
                        {item.errorMessage && <small className="error-text">{plain(item.errorMessage)}</small>}
                        {item.durationMs != null && <small>{(item.durationMs / 1000).toFixed(1)}s</small>}
                        {item.status === "RUNNING" && item.stepLog?.length ? <small>step {Math.min(item.stepLog.filter((step) => step.status === "PASSED").length + 1, item.stepLog.length)} of {item.stepLog.length}</small> : null}
                      </div>
                      <span className="artifact-links">
                        {item.stepLog?.length ? (() => {
                          const open = openSteps[item.testCaseId] ?? (item.status === "RUNNING" || item.status === "FAILED");
                          return <button className="artifact-link" aria-expanded={open} onClick={() => setOpenSteps({ ...openSteps, [item.testCaseId]: !open })}>{open ? "hide steps" : `${item.stepLog.length} steps`}</button>;
                        })() : null}
                        {detail.artifacts.filter((artifact) => artifact.testCaseId === item.testCaseId).map((artifact) => (
                          <button key={artifact.id} className="artifact-link" title={`Open ${artifact.kind.toLowerCase()}`} onClick={() => setArtifactView({ kind: artifact.kind, url: artifact.url })}>{artifact.kind === "SCREENSHOT" ? "screenshot" : "log"}</button>
                        ))}
                      </span>
                      {item.stepLog?.length && (openSteps[item.testCaseId] ?? (item.status === "RUNNING" || item.status === "FAILED")) ? <StepLog steps={item.stepLog} /> : null}
                      {item.variants?.length ? <ol className="run-variants" aria-label="Results per parameter set">
                        {item.variants.map((variant, index) => {
                          const shot = detail.artifacts.find((artifact) => artifact.testCaseId === item.testCaseId && artifact.kind === "SCREENSHOT" && artifact.name?.includes(`-set${index + 1}-failure`));
                          return <li key={variant.label} className={`run-variant ${variant.status.toLowerCase()}`}>
                            <span className="run-step-mark" aria-hidden="true">{variant.status === "PASSED" ? <Check size={12} /> : <X size={12} />}</span>
                            <span className="run-step-text"><span className="mono">{variant.label}</span>{variant.error && <small className="error-text">{plain(variant.error)}</small>}</span>
                            <span className="run-step-time">{(variant.durationMs / 1000).toFixed(1)}s</span>
                            {shot && <InlineScreenshot url={shot.url} onOpen={() => setArtifactView({ kind: shot.kind, url: shot.url })} />}
                          </li>;
                        })}
                      </ol> : item.status === "FAILED" && (() => {
                        const shot = detail.artifacts.find((artifact) => artifact.testCaseId === item.testCaseId && artifact.kind === "SCREENSHOT");
                        return shot ? <InlineScreenshot url={shot.url} onOpen={() => setArtifactView({ kind: shot.kind, url: shot.url })} /> : null;
                      })()}
                    </div>
                  ))}
                </div>
              </div>
              {canRun && (detail.status === "FAILED" || detail.counts.failed > 0) && <footer className="inspector-foot">
                <button className="secondary-button" onClick={() => act("rerun-detail", () => api(`/v1/projects/${detailProjectId(detail.id)}/executions/${detail.id}/rerun-failed`, { method: "POST" }), "Failed tests re-queued.")} disabled={busy !== null}><RefreshCw size={13} />Rerun failed</button>
              </footer>}
            </aside>
          )}
        </div>}

      {artifactView && <ArtifactViewer artifact={artifactView} onClose={() => setArtifactView(null)} />}

      {toast && <div className={`toast ${toast.tone}`} role="status">{toast.tone === "success" ? <Check size={16} /> : toast.tone === "error" ? <X size={16} /> : <CircleHelp size={16} />}{toast.message}</div>}
    </AppShell>
  );
}
