"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, Check, ChevronDown, ChevronRight, CircleHelp, GitBranch, Loader2, PlayCircle, Plus, RotateCw, SearchCode, X } from "lucide-react";
import { analysisOutcome, api, categoryLabels, fmtDate, fmtRelative, shortSha, statusLabels, waitForGeneration, type AnalysisRunDto } from "@/lib/api";
import { AppShell } from "@/components/app-shell";
import { RunQueued } from "@/components/run-queued";
import { SegBar } from "@/components/seg-bar";
import { RunEnvironmentModal } from "@/components/run-environment-modal";
import { can, requireSubscription, useElapsed, useMe, useProjects, useToast } from "@/lib/hooks";
import { PERMISSIONS } from "@ai-qa/domain";

interface GenerationRunLite { id: string; status: string; created: number | null; errorMessage: string | null; createdAt: string }
const GENERATION_STALE_MS = 15 * 60 * 1000;
const isRunning = (status?: string) => status === "RUNNING" || status === "QUEUED";

interface Overview {
  project: { id: string; name: string; repositoryUrl: string; defaultBranch: string };
  analysis: { id: string; branch: string; commitSha: string; completedAt: string } | null;
  generation: { id: string; mode: string; status: string; createdAt: string; created: number | null } | null;
  tests: { total: number; approved: number; pendingReview: number; needsReview: number; rejected: number; archived: number };
  lastExecution: { id: string; status: string; trigger: string; branch: string; commitSha: string | null; total: number; passed: number; createdAt: string } | null;
  executions: Array<{ id: string; status: string; trigger: string; branch: string; total: number; passed: number; failed: number; createdAt: string }>;
  billing: { planName: string; status: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; tokenQuotaMonthly: number; remainingTokens: number; warningThresholdPct: number; executionSlotLimit: number; billingLocked: boolean; currentPeriodEnd: string | null };
}

export default function DashboardPage() {
  const me = useMe();
  const canGenerate = can(me, PERMISSIONS.TEST_CASES_CREATE), canRun = can(me, PERMISSIONS.EXECUTIONS_RUN);
  const { projects, selected, setSelected } = useProjects();
  const { toast, notify, dismiss } = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewNonce, setOverviewNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [analysisRun, setAnalysisRun] = useState<AnalysisRunDto | null>(null);
  const [generationRun, setGenerationRun] = useState<GenerationRunLite | null>(null);
  const prevStatus = useRef<{ analysis?: string; generation?: string }>({});
  const [queued, setQueued] = useState<number | null>(null);
  const [regenerationOpen, setRegenerationOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [environments, setEnvironments] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [queue, setQueue] = useState<QueueTest[] | null>(null);

  useEffect(() => {
    setOverviewError(null);
    if (!selected) { setOverview(null); return; }
    let cancelled = false;
    // A failed overview load must end in the error state, not the skeleton — otherwise the
    // page spins forever. The nonce lets the Retry button re-run this effect.
    api<Overview>(`/v1/projects/${selected.id}/overview`).then((data) => { if (!cancelled) { setOverview(data); setOverviewError(null); } }).catch((error) => { if (!cancelled) setOverviewError(error instanceof Error ? error.message : "Unable to load overview"); notify(error instanceof Error ? error.message : "Unable to load overview", "error"); });
    api<Array<{ id: string; name: string; isDefault: boolean }>>(`/v1/projects/${selected.id}/environments`).then((envs) => { if (!cancelled) setEnvironments(envs); }).catch(() => undefined);
    setQueue(null);
    api<QueueTest[]>(`/v1/test-cases?projectId=${selected.id}`).then((rows) => { if (!cancelled) setQueue(rows.filter((row) => row.status === "PENDING_REVIEW" || row.status === "NEEDS_REVIEW").sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority])); }).catch(() => { if (!cancelled) setQueue([]); });
    return () => { cancelled = true; };
  }, [selected, notify, overviewNonce]);

  // Analysis and generation run in the background: status comes from the server so it survives a reload
  // or navigating away, and a finished run reports itself once, here, whoever started it.
  const projectId = selected?.id;
  const defaultBranch = selected?.defaultBranch;
  const projectName = selected?.name ?? "Project";
  const refreshRuns = useCallback(async () => {
    if (!projectId) return;
    const [analyses, generations] = await Promise.all([
      api<AnalysisRunDto[]>(`/v1/projects/${projectId}/analysis`).catch(() => null),
      api<GenerationRunLite[]>(`/v1/projects/${projectId}/generations`).catch(() => null)
    ]);
    const latestAnalysis = analyses?.find((run) => run.branch === defaultBranch) ?? null;
    const latestGeneration = generations?.[0] ?? null;
    let finished = false;
    if (latestAnalysis && isRunning(prevStatus.current.analysis)) {
      if (latestAnalysis.status === "COMPLETED") { notify(analysisOutcome(projectName, latestAnalysis), "success"); finished = true; }
      else if (latestAnalysis.status === "FAILED") { notify(`${projectName}: analysis failed — ${latestAnalysis.errorMessage ?? "ensure the repository provider is connected in Settings"}.`, "error"); finished = true; }
    }
    if (latestGeneration && isRunning(prevStatus.current.generation)) {
      if (latestGeneration.status === "COMPLETED") { notify(`${projectName}: ${latestGeneration.created ?? 0} test cases generated — review them below.`, "success"); finished = true; }
      else if (latestGeneration.status === "FAILED") { notify(`${projectName}: generation failed — ${latestGeneration.errorMessage ?? "unknown error"}.`, "error"); finished = true; }
    }
    prevStatus.current = { analysis: latestAnalysis?.status, generation: latestGeneration?.status };
    setAnalysisRun(latestAnalysis);
    setGenerationRun(latestGeneration);
    if (finished) {
      api<Overview>(`/v1/projects/${projectId}/overview`).then(setOverview).catch(() => undefined);
      api<QueueTest[]>(`/v1/test-cases?projectId=${projectId}`).then((rows) => setQueue(rows.filter((row) => row.status === "PENDING_REVIEW" || row.status === "NEEDS_REVIEW").sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]))).catch(() => undefined);
    }
  }, [projectId, defaultBranch, projectName, notify]);

  const analysisLive = isRunning(analysisRun?.status);
  const generationLive = generationRun?.status === "RUNNING" && Date.now() - new Date(generationRun.createdAt).getTime() < GENERATION_STALE_MS;
  useEffect(() => {
    prevStatus.current = {};
    setAnalysisRun(null);
    setGenerationRun(null);
    void refreshRuns();
  }, [refreshRuns]);
  useEffect(() => {
    if (!analysisLive && !generationLive) return;
    const timer = window.setInterval(() => { void refreshRuns(); }, 4000);
    return () => window.clearInterval(timer);
  }, [analysisLive, generationLive, refreshRuns]);
  const analysisElapsed = useElapsed(analysisRun?.createdAt ? new Date(analysisRun.createdAt).getTime() : null, analysisLive);
  const generationElapsed = useElapsed(generationRun ? new Date(generationRun.createdAt).getTime() : null, generationLive);
  const analyzing = busy === "analyze" || analysisLive;
  const generating = busy === "generate" || generationLive;

  async function runAction(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      await fn();
      notify(success, "success");
      const refreshed = await api<Overview>(`/v1/projects/${selected!.id}/overview`);
      setOverview(refreshed);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "The action failed", "error");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function analyze() {
    if (!selected || requireSubscription(me)) return;
    setBusy("analyze");
    try {
      const queued = await api<{ id: string }>(`/v1/projects/${selected.id}/analysis?branch=${encodeURIComponent(selected.defaultBranch)}`, { method: "POST" });
      prevStatus.current.analysis = "RUNNING";
      setAnalysisRun({ id: queued.id, branch: selected.defaultBranch, commitSha: "", status: "RUNNING", errorMessage: null, completedAt: null, createdAt: new Date().toISOString() });
    } catch (error) {
      notify(error instanceof Error ? error.message : "The action failed", "error");
    } finally {
      setBusy(null);
    }
  }

  function regenerate(mode: "INCREMENTAL" | "FULL") {
    if (!selected || requireSubscription(me)) return;
    setRegenerationOpen(false);
    void runAction("generate", async () => {
      const { generationId } = await api<{ generationId: string }>(`/v1/projects/${selected.id}/generations/candidates`, { method: "POST" });
      await waitForGeneration(selected.id, generationId);
    }, mode === "FULL" ? "Full regeneration completed — review the new candidates." : "Incremental generation completed — review the new candidates.").then(() => refreshRuns());
  }

  function runApprovedSuite(environmentId?: string) {
    if (!selected || requireSubscription(me)) return;
    if (!environmentId && environments.length === 0) { setRunModalOpen(true); return; }
    const envId = environmentId ?? (environments.find((environment) => environment.isDefault) ?? environments[0])?.id;
    void runAction("runall", () => api(`/v1/projects/${selected.id}/executions/run-all`, { method: "POST", body: envId ? { environmentId: envId } : {} }), "Approved suite queued for execution.").then((ok) => { if (ok) setQueued(overview?.tests.approved ?? 0); });
  }

  const billingPct = overview && overview.billing.tokenQuotaMonthly > 0 ? Math.min(100, Math.round((overview.billing.usage.totalTokens / overview.billing.tokenQuotaMonthly) * 100)) : 0;
  const last = overview?.lastExecution ?? null;
  const lastPct = last?.total && !["QUEUED", "RUNNING"].includes(last.status) ? Math.round((last.passed / last.total) * 100) : null;
  const toReview = overview ? overview.tests.pendingReview + overview.tests.needsReview : 0;
  const repoPath = overview ? overview.project.repositoryUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "") : "";
  const lastState = !last ? "idle" : last.status === "RUNNING" || last.status === "QUEUED" ? "live" : last.status === "FAILED" || (last.total > 0 && last.passed < last.total) ? "fail" : "done";

  return (
    <AppShell activePath="/dashboard" switcher={
        <div className="project-switcher as-button" role="button" tabIndex={0} aria-haspopup="listbox" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)} onKeyDown={(event) => event.key === "Enter" && setProjectMenuOpen((open) => !open)}>
          {projects === null ? <span className="skel" style={{ width: 130, height: 12 }} /> : <span><strong>{selected?.name ?? (projects.length ? "Select project" : "No project")}</strong><small>{selected ? selected.defaultBranch : "create your first project"}</small></span>}<ChevronDown size={14} />
          {projectMenuOpen && projects && projects.length > 0 && (
            <div className="project-menu" role="listbox" onClick={(event) => event.stopPropagation()}>
              {projects.map((project) => (
                <button key={project.id} role="option" aria-selected={selected?.id === project.id} className={selected?.id === project.id ? "selected" : ""} onClick={() => { setSelected(project); setProjectMenuOpen(false); }}>{project.name}<small>{project.defaultBranch}</small></button>
              ))}
            </div>
          )}
        </div>
    }>
      <>
        <header className="topbar">
          <div className="crumb">
            {overview ? <>
              <strong title={overview.project.repositoryUrl}>{repoPath}</strong>
              <span className="branch-chip"><GitBranch size={12} />{overview.project.defaultBranch}</span>
              {overview.analysis && <span title="Analyzed commit">@ {shortSha(overview.analysis.commitSha)}</span>}
            </> : <strong>Overview</strong>}
          </div>
          <div className="top-actions">
            {overview?.billing.billingLocked && <span className="billing-lock-badge">{statusLabels[overview.billing.status] ?? overview.billing.status}</span>}
            {overview && <span className="quota" title="Concurrent test slots on your plan">{overview.billing.executionSlotLimit} slots</span>}
            {overview && <span className="quota" title={`${overview.billing.usage.totalTokens.toLocaleString()} of ${overview.billing.tokenQuotaMonthly.toLocaleString()} AI tokens used`}>AI {billingPct}%<span className="meter"><span className={billingPct >= overview.billing.warningThresholdPct ? "warn" : ""} style={{ width: `${billingPct}%` }} /></span></span>}
            <button className="icon-button" aria-label="Notifications" onClick={() => notify("No new notifications.")}><Bell size={15} /></button>
            <Link className="help-button" href="/help"><CircleHelp size={14} />Help</Link>
          </div>
        </header>

        <div className="content">
          {!projects ? <OverviewSkeleton />
            : projects.length === 0 ? <EmptyState />
            : overviewError ? (
              <section className="banner error" role="alert">
                <X size={15} />
                <span>{overviewError} — the Overview could not be loaded for this project.</span>
                <button className="secondary-button" onClick={() => { setOverview(null); setOverviewError(null); setOverviewNonce((nonce) => nonce + 1); }}><RotateCw size={13} />Retry</button>
              </section>
            )
            : !overview ? <OverviewSkeleton />
            : <>
              <section className="project-heading">
                <div>
                  <h1>{overview.project.name}</h1>
                  <p className="repo-line"><a href={overview.project.repositoryUrl} target="_blank" rel="noreferrer">{repoPath}</a><span className="dot">/</span>{overview.project.defaultBranch}</p>
                </div>
              </section>

              {queued !== null && <RunQueued count={queued} onClose={() => setQueued(null)} />}
              {overview.billing.billingLocked && <section className="banner error"><X size={15} /><span>{statusLabels[overview.billing.status] ?? overview.billing.status}: generation, approvals, and execution are blocked until billing is resolved. Visit <Link href="/billing">Billing</Link>.</span></section>}

              <section className="lifecycle" aria-label="Test lifecycle">
                <Stage label="Analysis" state={analyzing ? "live" : analysisRun?.status === "FAILED" ? "fail" : overview.analysis ? "done" : "idle"}
                  value={<span className="mono">{overview.analysis ? shortSha(overview.analysis.commitSha) : "—"}</span>}
                  detail={analyzing ? <><Loader2 size={12} className="spin" /> {overview.analysis ? "Re-analyzing" : "Analyzing"}{analysisElapsed ? ` · ${analysisElapsed}` : ""}</>
                    : analysisRun?.status === "FAILED" ? <>Analysis failed{overview.analysis ? " · using the previous one" : ""}</>
                    : overview.analysis ? <><span className="mono">{overview.analysis.branch}</span> · {fmtRelative(overview.analysis.completedAt)}</> : "Analyze the default branch to map routes, forms and APIs."}
                  action={canGenerate && <button className="secondary-button" onClick={analyze} disabled={busy !== null || analyzing || generating}><SearchCode size={14} />{analyzing ? "Analyzing…" : "Analyze"}</button>} />
                <Stage label="Generated" state={generating ? "live" : overview.tests.total ? "done" : "idle"}
                  value={overview.tests.total}
                  detail={generating ? <><Loader2 size={12} className="spin" /> Generating{generationElapsed ? ` · ${generationElapsed}` : ""}</> : overview.generation ? <>{overview.generation.mode.toLowerCase()} · {overview.generation.created ?? 0} new · {fmtRelative(overview.generation.createdAt)}</> : "AI drafts candidates from the analyzed commit."}
                  action={canGenerate && <div className="split-action joined">
                    <button className="primary-button" onClick={() => regenerate("INCREMENTAL")} disabled={busy !== null || analyzing || generating}><RotateCw size={14} />{generating ? "Generating…" : "Regenerate"}</button>
                    <button className="primary-button caret" aria-label="Regeneration options" aria-expanded={regenerationOpen} onClick={() => setRegenerationOpen((open) => !open)} disabled={busy !== null || analyzing || generating}><ChevronDown size={14} /></button>
                    {regenerationOpen && <div className="action-menu">
                      <button onClick={() => regenerate("INCREMENTAL")}><span><strong>Incremental regeneration</strong><small>Analyze only changed and affected capabilities.</small></span><CircleHelp size={14} aria-label="Compares the previous analysis commit with the selected target commit." /></button>
                      <button onClick={() => { if (window.confirm("Full regeneration reanalyzes the complete repository revision and can consume more AI quota. Continue?")) regenerate("FULL"); }}><span><strong>Full regeneration</strong><small>Reanalyze the complete repository revision.</small></span><CircleHelp size={14} aria-label="Uses more AI quota and preserves existing approved and manual tests." /></button>
                    </div>}
                  </div>} />
                <Stage label="Review" state={toReview ? "wait" : overview.tests.total ? "done" : "idle"}
                  value={toReview}
                  detail={<>{overview.tests.pendingReview} pending · {overview.tests.needsReview} need another look</>}
                  action={can(me, PERMISSIONS.TEST_CASES_VIEW) && <Link className="text-button" href="/test-cases?status=PENDING_REVIEW">Open review queue <ArrowRight size={13} /></Link>} />
                <Stage label="Approved" state={overview.tests.approved ? "done" : "idle"}
                  value={overview.tests.approved}
                  detail="Only approved versions can execute, here or in CI."
                  action={canRun && <button className="run-button" onClick={() => runApprovedSuite()} disabled={busy !== null || overview.tests.approved === 0 || overview.billing.billingLocked}><PlayCircle size={14} />{busy === "runall" ? "Queuing…" : "Run approved"}</button>} />
                <Stage label="Last run" state={lastState} last
                  value={lastPct !== null ? <>{lastPct}<small>%</small></> : last ? <span style={{ fontSize: 16 }}>{statusLabels[last.status] ?? last.status}</span> : "—"}
                  detail={last ? <>{last.passed}/{last.total} passed · <span className="mono">{last.branch}</span>{last.commitSha ? <> @ <span className="mono">{shortSha(last.commitSha)}</span></> : null} · {fmtRelative(last.createdAt)}</> : "No executions yet."}
                  action={can(me, PERMISSIONS.EXECUTIONS_VIEW) && <Link className="text-button" href="/executions">All executions <ArrowRight size={13} /></Link>} />
              </section>

              <section className="overview-grid">
                {can(me, PERMISSIONS.TEST_CASES_VIEW) && <div className="panel flush">
                  <div className="panel-heading"><div><h2>Waiting for review</h2><p className="muted">{toReview} of {overview.tests.total} tests need a decision</p></div><Link className="text-button" href="/test-cases?status=PENDING_REVIEW">Review in lanes <ArrowRight size={13} /></Link></div>
                  {overview.tests.total === 0 ? (
                    <div className="empty-panel"><strong>No test cases yet</strong><span>Run an analysis, then Regenerate to draft reviewable candidates. Nothing runs until someone approves it.</span></div>
                  ) : queue === null ? (
                    <div className="review-list" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <div className="review-row" key={i}><span className="skel" style={{ width: 60, height: 16, borderRadius: 999 }} /><span style={{ display: "grid", gap: 5 }}><span className="skel" style={{ width: `${50 + i * 9}%`, height: 11 }} /><span className="skel" style={{ width: "30%", height: 9 }} /></span></div>)}</div>
                  ) : queue.length === 0 ? (
                    <div className="empty-panel"><strong>Review queue is clear</strong><span>Every generated test has a decision. {overview.tests.approved} approved test{overview.tests.approved === 1 ? "" : "s"} can run.</span></div>
                  ) : (
                    <div className="review-list">
                      {queue.slice(0, 7).map((test) => (
                        <Link className="review-row" key={test.id} href={`/test-cases?status=${test.status}&test=${test.id}`}>
                          <span className={`status ${test.status === "NEEDS_REVIEW" ? "needs-review" : "pending-review"}`}>{test.status === "NEEDS_REVIEW" ? "Needs review" : "Pending"}</span>
                          <span className="review-copy"><strong>{test.title}</strong><small>{[test.capability, test.category ? categoryLabels[test.category] ?? test.category : null].filter(Boolean).join(" · ")}</small></span>
                          <span className={`priority ${test.priority.toLowerCase()}`}>{test.priority}</span>
                          <span className="num">{test.confidence != null ? `${Math.round(test.confidence * 100)}%` : "–"}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                  <div className="panel-footer"><span>{queue && queue.length > 7 ? `${queue.length - 7} more in the review lanes` : "Confidence is the model's own score; evidence is in each test."}</span><span className="queue-tally"><span className="status approved">{overview.tests.approved} approved</span><span className="status rejected">{overview.tests.rejected} rejected</span></span></div>
                </div>}

                <div className="stack">
                  {can(me, PERMISSIONS.EXECUTIONS_VIEW) && <section className="panel flush">
                    <div className="panel-heading"><div><h2>Recent runs</h2></div><Link className="text-button" href="/executions">Executions <ArrowRight size={13} /></Link></div>
                    <div className="run-log">
                      {overview.executions.length === 0 ? <div className="empty-inline">No executions yet. Approved tests run on demand here or from CI.</div> : overview.executions.slice(0, 6).map((execution) => (
                        <div className="run-line" key={execution.id}>
                          <i className={execution.status.toLowerCase()} aria-hidden />
                          <div><strong>{execution.branch}</strong><small>{execution.trigger.toLowerCase()} · {fmtRelative(execution.createdAt)} · {statusLabels[execution.status] ?? execution.status}</small></div>
                          <SegBar passed={execution.passed} failed={execution.failed} total={execution.total} />
                          <span className="num">{execution.passed}/{execution.total}</span>
                        </div>
                      ))}
                    </div>
                  </section>}
                  <section className="panel flush">
                    <div className="panel-heading"><div><h2>{overview.billing.planName} plan</h2></div>{can(me, PERMISSIONS.BILLING_VIEW) && <Link className="text-button" href="/billing">Billing <ArrowRight size={13} /></Link>}</div>
                    <dl className="usage-strip">
                      <div><dt>AI tokens</dt><dd>{billingPct}%</dd><span className="meter"><span className={billingPct >= overview.billing.warningThresholdPct ? "warn" : ""} style={{ width: `${billingPct}%` }} /></span></div>
                      <div><dt>Remaining</dt><dd>{overview.billing.remainingTokens.toLocaleString()}</dd></div>
                      <div><dt>Run slots</dt><dd>{overview.billing.executionSlotLimit}</dd>{overview.billing.currentPeriodEnd && <dt>renews {fmtDate(overview.billing.currentPeriodEnd)}</dt>}</div>
                    </dl>
                  </section>
                </div>
              </section>
            </>}
        </div>
      {runModalOpen && selected && (
        <RunEnvironmentModal
          projectId={selected.id}
          onClose={() => setRunModalOpen(false)}
          onReady={(envId) => {
            setRunModalOpen(false);
            setEnvironments((current) => [...current, { id: envId, name: "New environment", isDefault: true }]);
            runApprovedSuite(envId);
          }}
        />
      )}

      {toast && <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
        {toast.tone === "success" ? <Check size={16} /> : toast.tone === "error" ? <X size={16} /> : <CircleHelp size={16} />}
        <span>{toast.message}</span>
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={dismiss}><X size={13} /></button>
      </div>}
      </>
    </AppShell>
  );
}

function Stage({ label, state, value, detail, action, last }: { label: string; state: "done" | "wait" | "fail" | "live" | "idle"; value: React.ReactNode; detail: React.ReactNode; action?: React.ReactNode; last?: boolean }) {
  return (
    <div className="stage" data-state={state}>
      <div className="stage-head"><span className="stage-node" aria-hidden />{label}{!last && <ChevronRight size={14} className="arrow" aria-hidden />}</div>
      <div className="stage-value">{value}</div>
      <div className="stage-detail">{detail}</div>
      <div className="stage-action">{action}</div>
    </div>
  );
}

interface QueueTest { id: string; title: string; status: string; priority: string; capability: string | null; category: string | null; confidence: number | null }
const priorityRank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function OverviewSkeleton() {
  return (
    <div style={{ display: "grid", gap: 16 }} aria-busy="true" aria-label="Loading overview">
      <div style={{ display: "grid", gap: 8 }}><span className="skel" style={{ width: 220, height: 20 }} /><span className="skel" style={{ width: 280, height: 12 }} /></div>
      <div className="lifecycle">{Array.from({ length: 5 }, (_, i) => <div className="stage" key={i}><span className="skel" style={{ width: 70, height: 10 }} /><span className="skel" style={{ width: 54, height: 22 }} /><span className="skel" style={{ width: "80%", height: 10 }} /><span className="skel" style={{ width: 96, height: 28 }} /></div>)}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="empty-state">
      <h1>Connect a repository to start</h1>
      <p>Proofline analyzes a branch at a pinned commit, drafts test candidates with their evidence, and waits for your team to approve them. Nothing runs until someone does.</p>
      <div><Link className="primary-button" href="/projects"><Plus size={14} />Go to projects</Link></div>
    </section>
  );
}
