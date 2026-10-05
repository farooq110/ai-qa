"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Activity, ArrowDown, BarChart3, Bell, Check, ChevronDown, CircleHelp, Clock3, FolderKanban,
  GitBranch, LayoutDashboard, PlayCircle, Plus, RotateCw, Search, Settings, ShieldCheck, Sparkles, TestTube2, Users, X
} from "lucide-react";
import { api, fmtRelative, shortSha, statusClass, statusLabels } from "@/lib/api";
import { RunEnvironmentModal } from "@/components/run-environment-modal";
import { useMe, useProjects, useToast } from "@/lib/hooks";

const navItems = [
  [LayoutDashboard, "Overview", "/"],
  [FolderKanban, "Projects", "/projects"],
  [TestTube2, "Test cases", "/test-cases"],
  [Activity, "Executions", "/executions"],
  [GitBranch, "CI / CD", "/ci-cd"],
  [Users, "Team", "/team"]
] as const;

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
  const { projects, selected, setSelected } = useProjects();
  const { toast, notify } = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [regenerationOpen, setRegenerationOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [environments, setEnvironments] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [runModalOpen, setRunModalOpen] = useState(false);

  useEffect(() => {
    if (!selected) { setOverview(null); return; }
    let cancelled = false;
    api<Overview>(`/v1/projects/${selected.id}/overview`).then((data) => { if (!cancelled) setOverview(data); }).catch((error) => notify(error instanceof Error ? error.message : "Unable to load overview", "error"));
    api<Array<{ id: string; name: string; isDefault: boolean }>>(`/v1/projects/${selected.id}/environments`).then((envs) => { if (!cancelled) setEnvironments(envs); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [selected, notify]);

  async function runAction(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      await fn();
      notify(success, "success");
      const refreshed = await api<Overview>(`/v1/projects/${selected!.id}/overview`);
      setOverview(refreshed);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The action failed", "error");
    } finally {
      setBusy(null);
    }
  }

  function analyze() {
    if (!selected) return;
    void runAction("analyze", () => api(`/v1/projects/${selected.id}/analysis?branch=${encodeURIComponent(selected.defaultBranch)}`, { method: "POST" }), "Repository analysis completed.");
  }

  function regenerate(mode: "INCREMENTAL" | "FULL") {
    if (!selected) return;
    setRegenerationOpen(false);
    void runAction("generate", async () => {
      await api(`/v1/projects/${selected.id}/generations`, { method: "POST", body: { mode } });
      await api(`/v1/projects/${selected.id}/generations/candidates`, { method: "POST" });
    }, mode === "FULL" ? "Full regeneration completed — review the new candidates." : "Incremental generation completed — review the new candidates.");
  }

  function runApprovedSuite(environmentId?: string) {
    if (!selected) return;
    if (!environmentId && environments.length === 0) { setRunModalOpen(true); return; }
    const envId = environmentId ?? (environments.find((environment) => environment.isDefault) ?? environments[0])?.id;
    void runAction("runall", () => api(`/v1/projects/${selected.id}/executions/run-all`, { method: "POST", body: envId ? { environmentId: envId } : {} }), "Approved suite queued for execution.");
  }

  const billingPct = overview && overview.billing.tokenQuotaMonthly > 0 ? Math.min(100, Math.round((overview.billing.usage.totalTokens / overview.billing.tokenQuotaMonthly) * 100)) : 0;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">P</span><span>proofline</span></div>
        <div className="project-switcher as-button" role="button" tabIndex={0} onClick={() => setProjectMenuOpen((open) => !open)} onKeyDown={(event) => event.key === "Enter" && setProjectMenuOpen((open) => !open)}>
          <span><strong>{selected?.name ?? (projects?.length ? "Select project" : "No project")}</strong><small>{selected ? selected.defaultBranch : "Create your first project"}</small></span><ChevronDown size={16} />
          {projectMenuOpen && projects && projects.length > 0 && (
            <div className="project-menu" onClick={(event) => event.stopPropagation()}>
              {projects.map((project) => (
                <button key={project.id} className={selected?.id === project.id ? "selected" : ""} onClick={() => { setSelected(project); setProjectMenuOpen(false); }}>{project.name}<small>{project.defaultBranch}</small></button>
              ))}
            </div>
          )}
        </div>
        <nav aria-label="Main navigation">
          {navItems.map(([Icon, label, href], index) => <Link className={index === 0 ? "nav-item active" : "nav-item"} key={label} href={href}><Icon size={18} />{label}</Link>)}
        </nav>
        <div className="sidebar-bottom">
          <Link className="nav-item" href="/settings"><Settings size={18} />Settings</Link>
          <div className="account"><span>{me ? me.displayName.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() : "…"}</span><div><strong>{me?.displayName ?? "Loading…"}</strong><small>{me?.role ? me.role.charAt(0) + me.role.slice(1).toLowerCase() : ""}</small></div></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="crumb"><span>Projects</span><ArrowDown size={14} /><strong>{selected?.name ?? "Overview"}</strong></div>
          <div className="top-actions">
            {overview?.billing.billingLocked && <span className="billing-lock-badge">{statusLabels[overview.billing.status] ?? overview.billing.status}</span>}
            <button className="icon-button" aria-label="Notifications" onClick={() => notify("No new notifications.")}><Bell size={18} /></button>
            <button className="help-button" onClick={() => notify("Documentation will open here.")}><CircleHelp size={17} />Help</button>
          </div>
        </header>

        <div className="content">
          {!projects ? <section className="loading-state">Loading organization projects…</section>
            : projects.length === 0 ? <EmptyState />
            : !overview ? <section className="loading-state">Loading project overview…</section>
            : <>
              <section className="project-heading">
                <div>
                  <p className="eyebrow">PROJECT CONTROL CENTER</p>
                  <h1>{overview.project.name}</h1>
                  <p className="muted"><GitBranch size={15} /> {overview.project.repositoryUrl} <span className="dot">•</span> {overview.project.defaultBranch}</p>
                </div>
                <div className="heading-actions">
                  <button className="secondary-button" onClick={analyze} disabled={busy !== null}><ShieldCheck size={16} />{busy === "analyze" ? "Analyzing…" : "Analyze"}</button>
                  <div className="split-action">
                    <button className="primary-button" onClick={() => regenerate("INCREMENTAL")} disabled={busy !== null}><RotateCw size={17} />{busy === "generate" ? "Generating…" : "Regenerate"}</button>
                    <button className="primary-button caret" aria-label="Regeneration options" onClick={() => setRegenerationOpen((open) => !open)}><ChevronDown size={17} /></button>
                    {regenerationOpen && <div className="action-menu">
                      <button onClick={() => regenerate("INCREMENTAL")}><span><strong>Incremental regeneration</strong><small>Analyze only changed and affected capabilities.</small></span><CircleHelp size={16} aria-label="Compares the previous analysis commit with the selected target commit." /></button>
                      <button onClick={() => { if (window.confirm("Full regeneration reanalyzes the complete repository revision and can consume more AI quota. Continue?")) regenerate("FULL"); }}><span><strong>Full regeneration</strong><small>Reanalyze the complete repository revision.</small></span><CircleHelp size={16} aria-label="Uses more AI quota and preserves existing approved and manual tests." /></button>
                    </div>}
                  </div>
                </div>
              </section>

              {overview.billing.billingLocked && <section className="banner error"><X size={16} />{statusLabels[overview.billing.status] ?? overview.billing.status}: generation, approvals, and execution are blocked until billing is resolved. Visit <Link href="/settings">Settings → Billing</Link>.</section>}

              <section className="metric-grid" aria-label="Project metrics">
                <Metric label="Analysis" value={overview.analysis ? shortSha(overview.analysis.commitSha) : "—"} detail={overview.analysis ? `${overview.analysis.branch} · ${fmtRelative(overview.analysis.completedAt)}` : "Run your first analysis"} tone="mint" icon={ShieldCheck} />
                <Metric label="Test cases" value={String(overview.tests.total)} detail={`${overview.tests.pendingReview} pending review · ${overview.tests.approved} approved`} tone="gold" icon={TestTube2} />
                <Metric label="Last run" value={overview.lastExecution ? (overview.lastExecution.total ? `${Math.round((overview.lastExecution.passed / overview.lastExecution.total) * 100)}%` : statusLabels[overview.lastExecution.status] ?? overview.lastExecution.status) : "—"} detail={overview.lastExecution ? `${overview.lastExecution.passed}/${overview.lastExecution.total} passed · ${fmtRelative(overview.lastExecution.createdAt)}` : "No executions yet"} tone="blue" icon={BarChart3} />
                <Metric label="AI allowance" value={`${billingPct}%`} detail={`${overview.billing.remainingTokens.toLocaleString()} tokens remaining · ${overview.billing.planName}`} tone={billingPct >= overview.billing.warningThresholdPct ? "coral" : "mint"} icon={Sparkles} />
              </section>

              <section className="split-grid">
                <div className="panel test-panel">
                  <div className="panel-heading"><div><p className="eyebrow">REVIEW QUEUE</p><h2>Generated test cases</h2></div><Link className="text-button" href="/test-cases">View all</Link></div>
                  <div className="filter-row"><label className="search"><Search size={16} /><input placeholder="Search in the test library" readOnly /></label><Link className="filter-button" href="/test-cases">Library <ChevronDown size={15} /></Link></div>
                  {overview.tests.total === 0 ? (
                    <div className="empty-panel"><TestTube2 size={22} /><strong>No test cases yet</strong><span>Run an analysis, then click Regenerate to produce reviewable candidates.</span></div>
                  ) : (
                    <div className="queue-summary">
                      <QueueRow label="Pending review" count={overview.tests.pendingReview} tone="pending-review" href="/test-cases?status=PENDING_REVIEW" />
                      <QueueRow label="Approved" count={overview.tests.approved} tone="approved" href="/test-cases?status=APPROVED" />
                      <QueueRow label="Needs review" count={overview.tests.needsReview} tone="needs-review" href="/test-cases?status=NEEDS_REVIEW" />
                      <QueueRow label="Rejected" count={overview.tests.rejected} tone="rejected" href="/test-cases?status=REJECTED" />
                      <div className="panel-footer"><span>Only approved tests can execute.</span><button className="run-button" onClick={() => runApprovedSuite()} disabled={busy !== null || overview.tests.approved === 0 || overview.billing.billingLocked}><PlayCircle size={15} />Run approved suite</button></div>
                    </div>
                  )}
                </div>

                <div className="stack">
                  <section className="panel execution-panel">
                    <div className="panel-heading"><div><p className="eyebrow">EXECUTION</p><h2>Latest run</h2></div><span className={`live-dot ${overview.lastExecution?.status === "RUNNING" ? "" : "settled"}`}>{overview.lastExecution ? statusLabels[overview.lastExecution.status] : "Idle"}</span></div>
                    <div className="execution-body">
                      <div className="run-ring" data-status={overview.lastExecution?.status ?? "NONE"}><strong>{overview.lastExecution?.total ? Math.round((overview.lastExecution.passed / overview.lastExecution.total) * 100) : 0}%</strong><span>passed</span></div>
                      <div>
                        <strong>{overview.lastExecution ? `${overview.lastExecution.passed} / ${overview.lastExecution.total} passed` : "No executions yet"}</strong>
                        <p>{overview.lastExecution ? <>Commit <code>{shortSha(overview.lastExecution.commitSha)}</code> · {overview.lastExecution.branch}</> : "Queue the approved suite to see results here."}</p>
                        <div className="progress"><span style={{ width: `${overview.lastExecution?.total ? Math.round((overview.lastExecution.passed / overview.lastExecution.total) * 100) : 0}%` }} /></div>
                      </div>
                    </div>
                    <Link className="full-run" href="/executions"><Clock3 size={16} />View all executions</Link>
                  </section>
                  <section className="panel branch-panel">
                    <div className="panel-heading"><div><p className="eyebrow">RECENT RUNS</p><h2>Execution history</h2></div></div>
                    <div className="branches">
                      {overview.executions.length === 0 ? <div className="empty-inline">No executions yet.</div> : overview.executions.slice(0, 4).map((execution) => (
                        <div className="branch" key={execution.id}>
                          <span className={`branch-status ${execution.status.toLowerCase()}`} />
                          <div><strong>{execution.branch}</strong><small>{execution.passed}/{execution.total} passed · {fmtRelative(execution.createdAt)}</small></div>
                          <span>{statusLabels[execution.status] ?? execution.status}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </section>
            </>}
        </div>
      </section>
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

      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </main>
  );
}

function QueueRow({ label, count, tone, href }: { label: string; count: number; tone: string; href: string }) {
  return <Link className="queue-row" href={href}><span className={`status ${tone}`}>{count}</span><div><strong>{label}</strong></div><ChevronDown size={15} className="row-chevron" /></Link>;
}

function EmptyState() {
  return <section className="empty-state"><p className="eyebrow">START HERE</p><h1>Create your first project</h1><p>Connect GitHub, choose a repository, then analyze the selected branch to generate reviewable test cases.</p><div><Link className="primary-button" href="/projects"><Plus size={16} />Go to projects</Link></div></section>;
}

function Metric({ label, value, detail, tone, icon: Icon }: { label: string; value: string; detail: string; tone: string; icon: typeof Activity }) {
  return <article className="metric"><div className={`metric-icon ${tone}`}><Icon size={20} /></div><div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div></article>;
}
