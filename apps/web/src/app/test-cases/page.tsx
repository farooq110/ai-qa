"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Archive, ArrowDown, ArrowUp, Ban, Check, ChevronDown, CircleHelp, Crosshair, FilePlus2, FolderKanban,   GripVertical, Layers, LayoutList, Pencil, PlayCircle,
  Plus, RotateCcw, Search, Sparkles, Tag, ThumbsUp, Trash2, X, Network, CircleDot
} from "lucide-react";
import { BitbucketIcon, GithubIcon, GitlabIcon } from "@/components/brand-icons";
import { AppShell } from "@/components/app-shell";
import { RunEnvironmentModal } from "@/components/run-environment-modal";
import { SearchableSelect } from "@/components/searchable-select";
import { InfoTooltip } from "@/components/info-tooltip";
import { api, categoryLabels, fmtRelative, statusClass, statusLabels } from "@/lib/api";
import { useProjects, useToast } from "@/lib/hooks";

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
const statusOptions = ["PENDING_REVIEW", "APPROVED", "NEEDS_REVIEW", "REJECTED", "ARCHIVED"];
const providerOptions = [
  { value: "GITHUB", label: "GitHub" },
  { value: "BITBUCKET", label: "Bitbucket" },
  { value: "GITLAB", label: "GitLab" }
];
const providerLabels: Record<string, string> = { GITHUB: "GitHub", BITBUCKET: "Bitbucket", GITLAB: "GitLab" };
const providerOf = (url: string) => /bitbucket\.org/i.test(url) ? "BITBUCKET" : /gitlab/i.test(url) ? "GITLAB" : "GITHUB";

function TestCasesInner() {
  const { projects, selected } = useProjects();
  const { toast, notify } = useToast();
  const searchParams = useSearchParams();
  const [tests, setTests] = useState<TestRow[] | null>(null);
  const [classifications, setClassifications] = useState<Classifications>({ modules: [], tags: [] });
  const [projectFilter, setProjectFilter] = useState(searchParams.get("projectId") ?? "");
  const [providerFilter, setProviderFilter] = useState("GITHUB");
  // Layout choice persists across navigation and reloads.
  const viewKey = "proofline.testCasesView";
  const [view, setView] = useState<"table" | "grouped">("table");
  useEffect(() => {
    if (window.localStorage.getItem(viewKey) === "grouped") setView("grouped");
  }, []);
  function changeView(next: "table" | "grouped") {
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
  const [detail, setDetail] = useState<TestRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingRun, setPendingRun] = useState<{ projectId: string; ids: string[] } | null>(null);

  const activeProjectId = editor?.mode === "create" ? (createProjectId || projectFilter || selected?.id || "") : (projectFilter || selected?.id || "");
  const createTargetOptions = (projects ?? []).map((project) => ({ value: project.id, label: project.name }));
  const projectNameOf = (id: string) => projects?.find((project) => project.id === id)?.name ?? "Unknown project";

  // Cascading filters: the project dropdown only offers projects whose repository matches the selected provider.
  const visibleProjects = useMemo(() => {
    const all = projects ?? [];
    return providerFilter ? all.filter((project) => providerOf(project.repositoryUrl) === providerFilter) : all;
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

  const filtered = useMemo(() => {
    if (!tests) return [];
    const needle = search.trim().toLowerCase();
    return tests.filter((test) => {
      if (statusFilter && test.status !== statusFilter) return false;
      if (categoryFilter && test.category !== categoryFilter) return false;
      if (moduleFilter && !test.modules.some((entry) => entry.module.id === moduleFilter)) return false;
      if (tagFilter && !test.tags.some((entry) => entry.tag.id === tagFilter)) return false;
      if (needle && !(`${test.title} ${test.capability ?? ""} ${test.route ?? ""} ${test.projectName ?? ""}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [tests, statusFilter, categoryFilter, moduleFilter, tagFilter, search]);

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
    try { await fn(); notify(success, "success"); await reload(); }
    catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); }
    finally { setBusy(null); }
  }

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
    const ids = selectedApproved;
    if (!ids.length) { notify("Select approved tests to run — pending or rejected tests cannot execute.", "error"); return; }
    const groups = groupByProject(ids);
    if (groups.size === 1) {
      const [projectId, projectIds] = [...groups][0]!;
      void act("run", async () => {
        try {
          await api(`/v1/projects/${projectId}/executions`, { method: "POST", body: { testCaseIds: projectIds } });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "";
          if (/no environment/i.test(message)) {
            setPendingRun({ projectId, ids: projectIds ?? [] });
            notify("Pick a target URL for this project's first run.", "info");
            return;
          }
          throw cause;
        }
      }, `${projectIds!.length} approved tests queued for execution.`).then(() => setChecked(new Set()));
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
    }, `Queued runs across ${groups.size} projects.`);
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

  const allChecked = filtered.length > 0 && filtered.every((test) => checked.has(test.id));
  const scopeLabel = projectFilter ? projectNameOf(projectFilter) : "All projects";
  const checkedGroups = groupByProject([...checked]);

  return (
    <AppShell activePath="/test-cases">
      <header className="page-header">
        <div>
          <p className="eyebrow">TEST LIBRARY</p>
          <h1>Test cases</h1>
          <p className="muted">{scopeLabel} · {filtered.length} of {tests?.length ?? 0} tests shown</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={() => setClassificationsOpen(true)}><Layers size={16} />Modules &amp; tags</button>
          <button className="secondary-button" onClick={() => { setCreateProjectId(projectFilter || selected?.id || ""); setEditor({ mode: "create" }); }}><FilePlus2 size={16} />New manual test</button>
          <button className="primary-button" onClick={runSelected} disabled={checked.size === 0 || busy !== null}><PlayCircle size={17} />Run selected</button>
        </div>
      </header>

      {!projects ? <section className="loading-state">Loading…</section> : <>
        <section className="toolbar" aria-label="Filters">
          <label className="search"><Search size={16} /><input placeholder="Search title, project, capability…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <SearchableSelect value={projectFilter} onChange={setProjectFilter} placeholder="All projects" ariaLabel="Project filter" options={visibleProjects.map((project) => ({ value: project.id, label: project.name }))} />
          <span className="brand-switch" role="group" aria-label="Repository provider">
            <button type="button" className={providerFilter === "" ? "seg on" : "seg"} onClick={() => setProviderFilter("")}>All</button>
            {providerOptions.map((provider) => (
              <button type="button" key={provider.value} className={providerFilter === provider.value ? "seg on " + provider.value.toLowerCase() : "seg " + provider.value.toLowerCase()} onClick={() => setProviderFilter(provider.value)} aria-pressed={providerFilter === provider.value}>
                {provider.value === "GITHUB" ? <GithubIcon size={13} /> : provider.value === "BITBUCKET" ? <BitbucketIcon size={13} /> : <GitlabIcon size={13} />}
                {provider.label}
              </button>
            ))}
          </span>
          <span className="view-toggle" role="group" aria-label="Layout">
            <button type="button" className={view === "table" ? "seg on" : "seg"} onClick={() => changeView("table")} aria-pressed={view === "table"}><LayoutList size={13} />Table</button>
            <button type="button" className={view === "grouped" ? "seg on" : "seg"} onClick={() => changeView("grouped")} aria-pressed={view === "grouped"}><Network size={13} />By module</button>
          </span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Status filter">
            <option value="">All statuses</option>
            {statusOptions.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
          </select>
          <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} aria-label="Category filter">
            <option value="">All categories</option>
            {categoryOptions.map((category) => <option key={category} value={category}>{categoryLabels[category]}</option>)}
          </select>
          <SearchableSelect value={moduleFilter} onChange={setModuleFilter} placeholder="All modules" ariaLabel="Module filter" options={classifications.modules.map((module) => ({ value: module.id, label: module.name }))} />
          <SearchableSelect value={tagFilter} onChange={setTagFilter} placeholder="All tags" ariaLabel="Tag filter" options={classifications.tags.map((tag) => ({ value: tag.id, label: tag.name }))} />
          {(projectFilter || providerFilter || statusFilter || categoryFilter || moduleFilter || tagFilter || search) && (
            <button className="text-button" onClick={() => { setProjectFilter(""); setProviderFilter(""); setStatusFilter(""); setCategoryFilter(""); setModuleFilter(""); setTagFilter(""); setSearch(""); }}><RotateCcw size={14} />Reset</button>
          )}
        </section>

        {checked.size > 0 && (
          <section className="bulk-bar" aria-label="Bulk actions">
            <strong>{checked.size} selected{checkedGroups.size > 1 ? ` across ${checkedGroups.size} projects` : ""}</strong>
            <button className="mini-button" onClick={() => bulkAction("approve")} disabled={busy !== null}><ThumbsUp size={14} />Approve</button>
            <button className="mini-button danger" onClick={() => bulkAction("reject")} disabled={busy !== null}><Ban size={14} />Reject</button>
            <button className="mini-button" onClick={() => bulkAction("archive")} disabled={busy !== null}><Archive size={14} />Archive</button>
            <button className="mini-button danger" onClick={bulkDelete} disabled={busy !== null}><Trash2 size={14} />Delete</button>
            <span className="bulk-sep" />
            <BulkClassify groups={[...checkedGroups]} classifications={classifications} onDone={() => reload()} disabled={busy !== null} />
            <button className="mini-button ghost" onClick={() => setChecked(new Set())}><X size={14} />Clear</button>
          </section>
        )}

        {!tests ? <section className="loading-state">Loading test cases…</section>
          : filtered.length === 0 ? <section className="empty-state"><h2>No matching tests</h2><p>Adjust the filters, or generate tests from a repository analysis.</p>{projects.length === 0 && <div><Link className="primary-button" href="/projects">Go to projects</Link></div>}</section>
          : view === "grouped" ? <ModuleGroups tests={filtered} collapsed={collapsed} setCollapsed={setCollapsed} checked={checked} setChecked={setChecked} busy={busy} onDetail={setDetail} onApprove={approveOne} onReject={rejectOne} onEdit={(test) => setEditor({ mode: "edit", test })} onDelete={deleteOne} allChecked={allChecked} onSelectAll={() => setChecked(allChecked ? new Set() : new Set(filtered.map((test) => test.id)))} />
          : <section className="library">
            <div className="library-head">
              <label className="check-all"><input type="checkbox" checked={allChecked} onChange={(event) => setChecked(event.target.checked ? new Set(filtered.map((test) => test.id)) : new Set())} />Select all</label>
              <span>Test</span><span>Status</span><span>Priority</span><span>Project</span><span>Classifications</span><span>Actions</span>
            </div>
            {filtered.map((test) => (
              <article className="library-row" key={test.id}>
                <label><input type="checkbox" checked={checked.has(test.id)} onChange={(event) => {
                  const next = new Set(checked);
                  if (event.target.checked) next.add(test.id); else next.delete(test.id);
                  setChecked(next);
                }} /></label>
                <button className="test-title" onClick={() => setDetail(test)}>
                  <strong>{test.title}</strong>
                  <small>{[test.capability, test.category ? categoryLabels[test.category] ?? test.category : null, test.route].filter(Boolean).join(" · ")}{test.source === "MANUAL" ? " · manual" : ` · v${test.version}`}</small>
                </button>
                <span className={`status ${statusClass(test.status)}`}>{statusLabels[test.status] ?? test.status}</span>
                <span className={`priority ${test.priority.toLowerCase()}`}>{test.priority}</span>
                <span className="project-cell">
                  <span className="project-cell-name"><FolderKanban size={12} />{test.projectName ?? projectNameOf(test.projectId)}</span>
                  {test.provider && <span className={`provider-badge ${test.provider.toLowerCase()}`}>{test.provider === "GITHUB" ? <GithubIcon size={10} /> : test.provider === "BITBUCKET" ? <BitbucketIcon size={10} /> : <GitlabIcon size={10} />}{providerLabels[test.provider] ?? test.provider}</span>}
                </span>
                <span className="chips">
                  {test.modules.map((entry) => <span className="chip module" key={entry.module.id}><Layers size={11} />{entry.module.name}</span>)}
                  {test.tags.map((entry) => <span className="chip tag" key={entry.tag.id}><Tag size={11} />{entry.tag.name}</span>)}
                  {test.modules.length + test.tags.length === 0 && <small className="dim">—</small>}
                </span>
                <span className="row-actions">
                  {test.status !== "APPROVED" && <button className="mini-button" title="Approve" onClick={() => approveOne(test)} disabled={busy !== null}><ThumbsUp size={13} /></button>}
                  {test.status !== "REJECTED" && test.status !== "ARCHIVED" && <button className="mini-button danger" title="Reject" onClick={() => rejectOne(test)} disabled={busy !== null}><Ban size={13} /></button>}
                  <button className="mini-button ghost" title="Edit (creates a new version)" onClick={() => setEditor({ mode: "edit", test })} disabled={busy !== null}><Pencil size={13} /></button>
                  <button className="mini-button danger" title="Delete" onClick={() => deleteOne(test)} disabled={busy !== null}><Trash2 size={13} /></button>
                </span>
              </article>
            ))}
          </section>}

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
        onError={(message) => notify(message, "error")}
      />}

      {detail && <TestDetail test={detail} onClose={() => setDetail(null)} />}

      {pendingRun && (
        <RunEnvironmentModal
          projectId={pendingRun.projectId}
          onClose={() => setPendingRun(null)}
          onReady={(envId) => {
            const run = pendingRun;
            setPendingRun(null);
            void act("run", () => api(`/v1/projects/${run.projectId}/executions`, { method: "POST", body: { testCaseIds: run.ids, environmentId: envId } }), `${run.ids.length} approved tests queued for execution.`).then(() => setChecked(new Set()));
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

      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
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
            <select value={moduleId} onChange={(event) => setModuleId(event.target.value)}>
              <option value="">— none —</option>
              {classifications.modules.map((module) => <option key={module.id} value={module.id}>{module.name}</option>)}
            </select>
          </label>
          <label>Add tag
            <select value={tagId} onChange={(event) => setTagId(event.target.value)}>
              <option value="">— none —</option>
              {classifications.tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
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
          <p className="eyebrow">ORGANIZE</p>
          <h2>Modules &amp; tags</h2>
          <small className="dim">Groupings you own \u2014 preserved across AI regeneration. Deleting never deletes tests.</small>
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
            <span className="module-count gold">{counts.get(tag.id) ?? 0} tests</span>
            <button className="mini-button danger" aria-label={"Delete tag " + tag.name} onClick={() => void remove("tag", tag.id, tag.name)}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </>
  );
}

function ModuleGroups({ tests, collapsed, setCollapsed, checked, setChecked, busy, onDetail, onApprove, onReject, onEdit, onDelete, allChecked, onSelectAll }: {
  tests: TestRow[];
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
                  <div className="module-row" key={group.key + "-" + test.id}>
                    <label><input type="checkbox" checked={checked.has(test.id)} onChange={(event) => {
                      setChecked((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(test.id); else next.delete(test.id);
                        return next;
                      });
                    }} /></label>
                    <button className="test-title" onClick={() => onDetail(test)}>
                      <strong>{test.title}</strong>
                      <small>{[test.capability, test.category ? categoryLabels[test.category] ?? test.category : null].filter(Boolean).join(" · ")}</small>
                    </button>
                    <span className={"status " + statusClass(test.status)}>{statusLabels[test.status] ?? test.status}</span>
                    <span className={"priority " + test.priority.toLowerCase()}>{test.priority}</span>
                    <span className="row-actions">
                      {test.status !== "APPROVED" && <button className="mini-button" title="Approve" onClick={() => onApprove(test)} disabled={busy !== null}><ThumbsUp size={13} /></button>}
                      {test.status !== "REJECTED" && test.status !== "ARCHIVED" && <button className="mini-button danger" title="Reject" onClick={() => onReject(test)} disabled={busy !== null}><Ban size={13} /></button>}
                      <button className="mini-button ghost" title="Edit" onClick={() => onEdit(test)} disabled={busy !== null}><Pencil size={13} /></button>
                      <button className="mini-button danger" title="Delete" onClick={() => onDelete(test)} disabled={busy !== null}><Trash2 size={13} /></button>
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
  const [recording, setRecording] = useState<{ sessionId: string; count: number } | null>(null);
  const [recordingStarting, setRecordingStarting] = useState(false);
  const [regionPicker, setRegionPicker] = useState<{ index: number } | null>(null);

  async function startRecording() {
    if (recordingStarting || recording) return;
    setRecordingStarting(true);
    setAiError("");
    try {
      const envs = await api<Array<{ id: string; url: string; isDefault: boolean }>>(`/v1/projects/${projectId}/environments`);
      const env = envs.find((e) => e.isDefault) ?? envs[0];
      if (!env) { onError("Add an environment first - the recorder needs your app URL."); return; }
      const result = await api<{ sessionId: string }>(`/v1/projects/${projectId}/recordings`, { method: "POST", body: { url: env.url } });
      setRecording({ sessionId: result.sessionId, count: 0 });
      const poll = window.setInterval(async () => {
        try {
          const data = await api<{ count: number }>(`/v1/projects/${projectId}/recordings/${result.sessionId}`);
          setRecording((current) => (current ? { ...current, count: data.count } : current));
        } catch { window.clearInterval(poll); }
      }, 2000);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to start the recorder");
    } finally {
      setRecordingStarting(false);
    }
  }

  async function stopRecording() {
    if (!recording) return;
    try {
      const result = await api<{ events: Array<{ action: string; target: string; value?: string }> }>(`/v1/projects/${projectId}/recordings/${recording.sessionId}/stop`, { method: "POST" });
      const imported = result.events
        .filter((e) => ["click", "fill", "select"].includes(e.action))
        .map((e) => ({ action: e.action as StepDto["action"], target: e.target, value: e.value }));
      if (imported.length) {
        setSteps(imported);
        onError(`${imported.length} steps imported - review, edit targets if needed, then save.`);
      } else {
        onError("No steps were captured - click through the flow in the opened browser.", "error");
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
            <p className="eyebrow">{mode === "create" ? "NEW MANUAL TEST" : `EDIT · NEW VERSION AFTER v${test!.version}`}</p>
            <h2>{mode === "create" ? "Create test case" : test!.title}</h2>
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
            <select value={category} onChange={(event) => setCategory(event.target.value)}>{categoryOptions.map((option) => <option key={option} value={option}>{categoryLabels[option]}</option>)}</select>
            <small className="field-hint">Not sure? Use <strong>Happy path</strong> for normal flows, <strong>Validation</strong> for form/input checks.</small>
          </label>
            <label><span className="label-row">Priority <InfoTooltip label="What does priority mean?">
              <strong>How badly does it hurt when this test fails?</strong>
              <em>CRITICAL</em> — core business flow; a failure should block release.
              <em>HIGH</em> — important feature; fix immediately.
              <em>MEDIUM</em> — normal coverage; fix in the current cycle.
              <em>LOW</em> — cosmetic or rare paths.
            </InfoTooltip></span>
            <select value={priority} onChange={(event) => setPriority(event.target.value)}>{priorityOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select>
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
              {!recording ? (
                <>
                  <button type="button" className="record-btn" disabled={recordingStarting} onClick={() => void startRecording()}>
                    <CircleDot size={14} /> {recordingStarting ? "Opening browser..." : "Record steps in a browser"}
                  </button>
                  <small className="record-hint">Opens your app in a browser - click through the flow and every action is captured as a step. Passwords are masked as {'{{password}}'}.</small>
                </>
              ) : (
                <>
                  <span className="record-live"><span className="record-dot" /> Recording - {recording.count} step{recording.count === 1 ? "" : "s"} captured. Perform the flow in the opened browser, then stop.</span>
                  <button type="button" className="mini-button danger" onClick={async () => {
                    setRecording(null);
                    try {
                      const result = await api<{ events: Array<{ action: string; target: string; value?: string }> }>(`/v1/projects/${projectId}/recordings/${recording.sessionId}/stop`, { method: "POST" });
                      const imported = result.events.filter((e) => ["click", "fill", "select"].includes(e.action) && (e.target ?? "").trim() !== "" && e.target.trim() !== "css:").map((e) => ({ action: e.action as StepDto["action"], target: e.target, value: e.value }));
                      if (imported.length) { setSteps(imported); onError(`${imported.length} steps imported - review and save.`, "success"); }
                      else onError("No steps captured.", "error");
                    } catch (error) { onError(error instanceof Error ? error.message : "Stop failed", "error"); }
                  }}>Stop &amp; import</button>
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
                <select value={step.action} onChange={(event) => updateStep(index, { action: event.target.value })} aria-label={`Step ${index + 1} action`}>
                  {["navigate", "click", "fill", "select", "upload", "assert", "waitFor", "wait", "screenshot", "capture", "assertColor", "assertData"].map((action) => <option key={action} value={action}>{action === "waitFor" ? "waitFor (text)" : action === "wait" ? "wait (seconds)" : action === "assertColor" ? "assert color" : action === "assertData" ? "assert data" : action === "capture" ? "capture (variable)" : action}</option>)}
                </select>
                <input value={step.target} onChange={(event) => updateStep(index, { target: event.target.value })} placeholder={step.action === "navigate" ? "/route" : step.action === "wait" ? "Seconds (e.g. 5)" : step.action === "screenshot" ? "Frame name (e.g. before-flip)" : step.action === "capture" ? "Regex with one group" : step.action === "assertColor" ? "Canvas selector (optional)" : step.action === "assertData" ? "API URL — {{query:name}} supported" : step.action === "assert" && step.condition === "visual" ? "Describe what should be true on screen" : "Visible text or label"} aria-label={`Step ${index + 1} target`} />
                {(step.action === "fill" || step.action === "select" || step.action === "upload" || (step.action === "assert" && step.condition === "visual") || step.action === "assertColor" || step.action === "assertData" || step.action === "capture") && (
                  <input value={step.value ?? ""} onChange={(event) => updateStep(index, { value: event.target.value })} placeholder={step.action === "fill" ? "e.g. {{username}}" : step.action === "assertColor" ? "#0d5ea0" : step.action === "assertData" ? "0.configuration.body == #0d5ea0" : step.action === "capture" ? "Variable name (e.g. designNumber)" : step.action === "assert" ? "Reference frame name (optional)" : "Value"} aria-label={`Step ${index + 1} value`} />
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
                  <select value={step.condition ?? "visible"} onChange={(event) => updateStep(index, { condition: event.target.value })} aria-label={`Step ${index + 1} condition`}>
                    {["visible", "hidden", "contains", "equals", "urlMatches", "visual"].map((condition) => <option key={condition} value={condition}>{condition === "visual" ? "AI visual check" : condition}</option>)}
                  </select>
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
      const result = await api<{ sessionId: string }>(`/v1/projects/${projectId}/recordings`, { method: "POST", body: { url: env.url } });
      setSession(result.sessionId);
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
        <header><div><p className="eyebrow">Region picker</p><h2>Drag a rectangle over the area to check</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
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

function TestDetail({ test, onClose }: { test: TestRow; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <header><div><p className="eyebrow">{statusLabels[test.status]} · {test.source === "MANUAL" ? "MANUAL" : `AI · v${test.version}`}</p><h2>{test.title}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
        <div className="modal-body">
          <dl className="detail-grid">
            <div><dt>Project</dt><dd>{test.projectName ?? "—"}</dd></div>
            <div><dt>Capability</dt><dd>{test.capability ?? "—"}</dd></div>
            <div><dt>Category</dt><dd>{test.category ? categoryLabels[test.category] ?? test.category : "—"}</dd></div>
            <div><dt>Priority</dt><dd>{test.priority}</dd></div>
            <div><dt>Confidence</dt><dd>{test.confidence != null ? `${Math.round(test.confidence * 100)}%` : "—"}</dd></div>
            <div><dt>Route</dt><dd>{test.route ?? "—"}</dd></div>
            <div><dt>Created</dt><dd>{fmtRelative(test.createdAt)}</dd></div>
            {test.generatedFromCommit && <div><dt>Generated from</dt><dd><code>{test.generatedFromCommit.slice(0, 7)}</code></dd></div>}
            {test.lastValidatedCommit && <div><dt>Last validated</dt><dd><code>{test.lastValidatedCommit.slice(0, 7)}</code></dd></div>}
          </dl>
          {test.definition?.preconditions?.length ? <><h3 className="modal-subhead">Preconditions</h3><ul className="pre-list">{test.definition.preconditions.map((line, index) => <li key={index}>{line}</li>)}</ul></> : null}
          <h3 className="modal-subhead">Steps</h3>
          <ol className="step-list">
            {(test.definition?.steps ?? []).map((step, index) => (
              <li key={index}><code>{step.action}</code> {step.target}{step.value ? <> → <strong>{step.value}</strong></> : null}{step.condition ? <small> ({step.condition})</small> : null}</li>
            ))}
          </ol>
          <h3 className="modal-subhead">Expected result</h3>
          <p className="expected">{test.definition?.expectedResult ?? "—"}</p>
        </div>
        <footer><button className="primary-button" onClick={onClose}>Close</button></footer>
      </div>
    </div>
  );
}

export default function TestCasesPage() {
  return <Suspense><TestCasesInner /></Suspense>;
}
