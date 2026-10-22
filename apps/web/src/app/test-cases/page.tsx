"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Archive, ArrowDown, ArrowUp, Ban, Check, ChevronDown, CircleHelp, Columns3, Crosshair, Download, FilePlus2, FolderKanban, GripVertical, Layers, LayoutList, Pencil, PlayCircle,
  Lock, Plus, RotateCcw, RotateCw, Search, SlidersHorizontal, Sparkles, Tag, ThumbsUp, Trash2, X, Network, CircleDot
} from "lucide-react";
import { RecorderSetupModal } from "@/components/recorder-setup-modal";
import { BitbucketIcon, GithubIcon, GitlabIcon } from "@/components/brand-icons";
import { AppShell } from "@/components/app-shell";
import { RunQueued } from "@/components/run-queued";
import { RunEnvironmentModal } from "@/components/run-environment-modal";
import { SearchableSelect } from "@/components/searchable-select";
import { Select } from "@/components/select";
import { InfoTooltip } from "@/components/info-tooltip";
import { useFitViewport } from "@/components/use-fit-viewport";
import { api, apiUrl, categoryLabels, fmtRelative, shortSha, statusClass, statusLabels } from "@/lib/api";
import { can, requireSubscription, useMe, useProjects, useToast } from "@/lib/hooks";
import { clearRecorderInstalledFlag, persistRecorderInstalled, readRecorderInstalledFlag, useRecorderPresence } from "@/lib/use-recorder-presence";
import { PERMISSIONS } from "@ai-qa/domain";

/**
 * Hands the proofline-recorder:// link to the OS. Only ever called from a direct user
 * click (start button, retry, picker) so the browser allows the external navigation;
 * when the recorder isn't installed the OS shows its own dialog and the inline setup
 * help appears in the record bar instead.
 */
function launchDeepLink(link: string) {
  window.location.href = link;
}

/** Recording-session status poll interval. The poller is a self-scheduling
 *  timer chain that never overlaps requests, so this is a steady ONE request
 *  every 5 seconds — slow enough to keep the API (and the browser tab) calm,
 *  fast enough for the "N steps captured" counter to feel live. */
const RECORDING_POLL_INTERVAL_MS = 5000;

interface StepDto { action: string; target: string; value?: string; condition?: string; region?: { x: number; y: number; w: number; h: number }; tolerance?: number }
interface DefinitionDto { capability?: string; category?: string; preconditions?: string[]; steps?: StepDto[]; expectedResult?: string }
interface TestRow {
  id: string; projectId: string; title: string; status: string; source: string; capability: string | null; category: string | null;
  priority: string; route: string | null; confidence: number | null; version: number; definition: DefinitionDto | null;
  generatedFromCommit: string | null; lastValidatedCommit: string | null; createdAt: string;
  projectName?: string; provider?: string;
  modules: Array<{ module: { id: string; name: string } }>;
  tags: Array<{ tag: { id: string; name: string } }>;
}
interface Classifications { modules: Array<{ id: string; name: string }>; tags: Array<{ id: string; name: string }> }

const categoryOptions = Object.keys(categoryLabels);
const priorityOptions = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const statusOptions = ["PENDING_REVIEW", "NEEDS_REVIEW", "APPROVED", "REJECTED", "ARCHIVED"];
/** Lanes follow the review lifecycle; rejected and archived share the closed lane. */
const lanes: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: "PENDING_REVIEW", label: "Pending review", statuses: ["PENDING_REVIEW"] },
  { key: "NEEDS_REVIEW", label: "Needs review", statuses: ["NEEDS_REVIEW"] },
  { key: "APPROVED", label: "Approved", statuses: ["APPROVED"] },
  { key: "CLOSED", label: "Rejected / archived", statuses: ["REJECTED", "ARCHIVED"] }
];
type View = "lanes" | "table" | "grouped";
const stepActions = ["navigate", "click", "fill", "select", "upload", "assert", "waitFor", "wait", "screenshot", "capture", "assertColor", "assertData", "assertResponse"].map((action) => ({
  value: action,
  label: action === "waitFor" ? "waitFor (text)" : action === "wait" ? "wait (seconds)" : action === "assertColor" ? "assert color" : action === "assertData" ? "assert data" : action === "assertResponse" ? "assert response" : action === "capture" ? "capture (variable)" : action
}));
const providerOptions = [
  { value: "GITHUB", label: "GitHub" },
  { value: "BITBUCKET", label: "Bitbucket" },
  { value: "GITLAB", label: "GitLab" }
];
const providerLabels: Record<string, string> = { GITHUB: "GitHub", BITBUCKET: "Bitbucket", GITLAB: "GitLab" };

function TestCasesInner() {
  const me = useMe();
  const canCreate = can(me, PERMISSIONS.TEST_CASES_CREATE), canEdit = can(me, PERMISSIONS.TEST_CASES_EDIT), canDelete = can(me, PERMISSIONS.TEST_CASES_DELETE), canApprove = can(me, PERMISSIONS.TEST_CASES_APPROVE), canRun = can(me, PERMISSIONS.EXECUTIONS_RUN);
  const { projects, selected } = useProjects();
  const { toast, notify } = useToast();
  const searchParams = useSearchParams();
  const [tests, setTests] = useState<TestRow[] | null>(null);
  const [classifications, setClassifications] = useState<Classifications>({ modules: [], tags: [] });
  const [projectFilter, setProjectFilter] = useState(searchParams.get("projectId") ?? "");
  const [providerFilter, setProviderFilter] = useState("");
  // Layout choice persists across navigation and reloads.
  const viewKey = "proofline.testCasesView";
  const [view, setView] = useState<View>("lanes");
  useEffect(() => {
    const stored = window.localStorage.getItem(viewKey);
    if (stored === "grouped" || stored === "table") setView(stored);
  }, []);
  function changeView(next: View) {
    setView(next);
    window.localStorage.setItem(viewKey, next);
  }
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [classificationsOpen, setClassificationsOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState(searchParams.get("status") ?? "");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [moduleFilter, setModuleFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; test: TestRow } | null>(null);
  const [createProjectId, setCreateProjectId] = useState("");
  // ?test=<id> (from the overview's review queue) opens that test in the inspector.
  const [detailId, setDetailId] = useState<string | null>(searchParams.get("test"));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [queued, setQueued] = useState<number | null>(null);
  const [pendingRun, setPendingRun] = useState<{ projectId: string; ids: string[] } | null>(null);

  const activeProjectId = editor?.mode === "create" ? (createProjectId || projectFilter || selected?.id || "") : (editor?.mode === "edit" ? editor.test.projectId : projectFilter || selected?.id || "");
  const createTargetOptions = (projects ?? []).map((project) => ({ value: project.id, label: project.name }));
  const projectNameOf = (id: string) => projects?.find((project) => project.id === id)?.name ?? "Unknown project";

  // Cascading filters: the project dropdown only offers projects whose repository matches the selected provider.
  const visibleProjects = useMemo(() => {
    const all = projects ?? [];
    return providerFilter ? all.filter((project) => project.provider === providerFilter) : all;
  }, [projects, providerFilter]);

  useEffect(() => {
    if (projectFilter && !visibleProjects.some((project) => project.id === projectFilter)) setProjectFilter("");
  }, [providerFilter, visibleProjects, projectFilter]);

  const reload = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (projectFilter) params.set("projectId", projectFilter);
      if (providerFilter) params.set("provider", providerFilter);
      const query = params.toString();
      const [rows, classes] = await Promise.all([
        api<TestRow[]>(`/v1/test-cases${query ? `?${query}` : ""}`),
        api<Classifications>("/v1/classifications")
      ]);
      setTests(rows);
      setClassifications(classes);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load test cases", "error");
    }
  }, [projectFilter, providerFilter, notify]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { setChecked(new Set()); }, [projectFilter, providerFilter, statusFilter, categoryFilter, moduleFilter, tagFilter, search]);

  // Everything except the status filter: the lifecycle tabs count across this set.
  const scoped = useMemo(() => {
    if (!tests) return [];
    const needle = search.trim().toLowerCase();
    return tests.filter((test) => {
      if (categoryFilter && test.category !== categoryFilter) return false;
      if (moduleFilter && !test.modules.some((entry) => entry.module.id === moduleFilter)) return false;
      if (tagFilter && !test.tags.some((entry) => entry.tag.id === tagFilter)) return false;
      if (needle && !(`${test.title} ${test.capability ?? ""} ${test.route ?? ""} ${test.projectName ?? ""}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [tests, categoryFilter, moduleFilter, tagFilter, search]);
  const filtered = useMemo(() => statusFilter ? scoped.filter((test) => test.status === statusFilter) : scoped, [scoped, statusFilter]);
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const test of scoped) counts[test.status] = (counts[test.status] ?? 0) + 1;
    return counts;
  }, [scoped]);
  const visibleLanes = useMemo(() => statusFilter ? lanes.filter((lane) => lane.statuses.includes(statusFilter)) : lanes, [statusFilter]);
  // Keyboard order follows what is on screen: lane by lane, or the list order.
  const ordered = useMemo(() => view === "lanes" ? visibleLanes.flatMap((lane) => filtered.filter((test) => lane.statuses.includes(test.status))) : filtered, [view, visibleLanes, filtered]);
  const detail = (detailId && tests?.find((test) => test.id === detailId)) || null;

  function groupByProject(ids: string[]) {
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const projectId = tests?.find((test) => test.id === id)?.projectId;
      if (!projectId) continue;
      groups.set(projectId, [...(groups.get(projectId) ?? []), id]);
    }
    return groups;
  }

  async function act(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try { await fn(); notify(success, "success"); await reload(); return true; }
    catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); return false; }
    finally { setBusy(null); }
  }

  // A toast alone is easy to miss; keep a visible "queued" message until dismissed.
  const showQueued = (count: number) => { setQueued(count); document.querySelector(".workspace")?.scrollTo({ top: 0, behavior: "smooth" }); };

  function deleteOne(test: TestRow) {
    if (!window.confirm(`Delete "${test.title}"? Tests with execution history are archived instead of being permanently removed.`)) return;
    void act("delete", async () => {
      const result = await api<{ deleted: boolean; message: string }>(`/v1/projects/${test.projectId}/test-cases/${test.id}`, { method: "DELETE" });
      notify(result.message, result.deleted ? "success" : "info");
    }, "Test case removed.");
  }

  function bulkDelete() {
    const ids = [...checked];
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} test case(s)? Tests with execution history are archived instead of being permanently removed.`)) return;
    void act("bulk-delete", async () => {
      const results = await Promise.all([...groupByProject(ids)].map(([projectId, projectIds]) =>
        api<{ deleted: number; archived: number; message: string }>(`/v1/projects/${projectId}/test-cases/bulk/delete`, { method: "POST", body: { testCaseIds: projectIds } })
      ));
      const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
      const archived = results.reduce((sum, result) => sum + result.archived, 0);
      notify(archived > 0 ? `${deleted} deleted, ${archived} archived (execution history retained).` : `${deleted} test cases permanently deleted.`, "success");
    }, "Tests removed.");
    setChecked(new Set());
  }

  const approveOne = (test: TestRow) => act("approve", () => api(`/v1/projects/${test.projectId}/test-cases/${test.id}/approve`, { method: "PATCH" }), "Test approved — it can now be executed.");
  const rejectOne = (test: TestRow) => act("reject", () => api(`/v1/projects/${test.projectId}/test-cases/${test.id}/reject`, { method: "PATCH" }), "Test rejected.");
  const bulkAction = (action: "approve" | "reject" | "archive") => act(`bulk-${action}`, async () => {
    await Promise.all([...groupByProject([...checked])].map(([projectId, ids]) =>
      api(`/v1/projects/${projectId}/test-cases/bulk/status`, { method: "POST", body: { testCaseIds: ids, action } })
    ));
  }, `Bulk ${action} applied to ${checked.size} tests.`);

  const selectedApproved = [...checked].filter((id) => filtered.find((test) => test.id === id)?.status === "APPROVED");

  function runSelected() {
    if (requireSubscription(me)) return;
    const ids = selectedApproved;
    if (!ids.length) { notify("Select approved tests to run — pending or rejected tests cannot execute.", "error"); return; }
    const groups = groupByProject(ids);
    if (groups.size === 1) {
      const [projectId, projectIds] = [...groups][0]!;
      let needsEnvironment = false;
      void act("run", async () => {
        try {
          await api(`/v1/projects/${projectId}/executions`, { method: "POST", body: { testCaseIds: projectIds } });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "";
          if (/no environment/i.test(message)) {
            needsEnvironment = true;
            setPendingRun({ projectId, ids: projectIds ?? [] });
            notify("Pick a target URL for this project's first run.", "info");
            return;
          }
          throw cause;
        }
      }, `${projectIds!.length} approved tests queued for execution.`).then((ok) => { setChecked(new Set()); if (ok && !needsEnvironment) showQueued(projectIds!.length); });
      return;
    }
    void act("run", async () => {
      const results = await Promise.allSettled([...groups].map(([projectId, projectIds]) =>
        api(`/v1/projects/${projectId}/executions`, { method: "POST", body: { testCaseIds: projectIds } })
      ));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        const first = failures[0] as PromiseRejectedResult;
        throw new Error(`${failures.length} of ${groups.size} project runs failed — ${first.reason instanceof Error ? first.reason.message : "check each project's environment"}`);
      }
    }, `Queued runs across ${groups.size} projects.`).then((ok) => { if (ok) showQueued(ids.length); });
    setChecked(new Set());
  }


  const classificationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const test of tests ?? []) {
      for (const entry of test.modules) counts.set(entry.module.id, (counts.get(entry.module.id) ?? 0) + 1);
      for (const entry of test.tags) counts.set(entry.tag.id, (counts.get(entry.tag.id) ?? 0) + 1);
    }
    return counts;
  }, [tests]);

  // Review from the keyboard: j/k move, a approves, r rejects, e edits, x toggles selection, / searches, Esc closes.
  const keyState = useRef({ ordered, detail, busy, blocked: false });
  keyState.current = { ordered, detail, busy, blocked: Boolean(editor || classificationsOpen || pendingRun) };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const { ordered: list, detail: current, busy: working, blocked } = keyState.current;
      const target = event.target as HTMLElement | null;
      if (blocked || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && (target.closest("input, textarea, select, [contenteditable='true']"))) {
        if (event.key === "Escape" && target === searchRef.current) searchRef.current?.blur();
        return;
      }
      const index = current ? list.findIndex((test) => test.id === current.id) : -1;
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); return; }
      if (event.key === "j" || event.key === "ArrowDown" && current) { const next = list[Math.min(index + 1, list.length - 1)]; if (next) { event.preventDefault(); setDetailId(next.id); } return; }
      if (event.key === "k" || event.key === "ArrowUp" && current) { const prev = list[Math.max(index - 1, 0)]; if (prev) { event.preventDefault(); setDetailId(prev.id); } return; }
      if (event.key === "Escape" && current) { setDetailId(null); return; }
      if (!current || working) return;
      if (event.key === "a" && canApprove && current.status !== "APPROVED") void approveOne(current);
      else if (event.key === "r" && canApprove && current.status !== "REJECTED" && current.status !== "ARCHIVED") void rejectOne(current);
      else if (event.key === "e" && canEdit) setEditor({ mode: "edit", test: current });
      else if (event.key === "x") setChecked((previous) => { const next = new Set(previous); if (next.has(current.id)) next.delete(current.id); else next.add(current.id); return next; });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (detailId) document.querySelector(`[data-test-id="${detailId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [detailId, view]);

  function toggleChecked(id: string, on: boolean) {
    setChecked((previous) => {
      const next = new Set(previous);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  const allChecked = filtered.length > 0 && filtered.every((test) => checked.has(test.id));
  const scopeLabel = projectFilter ? projectNameOf(projectFilter) : "All projects";
  const checkedGroups = groupByProject([...checked]);

  return (
    <AppShell activePath="/test-cases">
      <header className="page-header">
        <div>
          <h1>Test cases</h1>
          <p className="meta"><strong>{scopeLabel}</strong>{filtered.length} of {tests?.length ?? 0} shown</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={() => setClassificationsOpen(true)}><Layers size={14} />Modules &amp; tags</button>
          {canCreate && <button className="secondary-button" onClick={() => { setCreateProjectId(projectFilter || selected?.id || ""); setEditor({ mode: "create" }); }}><FilePlus2 size={14} />New manual test</button>}
          {canRun && <button className="run-button" onClick={runSelected} disabled={checked.size === 0 || busy !== null}><PlayCircle size={14} />Run selected{selectedApproved.length ? ` (${selectedApproved.length})` : ""}</button>}
        </div>
      </header>

      {queued !== null && <RunQueued count={queued} onClose={() => setQueued(null)} />}

      {!projects ? <LibrarySkeleton /> : <>
        <nav className="lifecycle-tabs" aria-label="Filter by review status">
          <button type="button" aria-pressed={statusFilter === ""} onClick={() => setStatusFilter("")}><span><i />All</span><strong>{scoped.length}</strong></button>
          {statusOptions.map((status) => (
            <button type="button" key={status} aria-pressed={statusFilter === status} onClick={() => setStatusFilter(statusFilter === status ? "" : status)}><span><i className={`t-${statusClass(status)}`} />{statusLabels[status]}</span><strong>{statusCounts[status] ?? 0}</strong></button>
          ))}
        </nav>

        <section className={filtersOpen ? "toolbar open" : "toolbar"} aria-label="Filters">
          <label className="search"><Search size={14} /><input ref={searchRef} placeholder="Search title, capability, route…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search tests" /><kbd>/</kbd></label>
          <button type="button" className="secondary-button filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal size={14} />Filters{[projectFilter, providerFilter, categoryFilter, moduleFilter, tagFilter].filter(Boolean).length ? ` · ${[projectFilter, providerFilter, categoryFilter, moduleFilter, tagFilter].filter(Boolean).length}` : ""}</button>
          <SearchableSelect value={projectFilter} onChange={setProjectFilter} placeholder="All projects" ariaLabel="Project filter" options={visibleProjects.map((project) => ({ value: project.id, label: project.name }))} />
          <span className="brand-switch" role="group" aria-label="Repository provider">
            <button type="button" className={providerFilter === "" ? "seg on" : "seg"} onClick={() => setProviderFilter("")} aria-pressed={providerFilter === ""}>All</button>
            {providerOptions.map((provider) => (
              <button type="button" key={provider.value} className={providerFilter === provider.value ? "seg on" : "seg"} onClick={() => setProviderFilter(provider.value)} aria-pressed={providerFilter === provider.value} title={provider.label}>
                {provider.value === "GITHUB" ? <GithubIcon size={13} /> : provider.value === "BITBUCKET" ? <BitbucketIcon size={13} /> : <GitlabIcon size={13} />}
                {provider.label}
              </button>
            ))}
          </span>
          <Select value={categoryFilter} onChange={setCategoryFilter} ariaLabel="Category filter" options={[{ value: "", label: "All categories" }, ...categoryOptions.map((category) => ({ value: category, label: categoryLabels[category] }))]} />
          <SearchableSelect value={moduleFilter} onChange={setModuleFilter} placeholder="All modules" ariaLabel="Module filter" options={classifications.modules.map((module) => ({ value: module.id, label: module.name }))} />
          <SearchableSelect value={tagFilter} onChange={setTagFilter} placeholder="All tags" ariaLabel="Tag filter" options={classifications.tags.map((tag) => ({ value: tag.id, label: tag.name }))} />
          {(projectFilter || providerFilter || statusFilter || categoryFilter || moduleFilter || tagFilter || search) && (
            <button className="text-button" onClick={() => { setProjectFilter(""); setProviderFilter(""); setStatusFilter(""); setCategoryFilter(""); setModuleFilter(""); setTagFilter(""); setSearch(""); }}><RotateCcw size={13} />Reset</button>
          )}
          <span className="view-toggle" role="group" aria-label="Layout" style={{ marginLeft: "auto" }}>
            <button type="button" className={view === "lanes" ? "seg on" : "seg"} onClick={() => changeView("lanes")} aria-pressed={view === "lanes"}><Columns3 size={13} />Lanes</button>
            <button type="button" className={view === "table" ? "seg on" : "seg"} onClick={() => changeView("table")} aria-pressed={view === "table"}><LayoutList size={13} />Table</button>
            <button type="button" className={view === "grouped" ? "seg on" : "seg"} onClick={() => changeView("grouped")} aria-pressed={view === "grouped"}><Network size={13} />By module</button>
          </span>
        </section>

        {checked.size > 0 && (
          <section className="bulk-bar" aria-label="Bulk actions">
            <strong>{checked.size} selected{checkedGroups.size > 1 ? ` across ${checkedGroups.size} projects` : ""}</strong>
            {canApprove && <button className="mini-button" onClick={() => bulkAction("approve")} disabled={busy !== null}><ThumbsUp size={13} />Approve</button>}
            {canApprove && <button className="mini-button danger" onClick={() => bulkAction("reject")} disabled={busy !== null}><Ban size={13} />Reject</button>}
            {canApprove && <button className="mini-button" onClick={() => bulkAction("archive")} disabled={busy !== null}><Archive size={13} />Archive</button>}
            {canDelete && <button className="mini-button danger" onClick={bulkDelete} disabled={busy !== null}><Trash2 size={13} />Delete</button>}
            <span className="bulk-sep" />
            <BulkClassify groups={[...checkedGroups]} classifications={classifications} onDone={() => reload()} disabled={busy !== null} />
            <button className="mini-button ghost" onClick={() => setChecked(new Set())}><X size={13} />Clear</button>
          </section>
        )}

        {!tests ? <LibrarySkeleton rowsOnly />
          : filtered.length === 0 ? <section className="empty-state"><h2>{tests.length === 0 ? "No test cases yet" : "No tests match these filters"}</h2><p>{tests.length === 0 ? "Analyze a project and generate candidates, or write a manual test. Every test waits for approval before it can run." : "Clear a filter or pick another lifecycle stage."}</p>{projects.length === 0 && <div><Link className="primary-button" href="/projects">Go to projects</Link></div>}</section>
          : <div className={detail ? "library-frame inspecting" : "library-frame"}>
            {view === "lanes" ? (
              <section className="lanes" aria-label="Tests by review stage" style={{ "--lanes": visibleLanes.length } as React.CSSProperties}>
                {visibleLanes.map((lane) => {
                  const laneTests = filtered.filter((test) => lane.statuses.includes(test.status));
                  const laneChecked = laneTests.length > 0 && laneTests.every((test) => checked.has(test.id));
                  return (
                    <div className="lane" data-lane={lane.key} key={lane.key}>
                      <div className="lane-head">
                        <input type="checkbox" checked={laneChecked} disabled={laneTests.length === 0} onChange={() => setChecked((current) => { const next = new Set(current); laneTests.forEach((test) => laneChecked ? next.delete(test.id) : next.add(test.id)); return next; })} aria-label={`Select all in ${lane.label}`} />
                        <i aria-hidden /><strong>{lane.label}</strong><span className="num">{laneTests.length}</span>
                      </div>
                      <div className="lane-body">
                        {laneTests.length === 0 ? <div className="lane-empty">Nothing here</div> : laneTests.map((test) => (
                          <div className={`lane-row${detailId === test.id ? " selected" : ""}${checked.has(test.id) ? " checked" : ""}`} key={test.id} data-test-id={test.id} onClick={() => setDetailId(test.id)}>
                            <label onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={checked.has(test.id)} onChange={(event) => toggleChecked(test.id, event.target.checked)} aria-label={`Select ${test.title}`} /></label>
                            <button type="button" className="lane-copy" aria-pressed={detailId === test.id}>
                              <strong>{test.title}</strong>
                              <span className="lane-meta">
                                {lane.key === "CLOSED" && <span className={`status ${statusClass(test.status)}`}>{statusLabels[test.status]}</span>}
                                <span className={`priority ${test.priority.toLowerCase()}`}>{test.priority}</span>
                                {test.category && <span>{categoryLabels[test.category] ?? test.category}</span>}
                                <span>{test.source === "MANUAL" ? "manual" : `v${test.version}`}</span>
                              </span>
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : view === "grouped" ? <ModuleGroups tests={filtered} collapsed={collapsed} setCollapsed={setCollapsed} checked={checked} setChecked={setChecked} busy={busy} selectedId={detailId} onDetail={(test) => setDetailId(test.id)} onApprove={approveOne} onReject={rejectOne} onEdit={(test) => setEditor({ mode: "edit", test })} onDelete={deleteOne} allChecked={allChecked} onSelectAll={() => setChecked(allChecked ? new Set() : new Set(filtered.map((test) => test.id)))} />
            : <section className="library">
              <div className="library-head">
                <label className="check-all"><input type="checkbox" checked={allChecked} onChange={(event) => setChecked(event.target.checked ? new Set(filtered.map((test) => test.id)) : new Set())} aria-label="Select all" />Select all</label>
                <span>test</span><span>status</span><span>priority</span><span>project</span><span>modules · tags</span><span style={{ textAlign: "right" }}>actions</span>
              </div>
              {filtered.map((test) => (
                <article className={`library-row${detailId === test.id ? " selected" : ""}${checked.has(test.id) ? " checked" : ""}`} key={test.id} data-test-id={test.id}>
                  <label><input type="checkbox" checked={checked.has(test.id)} onChange={(event) => toggleChecked(test.id, event.target.checked)} aria-label={`Select ${test.title}`} /></label>
                  <button className="test-title" onClick={() => setDetailId(test.id)} aria-pressed={detailId === test.id}>
                    <strong>{test.title}</strong>
                    <small>{[test.capability, test.category ? categoryLabels[test.category] ?? test.category : null, test.route].filter(Boolean).join(" · ")}{test.source === "MANUAL" ? " · manual" : ` · v${test.version}`}</small>
                  </button>
                  <span className={`status ${statusClass(test.status)}`}>{statusLabels[test.status] ?? test.status}</span>
                  <span className={`priority ${test.priority.toLowerCase()}`}>{test.priority}</span>
                  <span className="project-cell">
                    <span className="project-cell-name"><FolderKanban size={12} />{test.projectName ?? projectNameOf(test.projectId)}</span>
                    {test.provider && <span className="provider-badge">{test.provider === "GITHUB" ? <GithubIcon size={10} /> : test.provider === "BITBUCKET" ? <BitbucketIcon size={10} /> : <GitlabIcon size={10} />}{providerLabels[test.provider] ?? test.provider}</span>}
                  </span>
                  <span className="chips">
                    {test.modules.map((entry) => <span className="chip module" key={entry.module.id}><Layers size={10} />{entry.module.name}</span>)}
                    {test.tags.map((entry) => <span className="chip tag" key={entry.tag.id}>#{entry.tag.name}</span>)}
                    {test.modules.length + test.tags.length === 0 && <small className="dim">—</small>}
                  </span>
                  <span className="row-actions">
                    {canApprove && test.status !== "APPROVED" && <button className="mini-button approve" title="Approve" aria-label={`Approve ${test.title}`} onClick={() => approveOne(test)} disabled={busy !== null}><ThumbsUp size={13} /></button>}
                    {canApprove && test.status !== "REJECTED" && test.status !== "ARCHIVED" && <button className="mini-button danger" title="Reject" aria-label={`Reject ${test.title}`} onClick={() => rejectOne(test)} disabled={busy !== null}><Ban size={13} /></button>}
                    {canEdit && <button className="mini-button ghost" title="Edit (creates a new version)" aria-label={`Edit ${test.title}`} onClick={() => setEditor({ mode: "edit", test })} disabled={busy !== null}><Pencil size={13} /></button>}
                    {canDelete && <button className="mini-button danger ghost" title="Delete" aria-label={`Delete ${test.title}`} onClick={() => deleteOne(test)} disabled={busy !== null}><Trash2 size={13} /></button>}
                  </span>
                </article>
              ))}
            </section>}
            {detail && <Inspector
              test={detail}
              projectName={detail.projectName ?? projectNameOf(detail.projectId)}
              busy={busy !== null}
              position={`${ordered.findIndex((test) => test.id === detail.id) + 1} / ${ordered.length}`}
              onClose={() => setDetailId(null)}
              onApprove={canApprove && detail.status !== "APPROVED" ? () => approveOne(detail) : undefined}
              onReject={canApprove && detail.status !== "REJECTED" && detail.status !== "ARCHIVED" ? () => rejectOne(detail) : undefined}
              onEdit={canEdit ? () => setEditor({ mode: "edit", test: detail }) : undefined}
              onDelete={canDelete ? () => deleteOne(detail) : undefined}
            />}
          </div>}

      </>}

      {editor && activeProjectId && <TestEditor
        projectId={activeProjectId}
        onProjectChange={editor.mode === "create" ? setCreateProjectId : undefined}
        projectOptions={createTargetOptions}
        mode={editor.mode}
        test={editor.mode === "edit" ? editor.test : null}
        classifications={classifications}
        onClassificationCreated={(kind, item) => setClassifications((current) => kind === "module"
          ? { ...current, modules: current.modules.some((entry) => entry.id === item.id) ? current.modules : [...current.modules, item] }
          : { ...current, tags: current.tags.some((entry) => entry.id === item.id) ? current.tags : [...current.tags, item] })}
        onClose={() => setEditor(null)}
        onSaved={async (message) => { setEditor(null); notify(message, "success"); await reload(); }}
        onError={(message, tone) => notify(message, tone ?? "error")}
      />}


      {pendingRun && (
        <RunEnvironmentModal
          projectId={pendingRun.projectId}
          onClose={() => setPendingRun(null)}
          onReady={(envId) => {
            const run = pendingRun;
            setPendingRun(null);
            void act("run", () => api(`/v1/projects/${run.projectId}/executions`, { method: "POST", body: { testCaseIds: run.ids, environmentId: envId } }), `${run.ids.length} approved tests queued for execution.`).then((ok) => { setChecked(new Set()); if (ok) showQueued(run.ids.length); });
          }}
        />
      )}

      {classificationsOpen && (
        <div className="drawer-backdrop" onClick={() => setClassificationsOpen(false)}>
          <aside className="drawer" role="dialog" aria-label="Manage modules and tags" onClick={(event) => event.stopPropagation()}>
            <ClassificationsDrawer classifications={classifications} counts={classificationCounts} onClose={() => setClassificationsOpen(false)} onChanged={reload} notify={notify} />
          </aside>
        </div>
      )}

      {toast && <div className={`toast ${toast.tone}`} role="status">{toast.tone === "success" ? <Check size={16} /> : toast.tone === "error" ? <X size={16} /> : <CircleHelp size={16} />}{toast.message}</div>}
    </AppShell>
  );
}

function BulkClassify({ groups, classifications, onDone, disabled }: { groups: Array<[string, string[]]>; classifications: Classifications; onDone: () => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [moduleId, setModuleId] = useState("");
  const [tagId, setTagId] = useState("");
  return (
    <span className="bulk-classify">
      <button className="mini-button" onClick={() => setOpen((value) => !value)} disabled={disabled}><Plus size={14} />Modules / tags</button>
      {open && (
        <div className="action-menu classify-menu">
          <label>Move to module
            <Select value={moduleId} onChange={setModuleId} options={[{ value: "", label: "— none —" }, ...classifications.modules.map((module) => ({ value: module.id, label: module.name }))]} />
          </label>
          <label>Add tag
            <Select value={tagId} onChange={setTagId} options={[{ value: "", label: "— none —" }, ...classifications.tags.map((tag) => ({ value: tag.id, label: tag.name }))]} />
          </label>
          <button className="mini-button" onClick={async () => {
            try {
              await Promise.all(groups.map(([projectId, ids]) =>
                api(`/v1/projects/${projectId}/test-cases/bulk/classify`, { method: "POST", body: { testCaseIds: ids, moveModuleId: moduleId || undefined, addTagIds: tagId ? [tagId] : undefined } })
              ));
              setOpen(false);
              onDone();
            } catch { setOpen(false); }
          }}>Apply</button>
        </div>
      )}
    </span>
  );
}

function ClassificationsDrawer({ classifications, counts, onClose, onChanged, notify }: {
  classifications: Classifications;
  counts: Map<string, number>;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  notify: (message: string, tone?: "info" | "success" | "error") => void;
}) {
  const [kind, setKind] = useState<"module" | "tag">("module");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await api("/v1/classifications/" + (kind === "module" ? "modules" : "tags"), { method: "POST", body: { name: trimmed } });
      notify((kind === "module" ? "Module" : "Tag") + " \"" + trimmed + "\" created.", "success");
      setName("");
      await onChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to create", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(kind2: "module" | "tag", id: string, label: string) {
    if (!window.confirm("Delete " + (kind2 === "module" ? "module" : "tag") + " \"" + label + "\"? Tests keep their content, history, and other assignments \u2014 only this grouping is removed.")) return;
    try {
      await api("/v1/classifications/" + (kind2 === "module" ? "modules/" : "tags/") + id, { method: "DELETE" });
      notify(label + " deleted.", "success");
      await onChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to delete", "error");
    }
  }

  return (
    <>
      <header className="drawer-head">
        <div>
          <h2>Modules &amp; tags</h2>
          <small className="dim">Groupings you own, preserved across AI regeneration. Deleting one never deletes tests.</small>
        </div>
        <button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="drawer-body">
        <div className="drawer-create">
          <span className="view-toggle">
            <button type="button" className={kind === "module" ? "seg on" : "seg"} onClick={() => setKind("module")}><Layers size={13} />Module</button>
            <button type="button" className={kind === "tag" ? "seg on" : "seg"} onClick={() => setKind("tag")}><Tag size={13} />Tag</button>
          </span>
          <div className="chip-create">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "module" ? "Checkout Module" : "smoke"} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void create(); } }} />
            <button className="mini-button" onClick={() => void create()} disabled={!name.trim() || busy}><Plus size={13} />Add</button>
          </div>
        </div>

        <h3 className="modal-subhead">Modules</h3>
        {classifications.modules.length === 0 && <small className="dim">No modules yet.</small>}
        {classifications.modules.map((module) => (
          <div className="class-row" key={module.id}>
            <Layers size={14} />
            <strong>{module.name}</strong>
            <span className="module-count">{counts.get(module.id) ?? 0} tests</span>
            <button className="mini-button danger" aria-label={"Delete module " + module.name} onClick={() => void remove("module", module.id, module.name)}><Trash2 size={13} /></button>
          </div>
        ))}

        <h3 className="modal-subhead">Tags</h3>
        {classifications.tags.length === 0 && <small className="dim">No tags yet.</small>}
        {classifications.tags.map((tag) => (
          <div className="class-row tag" key={tag.id}>
            <Tag size={14} />
            <strong>{tag.name}</strong>
            <span className="module-count">{counts.get(tag.id) ?? 0} tests</span>
            <button className="mini-button danger" aria-label={"Delete tag " + tag.name} onClick={() => void remove("tag", tag.id, tag.name)}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </>
  );
}

function ModuleGroups({ tests, collapsed, setCollapsed, checked, setChecked, busy, selectedId, onDetail, onApprove, onReject, onEdit, onDelete, allChecked, onSelectAll }: {
  tests: TestRow[];
  selectedId: string | null;
  collapsed: Set<string>;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
  checked: Set<string>;
  setChecked: React.Dispatch<React.SetStateAction<Set<string>>>;
  busy: string | null;
  onDetail: (test: TestRow) => void;
  onApprove: (test: TestRow) => void;
  onReject: (test: TestRow) => void;
  onEdit: (test: TestRow) => void;
  onDelete: (test: TestRow) => void;
  allChecked: boolean;
  onSelectAll: () => void;
}) {
  const me = useMe();
  const canEdit = can(me, PERMISSIONS.TEST_CASES_EDIT), canDelete = can(me, PERMISSIONS.TEST_CASES_DELETE), canApprove = can(me, PERMISSIONS.TEST_CASES_APPROVE);
  const groups = new Map<string, { key: string; name: string; tests: TestRow[] }>();
  for (const test of tests) {
    const memberships = test.modules.map((entry) => entry.module);
    if (!memberships.length) {
      const group = groups.get("__none__") ?? { key: "__none__", name: "Unassigned", tests: [] };
      group.tests.push(test);
      groups.set("__none__", group);
      continue;
    }
    for (const module of memberships) {
      const group = groups.get(module.id) ?? { key: module.id, name: module.name, tests: [] };
      group.tests.push(test);
      groups.set(module.id, group);
    }
  }
  const ordered = [...groups.values()].sort((a, b) => (a.key === "__none__" ? 1 : b.key === "__none__" ? -1 : a.name.localeCompare(b.name)));

  function toggleGroup(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <section className="module-groups" aria-label="Tests grouped by module">
      <div className="module-groups-top">
        <label className="check-all"><input type="checkbox" checked={allChecked} onChange={onSelectAll} />Select all</label>
        <small className="dim">{tests.length} tests in {ordered.length} module{ordered.length === 1 ? "" : "s"}</small>
      </div>
      {ordered.map((group) => {
        const isCollapsed = collapsed.has(group.key);
        const groupChecked = group.tests.length > 0 && group.tests.every((test) => checked.has(test.id));
        return (
          <div className={"module-group " + (group.key === "__none__" ? "unassigned " : "") + (isCollapsed ? "collapsed" : "")} key={group.key}>
            <div className="module-group-head" role="button" tabIndex={0} onClick={() => toggleGroup(group.key)} onKeyDown={(event) => event.key === "Enter" && toggleGroup(group.key)}>
              <ChevronDown size={15} className="module-chevron" />
              {group.key === "__none__" ? <CircleHelp size={14} /> : <Layers size={14} />}
              <strong>{group.name}</strong>
              <span className="module-count">{group.tests.length}</span>
              <label className="module-select" onClick={(event) => event.stopPropagation()}>
                <input type="checkbox" checked={groupChecked} onChange={() => setChecked((current) => {
                  const next = new Set(current);
                  if (groupChecked) group.tests.forEach((test) => next.delete(test.id));
                  else group.tests.forEach((test) => next.add(test.id));
                  return next;
                })} title="Select all tests in this module" />
              </label>
            </div>
            {!isCollapsed && (
              <div className="module-group-body">
                {group.tests.map((test) => (
                  <div className={`module-row${selectedId === test.id ? " selected" : ""}${checked.has(test.id) ? " checked" : ""}`} key={group.key + "-" + test.id} data-test-id={test.id}>
                    <label><input type="checkbox" checked={checked.has(test.id)} onChange={(event) => {
                      setChecked((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(test.id); else next.delete(test.id);
                        return next;
                      });
                    }} /></label>
                    <button className="test-title" onClick={() => onDetail(test)} aria-pressed={selectedId === test.id}>
                      <strong>{test.title}</strong>
                      <small>{[test.capability, test.category ? categoryLabels[test.category] ?? test.category : null].filter(Boolean).join(" · ")}</small>
                    </button>
                    <span className={"status " + statusClass(test.status)}>{statusLabels[test.status] ?? test.status}</span>
                    <span className={"priority " + test.priority.toLowerCase()}>{test.priority}</span>
                    <span className="row-actions">
                      {canApprove && test.status !== "APPROVED" && <button className="mini-button approve" title="Approve" aria-label={`Approve ${test.title}`} onClick={() => onApprove(test)} disabled={busy !== null}><ThumbsUp size={13} /></button>}
                      {canApprove && test.status !== "REJECTED" && test.status !== "ARCHIVED" && <button className="mini-button danger" title="Reject" onClick={() => onReject(test)} disabled={busy !== null}><Ban size={13} /></button>}
                      {canEdit && <button className="mini-button ghost" title="Edit" onClick={() => onEdit(test)} disabled={busy !== null}><Pencil size={13} /></button>}
                      {canDelete && <button className="mini-button danger ghost" title="Delete" aria-label={`Delete ${test.title}`} onClick={() => onDelete(test)} disabled={busy !== null}><Trash2 size={13} /></button>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * Compact searchable multi-select for modules/tags: selected items render as
 * removable chips, the input filters the catalog, and typing a name that matches
 * nothing offers "Create" — which creates it, assigns it, and adds it to the
 * options list in one action (the old chip cloud went stale after creating).
 */
function ClassificationCombobox({ kind, items, selected, onToggle, onSelect, onCreate, onCreateError }: {
  kind: "module" | "tag";
  items: Array<{ id: string; name: string }>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onCreateError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const isModule = kind === "module";
  const Icon = isModule ? Layers : Tag;
  const trimmed = query.trim();
  const lowered = trimmed.toLowerCase();
  const matches = items
    .filter((item) => !selected.has(item.id) && item.name.toLowerCase().includes(lowered))
    .slice(0, 8);
  const exactExists = trimmed !== "" && items.some((item) => item.name.toLowerCase() === lowered);
  const canCreate = trimmed !== "" && !exactExists && !busy;
  const options: Array<{ type: "match"; item: { id: string; name: string } } | { type: "create"; name: string }> = [
    ...matches.map((item) => ({ type: "match" as const, item })),
    ...(canCreate ? [{ type: "create" as const, name: trimmed }] : [])
  ];

  async function pick(option: (typeof options)[number]) {
    if (option.type === "match") {
      onSelect(option.item.id);
      setQuery("");
      setOpen(false);
      return;
    }
    setBusy(true);
    const ok = await onCreate(option.name);
    setBusy(false);
    if (ok) { setQuery(""); setOpen(false); }
    else onCreateError(`Could not create the ${kind} — it may already exist.`);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setHighlight((h) => Math.min(h + 1, Math.max(0, options.length - 1))); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[highlight];
      if (option) void pick(option);
    }
    else if (event.key === "Escape") setOpen(false);
    else if (event.key === "Backspace" && query === "") {
      const last = [...selected].at(-1);
      if (last) onToggle(last);
    }
  }

  return (
    <div className={`class-combo ${kind}`}>
      <span className="class-combo-label"><Icon size={12} />{isModule ? "Modules" : "Tags"}</span>
      <div className="class-combo-row">
        {items.filter((item) => selected.has(item.id)).map((item) => (
          <span key={item.id} className={`chip ${kind}`}>
            <Icon size={11} />{item.name}
            <button type="button" className="chip-x" aria-label={`Remove ${item.name}`} onClick={() => onToggle(item.id)}><X size={10} /></button>
          </span>
        ))}
        <div className="class-combo-box">
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setOpen(true); setHighlight(0); }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onKeyDown={onKeyDown}
            placeholder={isModule ? "Search or create module..." : "Search or create tag..."}
            aria-label={isModule ? "Search or create modules" : "Search or create tags"}
          />
          {open && options.length > 0 && (
            <div className="combo-menu" role="listbox">
              {options.map((option, index) => option.type === "match" ? (
                <button type="button" key={option.item.id} className={`combo-option ${index === highlight ? "active" : ""}`} onMouseDown={(event) => { event.preventDefault(); void pick(option); }} onMouseEnter={() => setHighlight(index)}>
                  <span><strong>{option.item.name}</strong></span>
                  <Icon size={12} />
                </button>
              ) : (
                <button type="button" key="__create" className={`combo-option create ${index === highlight ? "active" : ""}`} onMouseDown={(event) => { event.preventDefault(); void pick(option); }} onMouseEnter={() => setHighlight(index)}>
                  <span><strong>Create &quot;{option.name}&quot;</strong></span>
                  <Plus size={12} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TestEditor({ projectId, onProjectChange, projectOptions, mode, test, classifications, onClose, onSaved, onError, onClassificationCreated }: {
  projectId: string; onProjectChange?: (id: string) => void; projectOptions: Array<{ value: string; label: string }>; mode: "create" | "edit"; test: TestRow | null; classifications: Classifications;
  onClose: () => void; onSaved: (message: string) => Promise<void>; onError: (message: string, tone?: "info" | "success" | "error") => void;
  onClassificationCreated: (kind: "module" | "tag", item: { id: string; name: string }) => void;
}) {
  const [title, setTitle] = useState(test?.title ?? "");
  const [capability, setCapability] = useState(test?.capability ?? "");
  const [category, setCategory] = useState(test?.category ?? "HAPPY_PATH");
  const [priority, setPriority] = useState(test?.priority ?? "MEDIUM");
  const [route, setRoute] = useState(test?.route ?? "");
  const [expected, setExpected] = useState(test?.definition?.expectedResult ?? "");
  const [preconditions, setPreconditions] = useState((test?.definition?.preconditions ?? []).join("\n"));
  const [steps, setSteps] = useState<StepDto[]>(test?.definition?.steps?.length ? test.definition.steps : [{ action: "navigate", target: "/" }]);
  const [moduleIds, setModuleIds] = useState<Set<string>>(new Set(test?.modules.map((entry) => entry.module.id) ?? []));
  const [tagIds, setTagIds] = useState<Set<string>>(new Set(test?.tags.map((entry) => entry.tag.id) ?? []));
  const [saving, setSaving] = useState(false);
  const [aiDescription, setAiDescription] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [recording, setRecording] = useState<{ sessionId: string; deepLink: string; status: "awaiting-client" | "recording" | "stopped"; count: number } | null>(null);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  // One-time setup: once the recorder has attached on this machine, the setup modal
  // disables downloads — instructions stay viewable, reinstalling is not offered.
  const [recorderInstalled, setRecorderInstalled] = useState(false);
  const [recordingStarting, setRecordingStarting] = useState(false);
  const [regionPicker, setRegionPicker] = useState<{ index: number } | null>(null);
  // Recording-session status poller: a self-scheduling timer chain (NEVER
  // setInterval — an async setInterval callback overlaps and stacks requests
  // whenever the API answers slower than the tick) that is fully torn down when
  // the modal closes, when a new session replaces the old one, and when a session
  // ends. `pollEpoch` invalidates in-flight responses from superseded sessions.
  const pollEpoch = useRef(0);
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    setRecorderInstalled(readRecorderInstalledFlag());
  }, []);

  // Real-time recorder detection, page-wide — ONE request at a time: after the
  // test editor opens, the recorder's local presence endpoint (/ping on
  // 127.0.0.1:43117) is first checked after 2 seconds — nothing fires the moment
  // the modal opens — and every check is EXACTLY ONE request (loopback spellings
  // rotate across attempts). Every unsuccessful check doubles the wait (4s, 8s,
  // capped at 10s). At most 10 automatic attempts run per cycle: the moment the
  // recorder is detected the poller STOPS immediately, and after 10 misses it
  // stops too — the "Check for recorder" button restarts it (one immediate check
  // plus a fresh cycle) whenever the user wants. `reset` backs the Uninstall flow
  // (stops the pings entirely and clears the detected state, which disables
  // "Record steps in a browser").
  const handleRecorderDetected = useCallback(() => {
    // The live presence probe found the app running — persist the flag so the
    // installed state survives reloads even if the app is quit later.
    persistRecorderInstalled();
    setRecorderInstalled(true);
  }, []);
  const {
    detected: recorderLive,
    version: recorderVersion,
    checking: recorderChecking,
    exhausted: recorderExhausted,
    refresh: refreshRecorderNow,
    reset: resetRecorderPresence
  } = useRecorderPresence(handleRecorderDetected);
  // The record button is enabled when the recorder is running right now (live
  // probe) or was detected before on this machine (sticky flag). Otherwise it
  // stays disabled — use the Recorder Setup button next to it to install first.
  const canRecord = recorderLive || recorderInstalled;

  /** Tear the session poller down: called when a session ends, when a new
   *  session replaces the old one, and when the editor modal unmounts (the old
   *  setInterval kept polling forever in the background after the modal was
   *  closed — stacking a new poller on every "Record" click). */
  function stopSessionPolling() {
    pollEpoch.current += 1;
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  useEffect(() => stopSessionPolling, []);

  /** Session status poller — a self-scheduling timer chain, 5 seconds between
   *  requests: the next request is only armed AFTER the previous response (or
   *  error) settles, so requests never overlap and never stack, no matter how
   *  slow the API is. `epoch` discards responses from a superseded session.
   *  Stops when the session reports "stopped" or the API call fails. */
  async function pollRecordingSession(sessionId: string, epoch: number) {
    try {
      const data = await api<{ count: number; status: "awaiting-client" | "recording" | "stopped" }>(`/v1/projects/${projectId}/recordings/${sessionId}`);
      if (epoch !== pollEpoch.current) return; // superseded — a newer session or a teardown
      setRecording((current) => (current?.sessionId === sessionId ? { ...current, count: data.count, status: data.status } : current));
      if (data.status === "recording") {
        // A successful attach marks the one-time setup as done on this machine.
        persistRecorderInstalled();
        setRecorderInstalled(true);
      }
      if (data.status === "stopped") { pollTimer.current = null; return; } // session over — end the chain
      pollTimer.current = window.setTimeout(() => { void pollRecordingSession(sessionId, epoch); }, RECORDING_POLL_INTERVAL_MS);
    } catch {
      pollTimer.current = null; // API error — stop polling this session
    }
  }

  async function startRecording() {
    if (recordingStarting || recording) return;
    setRecordingStarting(true);
    setAiError("");
    try {
      const envs = await api<Array<{ id: string; url: string; isDefault: boolean }>>(`/v1/projects/${projectId}/environments`);
      const env = envs.find((e) => e.isDefault) ?? envs[0];
      if (!env) { onError("Add an environment first - the recorder needs your app URL."); return; }
      const result = await api<{ sessionId: string; deepLink: string; status: "awaiting-client" | "recording" }>(`/v1/projects/${projectId}/recordings`, { method: "POST", body: { url: env.url, apiUrl } });
      stopSessionPolling(); // retire any previous session's poller before starting ours
      const epoch = pollEpoch.current;
      setRecording({ sessionId: result.sessionId, deepLink: result.deepLink, status: result.status, count: 0 });
      // The old one-click workflow: open the recorder immediately. Setup help is never
      // auto-shown — the Recorder Setup button inside the Steps box opens it on demand.
      launchDeepLink(result.deepLink);
      // First status check after one full interval, then one every 5s (never
      // overlapping — see pollRecordingSession).
      pollTimer.current = window.setTimeout(() => { void pollRecordingSession(result.sessionId, epoch); }, RECORDING_POLL_INTERVAL_MS);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to start the recorder");
    } finally {
      setRecordingStarting(false);
    }
  }

  async function stopRecording() {
    if (!recording) return;
    stopSessionPolling();
    try {
      const result = await api<{ events: Array<{ action: string; target: string; value?: string }> }>(`/v1/projects/${projectId}/recordings/${recording.sessionId}/stop`, { method: "POST" });
      const imported = result.events
        .filter((e) => ["click", "fill", "select"].includes(e.action))
        .map((e) => ({ action: e.action as StepDto["action"], target: e.target, value: e.value }));
      if (imported.length) {
        setSteps(imported);
        onError(`${imported.length} step${imported.length === 1 ? "" : "s"} imported - review, edit targets if needed, then save.`, "success");
      } else {
        onError("No steps were captured - click through the flow in the recorder window next time.", "info");
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to stop the recorder");
    } finally {
      setRecording(null);
    }
  }

  async function draftWithAi() {
    const description = aiDescription.trim();
    if (!description || aiBusy) return;
    setAiBusy(true);
    setAiError("");
    try {
      const result = await api<{ draft: { title?: string; capability?: string; category?: string; priority?: string; route?: string; preconditions?: string[]; steps: StepDto[]; expectedResult?: string; module?: string; tags?: string[] } }>(`/v1/projects/${projectId}/generations/ai-draft`, { method: "POST", body: { description } });
      const draft = result.draft;
      if (draft.title) setTitle(draft.title);
      if (draft.capability) setCapability(draft.capability);
      if (draft.category) setCategory(draft.category);
      if (draft.priority) setPriority(draft.priority);
      if (draft.route !== undefined) setRoute(draft.route ?? "");
      if (draft.expectedResult) setExpected(draft.expectedResult);
      if (draft.preconditions) setPreconditions(draft.preconditions.join("\n"));
      if (draft.steps?.length) setSteps(draft.steps);
      if (draft.module) {
        const match = classifications.modules.find((module) => module.name.toLowerCase() === draft.module!.toLowerCase());
        if (match) setModuleIds(new Set([match.id]));
      }
      if (draft.tags?.length) {
        const ids = classifications.tags.filter((tag) => draft.tags!.some((name) => name.toLowerCase() === tag.name.toLowerCase())).map((tag) => tag.id);
        if (ids.length) setTagIds(new Set(ids));
      }
      setAiDescription("");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "AI drafting failed");
    } finally {
      setAiBusy(false);
    }
  }

  function updateStep(index: number, patch: Partial<StepDto>) {
    setSteps((current) => current.map((step, i) => i === index ? { ...step, ...patch } : step));
  }

  const dragIndex = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  function insertStep(atIndex: number) {
    setSteps((current) => {
      const next = [...current];
      next.splice(atIndex, 0, { action: "click", target: "" });
      return next;
    });
  }

  function moveStep(index: number, direction: -1 | 1) {
    setSteps((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function dropStep(index: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    setDragOver(null);
    if (from === null || from === index) return;
    setSteps((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(index, 0, moved);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    const payload = {
      title, capability, category, priority, route,
      expectedResult: expected,
      preconditions: preconditions.split("\n").map((line) => line.trim()).filter(Boolean),
      steps,
      moduleIds: [...moduleIds], tagIds: [...tagIds]
    };
    try {
      if (mode === "create") {
        await api(`/v1/projects/${projectId}/test-cases`, { method: "POST", body: payload });
        await onSaved("Manual test created — pending review.");
      } else {
        await api(`/v1/projects/${projectId}/test-cases/${test!.id}`, { method: "PATCH", body: payload });
        await onSaved("Test updated — a new version was created and returned to review.");
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to save the test");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal wide">
        <header>
          <div>
            <h2>{mode === "create" ? "New manual test" : test!.title}</h2>
            <p className="meta">{mode === "create" ? "saved as pending review" : `saving creates v${test!.version + 1} and returns it to review`}</p>
          </div>
          {mode === "create" && onProjectChange && (
            <div className="editor-project">
              <small>Saving to</small>
              <SearchableSelect value={projectId} onChange={onProjectChange} options={projectOptions} ariaLabel="Project to save the test into" />
            </div>
          )}
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="modal-body">
          <div className="ai-draft">
            <div className="ai-draft-row">
              <textarea
                rows={2}
                value={aiDescription}
                onChange={(event) => setAiDescription(event.target.value)}
                placeholder="Describe the flow in plain English — e.g. 'Go to My Product Designs, open my saved design, and verify the summary shows the correct model' — and let AI draft the steps. You review and edit before saving."
                onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void draftWithAi(); } }}
              />
              <button type="button" className="primary-button ai-draft-btn" onClick={() => void draftWithAi()} disabled={aiBusy || !aiDescription.trim()}>
                <Sparkles size={15} />{aiBusy ? "Drafting…" : "AI draft"}
              </button>
            </div>
            {aiError && <p className="form-message error">{aiError}</p>}
          </div>
          <div className="field-grid">
            <label className="span2">Title<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add to cart updates the badge" /></label>
            <label><span className="label-row">Capability <InfoTooltip label="What is a capability?"><strong>The business feature this test belongs to</strong>, e.g. "Cart and checkout", "Authentication". Tests are grouped and reported by capability.</InfoTooltip></span><input value={capability} onChange={(event) => setCapability(event.target.value)} placeholder="Cart and checkout" /></label>
            <label>Route / page<input value={route} onChange={(event) => setRoute(event.target.value)} placeholder="/products" /></label>
            <label><span className="label-row">Category <InfoTooltip label="What does this category mean?">
              <strong>Which situation does the test exercise?</strong>
              <em>Happy path</em> — the standard user flow, everything valid; expect success.
              <em>Validation</em> — bad or empty input on a form; expect a helpful error.
              <em>Negative</em> — actions a user should not be able to do; expect rejection.
              <em>Boundary</em> — limits and edges: min/max lengths, quantities, dates.
              <em>Error handling</em> — backend/network failures; expect graceful messages, no crashes.
              <em>Permission</em> — access control: can the wrong role do this?
              <em>State change</em> — does an action correctly change app state (visibility, counts)?
              <em>Integration</em> — a flow spanning multiple features or systems.
            </InfoTooltip></span>
            <Select value={category} onChange={setCategory} options={categoryOptions.map((option) => ({ value: option, label: categoryLabels[option] }))} />
            <small className="field-hint">Not sure? Use <strong>Happy path</strong> for normal flows, <strong>Validation</strong> for form/input checks.</small>
          </label>
            <label><span className="label-row">Priority <InfoTooltip label="What does priority mean?">
              <strong>How badly does it hurt when this test fails?</strong>
              <em>CRITICAL</em> — core business flow; a failure should block release.
              <em>HIGH</em> — important feature; fix immediately.
              <em>MEDIUM</em> — normal coverage; fix in the current cycle.
              <em>LOW</em> — cosmetic or rare paths.
            </InfoTooltip></span>
            <Select value={priority} onChange={setPriority} options={priorityOptions.map((option) => ({ value: option, label: option }))} />
          </label>
          </div>
          <label className="block-label">Preconditions (one per line)<textarea rows={2} value={preconditions} onChange={(event) => setPreconditions(event.target.value)} placeholder={"User is signed in\nCart is empty"} /></label>
          <div className="vars-hint">
            <span className="vars-chip">{"{{username}}"}</span>
            <span className="vars-chip">{"{{password}}"}</span>
            <small>Use these in fill/value fields to inject the environment's saved login credentials at run time — never paste real passwords into steps.</small>
          </div>
          <fieldset className="steps-editor">
            <legend>Steps</legend>
            <div className="record-bar">
              <button type="button" className="mini-button" onClick={() => setSetupModalOpen(true)} title="Recorder setup — open, install, and instructions"><Download size={13} />Recorder Setup</button>
              {!recorderLive && (
                <button
                  type="button"
                  className="mini-button"
                  disabled={recorderChecking}
                  onClick={() => void refreshRecorderNow()}
                  title={recorderExhausted
                    ? "Automatic checks are paused after 10 attempts — click to check for the recorder now and restart them"
                    : "Check immediately whether the Proofline Recorder is installed — also restarts the automatic checks"}
                >
                  <RotateCw size={12} className={recorderChecking ? "spin" : undefined} />
                  {recorderChecking ? "Checking…" : "Check for recorder"}
                </button>
              )}
              {!recording ? (
                <>
                  <button
                    type="button"
                    className="record-btn"
                    disabled={recordingStarting || !canRecord}
                    title={canRecord ? "Start a recording session — the recorder opens your app in its own window" : "Install and run the Proofline Recorder first — click “Recorder Setup” to download it"}
                    onClick={() => void startRecording()}
                  >
                    <CircleDot size={14} /> {recordingStarting ? "Opening..." : "Record steps in a browser"}
                  </button>
                  {!canRecord && (
                    <small className="record-hint">
                      The button unlocks as soon as the Proofline Recorder is installed and running — click “Recorder Setup” to get it, then “Check for recorder” to verify. Automatic checks stop after 10 attempts; every click restarts them.
                    </small>
                  )}
                  <small className="record-hint">Opens your app in the Proofline Recorder desktop app - click through the flow and every action is captured as a step. Passwords are masked as {'{{password}}'}.</small>
                </>
              ) : (
                <>
                  {recording.status === "awaiting-client" ? (
                    <span className="record-live"><span className="record-dot" /> Opening the Proofline Recorder…</span>
                  ) : recording.status === "recording" ? (
                    <span className="record-live"><span className="record-dot" /> Recording - {recording.count} step{recording.count === 1 ? "" : "s"} captured. Perform the flow in the recorder window, then stop.</span>
                  ) : (
                    <span className="record-live">Recording ended - {recording.count} step{recording.count === 1 ? "" : "s"} captured.</span>
                  )}
                  <button type="button" className="mini-button danger" onClick={() => void stopRecording()}>Stop Recording</button>
                </>
              )}
            </div>
            {steps.map((step, index) => (
              <div className="step-slot" key={index}>
                <button type="button" className="step-insert" onClick={() => insertStep(index)} aria-label={`Insert step before step ${index + 1}`} title="Insert a step here"><Plus size={12} />Insert step</button>
                <div
                  className={"step-row" + (dragOver === index ? " drag-over" : "")}
                  onDragOver={(event) => { event.preventDefault(); setDragOver(index); }}
                  onDrop={(event) => { event.preventDefault(); dropStep(index); }}
                >
                <span className="drag-handle" draggable title="Drag to reorder" onDragStart={() => { dragIndex.current = index; }} onDragEnd={() => { dragIndex.current = null; setDragOver(null); }}><GripVertical size={14} /></span>
                <span className="step-index">{index + 1}</span>
                <Select className="step-action" value={step.action} onChange={(action) => updateStep(index, { action })} ariaLabel={`Step ${index + 1} action`} options={stepActions} />
                <input value={step.target} onChange={(event) => updateStep(index, { target: event.target.value })} placeholder={step.action === "navigate" ? "/route" : step.action === "wait" ? "Seconds (e.g. 5)" : step.action === "screenshot" ? "Frame name (e.g. before-flip)" : step.action === "capture" ? "Regex with one group" : step.action === "assertColor" ? "Canvas selector (optional)" : step.action === "assertData" ? "API URL — {{query:name}} supported" : step.action === "assertResponse" ? "API path the app calls, e.g. /api/orders" : step.action === "assert" && step.condition === "visual" ? "Describe what should be true on screen" : "Visible text or label"} aria-label={`Step ${index + 1} target`} />
                {(step.action === "fill" || step.action === "select" || step.action === "upload" || (step.action === "assert" && step.condition === "visual") || step.action === "assertColor" || step.action === "assertData" || step.action === "assertResponse" || step.action === "capture") && (
                  <input value={step.value ?? ""} onChange={(event) => updateStep(index, { value: event.target.value })} placeholder={step.action === "fill" ? "e.g. {{username}}" : step.action === "assertColor" ? "#0d5ea0" : step.action === "assertData" ? "0.configuration.body == #0d5ea0" : step.action === "assertResponse" ? "all status == Pending  |  count >= 1  |  shown name" : step.action === "capture" ? "Variable name (e.g. designNumber)" : step.action === "assert" ? "Reference frame name (optional)" : "Value"} aria-label={`Step ${index + 1} value`} />
                )}
                {step.action === "assertColor" && (
                  <span className="region-fields">
                    {(["x", "y", "w", "h"] as const).map((key) => (
                      <input key={key} className="region-input" type="number" min={0} max={100} value={step.region?.[key] ?? ""} onChange={(event) => updateStep(index, { region: { x: step.region?.x ?? 0, y: step.region?.y ?? 0, w: step.region?.w ?? 10, h: step.region?.h ?? 10, [key]: Number(event.target.value) } })} placeholder={key} aria-label={`Region ${key} percent`} title={`Region ${key} (percent)`} />
                    ))}
                    <button type="button" className="mini-button" onClick={() => setRegionPicker({ index })}><Crosshair size={12} />Pick</button>
                  </span>
                )}
                {step.action === "assert" && (
                  <Select className="step-condition" value={step.condition ?? "visible"} onChange={(condition) => updateStep(index, { condition })} ariaLabel={`Step ${index + 1} condition`} options={["visible", "hidden", "contains", "equals", "urlMatches", "visual"].map((condition) => ({ value: condition, label: condition === "visual" ? "AI visual check" : condition }))} />
                )}
                <button type="button" className="mini-button ghost" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => moveStep(index, -1)}><ArrowUp size={12} /></button>
                <button type="button" className="mini-button ghost" aria-label={`Move step ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown size={12} /></button>
                <button type="button" className="mini-button danger" aria-label={`Remove step ${index + 1}`} onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}><X size={13} /></button>
                </div>
              </div>
            ))}
            <button className="mini-button" onClick={() => setSteps((current) => [...current, { action: "click", target: "" }])}><Plus size={13} />Add step</button>
          </fieldset>
          <label className="block-label">Expected result<textarea rows={2} value={expected} onChange={(event) => setExpected(event.target.value)} placeholder="The cart badge shows the updated quantity." /></label>
          <div className="classification-editor">
            <ClassificationCombobox
              kind="module"
              items={classifications.modules}
              selected={moduleIds}
              onToggle={(id) => setModuleIds((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
              })}
              onSelect={(id) => setModuleIds((current) => new Set(current).add(id))}
              onCreate={async (name) => {
                try {
                  const created = await api<{ id: string; name: string }>("/v1/classifications/modules", { method: "POST", body: { name } });
                  onClassificationCreated("module", created);
                  setModuleIds((current) => new Set(current).add(created.id));
                  return true;
                } catch { return false; }
              }}
              onCreateError={(message) => onError(message)}
            />
            <ClassificationCombobox
              kind="tag"
              items={classifications.tags}
              selected={tagIds}
              onToggle={(id) => setTagIds((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
              })}
              onSelect={(id) => setTagIds((current) => new Set(current).add(id))}
              onCreate={async (name) => {
                try {
                  const created = await api<{ id: string; name: string }>("/v1/classifications/tags", { method: "POST", body: { name } });
                  onClassificationCreated("tag", created);
                  setTagIds((current) => new Set(current).add(created.id));
                  return true;
                } catch { return false; }
              }}
              onCreateError={(message) => onError(message)}
            />
          </div>
        </div>
        <footer>
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button className="primary-button" onClick={save} disabled={saving || !title.trim() || steps.some((step) => !step.target.trim())}>{saving ? "Saving…" : mode === "create" ? "Create test case" : "Save new version"}</button>
        </footer>
      </div>
      {regionPicker && projectId && (
        <RegionPickerModal
          projectId={projectId}
          onApply={(region) => {
            updateStep(regionPicker.index, { region });
            setRegionPicker(null);
          }}
          onClose={() => setRegionPicker(null)}
          onError={(message) => onError(message)}
        />
      )}
      {setupModalOpen && (
        <RecorderSetupModal
          apiUrl={apiUrl}
          installed={recorderInstalled}
          running={recorderLive}
          serverVersion={recorderVersion}
          deepLink={recording?.deepLink ?? null}
          probing={recorderChecking}
          onClose={() => setSetupModalOpen(false)}
          onLaunch={launchDeepLink}
          onUninstall={() => {
            // Uninstall done: clear the sticky flag, reset the live detection, and
            // stop the ping requests — downloads flip back on and "Record steps in
            // a browser" disables until the recorder is installed again.
            clearRecorderInstalledFlag();
            setRecorderInstalled(false);
            resetRecorderPresence();
          }}
          onProbeNow={refreshRecorderNow}
        />
      )}
    </div>
  );
}

/**
 * Drag-to-pick a canvas region for assert color: opens the app in the recorder
 * browser (user navigates to the state they want), screenshots it live, and the
 * rectangle the user drags becomes percent coordinates — never typed by hand.
 */
function RegionPickerModal({ projectId, onApply, onClose, onError }: {
  projectId: string;
  onApply: (region: { x: number; y: number; w: number; h: number }) => void;
  onClose: () => void;
  onError: (message: string, tone?: "info" | "success" | "error") => void;
}) {
  const [session, setSession] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [shotBusy, setShotBusy] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  async function openBrowser() {
    setStarting(true);
    try {
      const envs = await api<Array<{ id: string; url: string; isDefault: boolean }>>(`/v1/projects/${projectId}/environments`);
      const env = envs.find((e) => e.isDefault) ?? envs[0];
      if (!env) { onError("Add an environment first - the picker needs your app URL."); return; }
      const result = await api<{ sessionId: string; deepLink: string }>(`/v1/projects/${projectId}/recordings`, { method: "POST", body: { url: env.url, apiUrl } });
      setSession(result.sessionId);
      // The screenshot comes from the Proofline Recorder desktop app — open it for this session.
      launchDeepLink(result.deepLink);
      await refresh(result.sessionId);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to open the picker browser");
    } finally {
      setStarting(false);
    }
  }

  async function refresh(sessionId: string) {
    setShotBusy(true);
    try {
      const data = await api<{ image: string }>(`/v1/projects/${projectId}/recordings/${sessionId}/screenshot`);
      setImage(data.image);
      setDrag(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Screenshot failed");
    } finally {
      setShotBusy(false);
    }
  }

  function relative(event: React.MouseEvent) {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100))
    };
  }

  function onMouseDown(event: React.MouseEvent) {
    const p = relative(event);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }
  function onMouseMove(event: React.MouseEvent) {
    if (!drag) return;
    const p = relative(event);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  }
  function onMouseUp() {
    if (!drag) return;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    if (w < 1 || h < 1) { setDrag(null); return; }
    onApply({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  }

  const rectStyle = drag ? {
    left: `${Math.min(drag.x0, drag.x1)}%`,
    top: `${Math.min(drag.y0, drag.y1)}%`,
    width: `${Math.abs(drag.x1 - drag.x0)}%`,
    height: `${Math.abs(drag.y1 - drag.y0)}%`
  } : null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal region-picker" onClick={(event) => event.stopPropagation()}>
        <header><div><h2>Drag a rectangle over the area to check</h2><p className="meta">region picker · coordinates saved as percentages</p></div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
        <div className="modal-body">
          {!session ? (
            <div className="picker-intro">
              <p>This opens your app in a separate browser window. Navigate to the view you want to check (e.g. rotate the model so the location is visible), then come back here and press <strong>Refresh screenshot</strong>, and drag over the region.</p>
              <button className="primary-button" disabled={starting} onClick={() => void openBrowser()}>{starting ? "Opening browser..." : "Open app in browser"}</button>
            </div>
          ) : (
            <>
              <div className="picker-toolbar">
                <button className="mini-button" disabled={shotBusy} onClick={() => void refresh(session)}>{shotBusy ? "..." : "Refresh screenshot"}</button>
                <small className="dim">The browser window stays open - navigate, refresh, then drag.</small>
              </div>
              {image && (
                <div ref={boxRef} className="picker-canvas" onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={() => drag && onMouseUp()}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image} alt="Live app screenshot" draggable={false} />
                  {rectStyle && <div className="picker-rect" style={rectStyle} />}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Inspector({ test, projectName, busy, position, onClose, onApprove, onReject, onEdit, onDelete }: {
  test: TestRow; projectName: string; busy: boolean; position: string;
  onClose: () => void; onApprove?: () => void; onReject?: () => void; onEdit?: () => void; onDelete?: () => void;
}) {
  const steps = test.definition?.steps ?? [];
  const ref = useRef<HTMLElement | null>(null);
  useFitViewport(ref);
  return (
    <aside className="inspector" aria-label="Test details" ref={ref}>
      <header className="inspector-head">
        <div className="inspector-top">
          <span className={`status ${statusClass(test.status)}`}>{statusLabels[test.status] ?? test.status}</span>
          <span className="meta">{test.source === "MANUAL" ? "manual" : `ai · v${test.version}`}<span className="dot">·</span>{position}<span className="keys" title="Move with j and k"><kbd>j</kbd><kbd>k</kbd></span></span>
          <button className="icon-button" aria-label="Close details" title="Close (Esc)" onClick={onClose}><X size={14} /></button>
        </div>
        <h2>{test.title}</h2>
        {(test.modules.length > 0 || test.tags.length > 0) && <div className="chips">
          {test.modules.map((entry) => <span className="chip module" key={entry.module.id}><Layers size={10} />{entry.module.name}</span>)}
          {test.tags.map((entry) => <span className="chip tag" key={entry.tag.id}>#{entry.tag.name}</span>)}
        </div>}
      </header>
      <div className="inspector-body">
        {test.status === "APPROVED"
          ? <p className="run-gate open"><PlayCircle size={14} />Runs with the approved suite<span>v{test.version} approved</span></p>
          : <p className="run-gate"><Lock size={14} />Run unavailable<span>version not approved</span></p>}
        <dl className="detail-grid">
          <div><dt>Project</dt><dd>{projectName}</dd></div>
          <div><dt>Capability</dt><dd>{test.capability ?? "—"}</dd></div>
          <div><dt>Category</dt><dd>{test.category ? categoryLabels[test.category] ?? test.category : "—"}</dd></div>
          <div><dt>Priority</dt><dd><span className={`priority ${test.priority.toLowerCase()}`}>{test.priority}</span></dd></div>
          <div><dt>Confidence</dt><dd className="mono">{test.confidence != null ? `${Math.round(test.confidence * 100)}%` : "—"}</dd></div>
          <div><dt>Route</dt><dd className="mono">{test.route ?? "—"}</dd></div>
          <div><dt>Generated from</dt><dd className="mono">{test.generatedFromCommit ? shortSha(test.generatedFromCommit) : "—"}</dd></div>
          <div><dt>Last validated</dt><dd className="mono">{test.lastValidatedCommit ? shortSha(test.lastValidatedCommit) : "—"}</dd></div>
        </dl>
        {test.definition?.preconditions?.length ? <section><h3 className="section-label">Preconditions</h3><ul className="pre-list">{test.definition.preconditions.map((line, index) => <li key={index}>{line}</li>)}</ul></section> : null}
        <section>
          <h3 className="section-label">Steps <span className="dim mono">{steps.length}</span></h3>
          {steps.length ? <ol className="step-list">
            {steps.map((step, index) => (
              <li key={index}><span><code>{step.action}</code> {step.target}{step.value ? <> → <strong>{step.value}</strong></> : null}{step.condition ? <small> ({step.condition})</small> : null}</span></li>
            ))}
          </ol> : <p className="dim">No steps recorded.</p>}
        </section>
        <section><h3 className="section-label">Expected result</h3><p className="expected">{test.definition?.expectedResult ?? "—"}</p></section>
        <p className="meta">created {fmtRelative(test.createdAt)}</p>
      </div>
      {(onApprove || onReject || onEdit || onDelete) && <footer className="inspector-foot">
        {onApprove && <button className="run-button" onClick={onApprove} disabled={busy}><ThumbsUp size={13} />Approve <kbd>a</kbd></button>}
        {onReject && <button className="mini-button danger" style={{ minHeight: 32 }} onClick={onReject} disabled={busy}><Ban size={13} />Reject <kbd>r</kbd></button>}
        {onEdit && <button className="mini-button" style={{ minHeight: 32 }} onClick={onEdit} disabled={busy}><Pencil size={13} />Edit</button>}
        <span className="spacer" />
        {onDelete && <button className="mini-button danger ghost" style={{ minHeight: 32 }} aria-label="Delete test" title="Delete" onClick={onDelete} disabled={busy}><Trash2 size={13} /></button>}
      </footer>}
    </aside>
  );
}

function LibrarySkeleton({ rowsOnly }: { rowsOnly?: boolean }) {
  return (
    <div style={{ display: "grid", gap: 12 }} aria-busy="true" aria-label="Loading test cases">
      {!rowsOnly && <div className="lifecycle-tabs">{Array.from({ length: 6 }, (_, i) => <div key={i} style={{ flex: 1, padding: "10px 12px", display: "grid", gap: 6 }}><span className="skel" style={{ width: 70, height: 9 }} /><span className="skel" style={{ width: 28, height: 16 }} /></div>)}</div>}
      <div className="library">{Array.from({ length: 7 }, (_, i) => <div className="library-row" key={i}><span className="skel" style={{ width: 14, height: 14 }} /><span style={{ display: "grid", gap: 6 }}><span className="skel" style={{ width: `${40 + (i * 17) % 40}%`, height: 11 }} /><span className="skel" style={{ width: "30%", height: 9 }} /></span><span className="skel" style={{ width: 80, height: 18, borderRadius: 999 }} /></div>)}</div>
    </div>
  );
}

export default function TestCasesPage() {
  return <Suspense><TestCasesInner /></Suspense>;
}
