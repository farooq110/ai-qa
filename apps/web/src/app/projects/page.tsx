"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Bot, Check, Clock3, FolderGit2, FolderTree, GitBranch, Loader2, Map as MapIcon, Plus, Search, SearchCode, Server, Trash2, X } from "lucide-react";
import { BitbucketIcon, GithubIcon, GitlabIcon } from "@/components/brand-icons";
import { AppShell } from "@/components/app-shell";
import { ImportRepositoryModal } from "@/components/import-repository-modal";
import { RouteMapModal } from "@/components/route-map-modal";
import { analysisOutcome, api, fmtDay, shortSha, type AnalysisRunDto, type ProjectSummaryDto } from "@/lib/api";
import { can, requireSubscription, useElapsed, useMe, useToast } from "@/lib/hooks";
import { PERMISSIONS } from "@ai-qa/domain";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Provider = "all" | "github" | "bitbucket" | "gitlab";
const providerLabels: Record<Exclude<Provider, "all">, string> = { github: "GitHub", bitbucket: "Bitbucket", gitlab: "GitLab" };
type Project = ProjectSummaryDto;
interface ConnectionDto { id: string; provider: string; }
type AnalysisRun = Pick<AnalysisRunDto, "branch" | "status" | "completedAt"> & Partial<AnalysisRunDto>;
interface TestCounts { total: number; review: number; heldOut: number; approved: number }
const isAnalysisRunning = (run?: AnalysisRun) => run?.status === "RUNNING" || run?.status === "QUEUED";

interface GenerationRunDto { id: string; mode: string; status: string; created: number | null; duplicatesSkipped: number | null; errorMessage: string | null; createdAt: string; completedAt: string | null; report?: { planned?: number; generated?: number; verified?: number; heldOut?: number } | null; }

const providerFor = (project: Project) => project.provider.toLowerCase() as Exclude<Provider, "all">;

export default function ProjectsPage() {
  const me = useMe();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [filter, setFilter] = useState<Provider>("all");
  const [search, setSearch] = useState("");
  const { toast, notify, dismiss } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [analysisByProject, setAnalysisByProject] = useState<Record<string, AnalysisRun[]>>({});
  const [genByProject, setGenByProject] = useState<Record<string, GenerationRunDto>>({});
  const [counts, setCounts] = useState<Record<string, TestCounts>>({});
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  const prevGenStatus = useRef<Record<string, string>>({});
  const prevAnalysisStatus = useRef<Record<string, string>>({});
  // ponytail: age-based guess; whole-app spec generation (draft, verify, repair, verify) runs for hours. Track a heartbeat if dead runs must show sooner.
  const STALE_MS = 6 * 60 * 60 * 1000;
  const token = typeof window === "undefined" ? null : window.localStorage.getItem("proofline.accessToken");

  // Buttons are gated on the organization's connected accounts (Settings →
  // Connected accounts), not on the repository's provider alone.
  // Return trip from a connect started inside the import modal: reopen it so the user lands on the repo list.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (!connected) return;
    const label = providerLabels[params.get("provider") as Exclude<Provider, "all">] ?? "Account";
    if (connected === "pending") notify(`${label} installation requested. An owner of that ${label} organization must approve it before its repositories appear.`, "success");
    else setShowModal(true);
    window.history.replaceState({}, "", "/projects");
  }, [notify]);

  useEffect(() => {
    if (!token) return;
    fetch(`${apiUrl}/v1/repository-connections`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.ok ? response.json() as Promise<ConnectionDto[]> : Promise.reject())
      .then((connections) => setConnectedProviders(connections.map((connection) => connection.provider.toLowerCase())))
      .catch(() => undefined);
  }, [token]);

  useEffect(() => {
    if (!token) { window.location.assign("/signin"); return; }
    fetch(`${apiUrl}/v1/projects`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.ok ? response.json() as Promise<Project[]> : Promise.reject())
      .then(async (loadedProjects) => {
        setProjects(loadedProjects);
      })
      .catch(() => notify("Unable to load projects. Please sign in again.", "error"));
  }, [token, notify]);

  const loadCounts = useCallback(async () => {
    if (!token) return;
    try {
      const rows = await fetch(`${apiUrl}/v1/test-cases`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json() as Promise<Array<{ projectId: string; status: string }>> : Promise.reject()));
      const next: Record<string, TestCounts> = {};
      for (const row of rows) {
        const entry = next[row.projectId] ??= { total: 0, review: 0, heldOut: 0, approved: 0 };
        entry.total += 1;
        if (row.status === "PENDING_REVIEW") entry.review += 1;
        else if (row.status === "NEEDS_REVIEW") entry.heldOut += 1;
        else if (row.status === "APPROVED") entry.approved += 1;
      }
      setCounts(next);
    } catch { /* counts are cosmetic */ }
  }, [token]);

  // Generation status is server-authoritative: poll the runs so navigating away
  // (or reloading) never loses "generating" state, and completing runs surface
  // a persistent notice with the real created count.
  const refreshGenerations = useCallback(async () => {
    if (!token || !projects.length) return;
    const entries = await Promise.all(projects.map(async (project) => {
      try {
        const runs = await fetch(`${apiUrl}/v1/projects/${project.id}/generations`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json() as Promise<GenerationRunDto[]> : []));
        return [project.id, runs[0] ?? null, project.name] as const;
      } catch { return [project.id, null, project.name] as const; }
    }));
    const map: Record<string, GenerationRunDto> = {};
    for (const [projectId, run, projectName] of entries) {
      if (!run) continue;
      map[projectId] = run;
      const before = prevGenStatus.current[projectId];
      if (before === "RUNNING" && run.status === "COMPLETED") {
        notify(`${projectName}: ${run.created ?? 0} test cases generated — review them under Test cases.`, "success");
        void loadCounts();
      } else if (before === "RUNNING" && run.status === "FAILED") {
        notify(`${projectName}: generation failed — ${run.errorMessage ?? "unknown error"}.`, "error");
      }
      prevGenStatus.current[projectId] = run.status;
    }
    setGenByProject(map);
  }, [projects, token, loadCounts, notify]);

  // Analysis status is server-authoritative too: reloading or leaving the page never loses "analyzing".
  const refreshAnalyses = useCallback(async () => {
    if (!token || !projects.length) return;
    const entries = await Promise.all(projects.map(async (project) => {
      const runs = await fetch(`${apiUrl}/v1/projects/${project.id}/analysis`, { headers: { Authorization: `Bearer ${token}` } })
        .then((response) => response.ok ? response.json() as Promise<AnalysisRunDto[]> : null).catch(() => null);
      return [project, runs] as const;
    }));
    const map: Record<string, AnalysisRunDto[]> = {};
    for (const [project, runs] of entries) {
      if (!runs) continue;
      map[project.id] = runs;
      const latest = runs.find((run) => run.branch === project.defaultBranch);
      if (!latest) continue;
      const before = prevAnalysisStatus.current[project.id];
      if (before === "RUNNING" || before === "QUEUED") {
        if (latest.status === "COMPLETED") {
          notify(analysisOutcome(project.name, latest), "success");
        } else if (latest.status === "FAILED") {
          notify(`${project.name}: analysis failed — ${latest.errorMessage ?? "ensure the repository provider is connected in Settings"}.`, "error");
        }
      }
      prevAnalysisStatus.current[project.id] = latest.status;
    }
    setAnalysisByProject((current) => ({ ...current, ...map }));
  }, [projects, token, notify]);

  const anyAnalysisRunning = Object.values(analysisByProject).some((runs) => isAnalysisRunning(runs[0]));
  useEffect(() => {
    void refreshAnalyses();
    if (!anyAnalysisRunning) return;
    const timer = window.setInterval(() => { void refreshAnalyses(); }, 4000);
    return () => window.clearInterval(timer);
  }, [refreshAnalyses, anyAnalysisRunning]);

  useEffect(() => {
    void refreshGenerations();
    void loadCounts();
    const timer = window.setInterval(() => { void refreshGenerations(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshGenerations, loadCounts]);

  const isServerGenerating = (projectId: string) => {
    const run = genByProject[projectId];
    return Boolean(run && run.status === "RUNNING" && Date.now() - new Date(run.createdAt).getTime() < STALE_MS);
  };

  const visibleProjects = projects.filter((project) => {
    const matchesFilter = filter === "all" || providerFor(project) === filter;
    const value = `${project.name} ${project.repoFullName}`.toLowerCase();
    return matchesFilter && value.includes(search.toLowerCase());
  });

  function imported(project: Project) {
    setProjects((current) => [project, ...current]);
    setConnectedProviders((current) => current.includes(providerFor(project)) ? current : [...current, providerFor(project)]);
    setShowModal(false);
    notify(`${project.name} imported. Analyze ${project.defaultBranch} to begin generating tests.`, "success");
  }

  async function deleteProject(project: Project) {
    if (!window.confirm(`Disconnect ${project.name}? This permanently removes its test cases and execution history.`)) return;
    const response = await fetch(`${apiUrl}/v1/projects/${project.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) { notify("Unable to delete project. Only organization admins can delete projects.", "error"); return; }
    setProjects((current) => current.filter((item) => item.id !== project.id));
    notify(`${project.name} was removed from this organization.`, "success");
  }

  async function saveBackendDirectories(project: Project, value: string) {
    try {
      const updated = await api<Project>(`/v1/projects/${project.id}`, { method: "PATCH", body: { backendDirectories: value } });
      setProjects((current) => current.map((item) => item.id === project.id ? updated : item));
      notify("Backend directories saved. Re-run Analyze to read them.", "success");
      return true;
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Unable to save backend directories", "error");
      return false;
    }
  }

  async function analyze(project: Project) {
    if (requireSubscription(me)) return;
    setBusyId(`analyze-${project.id}`);
    setBusySince(Date.now());
    try {
      const queued = await api<{ id: string }>(`/v1/projects/${project.id}/analysis?branch=${encodeURIComponent(project.defaultBranch)}`, { method: "POST" });
      // Newest first, like the server's list; polling takes over from here and reports the result.
      prevAnalysisStatus.current[project.id] = "RUNNING";
      setAnalysisByProject((current) => ({ ...current, [project.id]: [{ id: queued.id, branch: project.defaultBranch, status: "RUNNING", completedAt: null, createdAt: new Date().toISOString() }, ...(current[project.id] ?? [])] }));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Analysis failed. Ensure the repository provider is connected in Settings.", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function generate(project: Project) {
    if (requireSubscription(me)) return;
    setBusyId(`generate-${project.id}`);
    setBusySince(Date.now());
    try {
      // Drafting + dry-run verification run in the background (apps/workers): this only queues
      // the run. serverGenerating (from the 5s refreshGenerations poll) carries the UI from here;
      // set it optimistically so there is no gap between busyId clearing and the first poll tick.
      const queued = await api<{ generationId: string }>(`/v1/projects/${project.id}/generations/candidates`, { method: "POST" });
      setGenByProject((current) => ({ ...current, [project.id]: { id: queued.generationId, mode: "INCREMENTAL", status: "RUNNING", created: null, duplicatesSkipped: null, errorMessage: null, createdAt: new Date().toISOString(), completedAt: null } }));
      notify("Generation started — drafting candidates and verifying them against the live app. This can take a few minutes.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Generate tests failed. Analyze the repository first.", "error");
    } finally {
      setBusyId(null);
    }
    void refreshGenerations();
    void loadCounts();
  }

  const [testCount, setTestCount] = useState<number | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch(`${apiUrl}/v1/test-cases`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.ok ? response.json() as Promise<unknown[]> : Promise.reject())
      .then((rows) => setTestCount(rows.length))
      .catch(() => undefined);
  }, [token]);

  const analyzedCount = projects.filter((project) => (analysisByProject[project.id] ?? []).some((analysis) => analysis.branch === project.defaultBranch && analysis.status === "COMPLETED")).length;

  return <AppShell activePath="/projects"><section className="projects-dashboard">
    <header className="page-header">
      <div><h1>Projects</h1><p className="muted">{projects.length} repositor{projects.length === 1 ? "y" : "ies"} · {analyzedCount} analyzed{testCount != null ? ` · ${testCount} test cases` : ""}</p></div>
      {can(me, PERMISSIONS.PROJECTS_CREATE) && <button className="primary-button" onClick={() => { if (!requireSubscription(me)) setShowModal(true); }}><Plus size={14} />Import repository</button>}
    </header>

    <section className="toolbar">
      <label className="search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by project or repository…" aria-label="Search projects" /></label>
      <span className="brand-switch" role="group" aria-label="Provider">{(["all", "github", "bitbucket", "gitlab"] as Provider[]).map((provider) => <button key={provider} type="button" className={filter === provider ? "seg on" : "seg"} aria-pressed={filter === provider} onClick={() => setFilter(provider)}>{provider === "github" && <GithubIcon size={13} />}{provider === "bitbucket" && <BitbucketIcon size={13} />}{provider === "gitlab" && <GitlabIcon size={13} />}{provider === "all" ? "All" : providerLabels[provider]}</button>)}</span>
    </section>

    {toast && <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      {toast.tone === "error" ? <AlertCircle size={15} /> : <Check size={15} />}
      <span>{toast.message}</span>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={dismiss}><X size={13} /></button>
    </div>}
    <section className="project-cards">{visibleProjects.length ? visibleProjects.map((project) => <ProjectCard key={project.id} project={project} analyses={analysisByProject[project.id] ?? []} busyId={busyId} busySince={busySince} generation={genByProject[project.id]} testCount={counts[project.id]} serverGenerating={isServerGenerating(project.id)} connectedProviders={connectedProviders} onAnalyze={analyze} onGenerate={generate} onDelete={deleteProject} onSaveBackend={can(me, PERMISSIONS.PROJECTS_EDIT) ? saveBackendDirectories : undefined} />) : <div className="project-empty"><FolderGit2 size={22} /><h2>{projects.length ? "No projects match" : "No projects yet"}</h2><p>{projects.length ? "Try another provider or search term." : "Import a repository to analyze it and draft reviewable tests."}</p></div>}</section>

    {showModal && <ImportRepositoryModal canConnect={can(me, PERMISSIONS.SETTINGS_MANAGE)} onClose={() => setShowModal(false)} onImported={imported} />}
  </section></AppShell>;
}

const getProviderIcon = (provider: "github" | "bitbucket" | "gitlab") => {
  if (provider === "github") return <GithubIcon size={13} />
  if (provider === "bitbucket") return <BitbucketIcon size={13} />
  if (provider === "gitlab") return <GitlabIcon size={13} />
}

function ProjectCard({ project, analyses, busyId, busySince, generation, testCount, serverGenerating, connectedProviders, onAnalyze, onGenerate, onDelete, onSaveBackend }: { project: Project; analyses: AnalysisRun[]; busyId: string | null; busySince: number | null; generation?: GenerationRunDto; testCount?: TestCounts; serverGenerating: boolean; connectedProviders: string[]; onAnalyze: (project: Project) => void; onGenerate: (project: Project) => void; onDelete: (project: Project) => void; onSaveBackend?: (project: Project, value: string) => Promise<boolean> }) {
  const [editingBackend, setEditingBackend] = useState(false);
  const backendLabel = project.backendDirectories?.length ? project.backendDirectories.join(", ") : "no backend";
  const me = useMe();
  const [routeMapOpen, setRouteMapOpen] = useState(false);
  const provider = providerFor(project);
  const branchRuns = analyses.filter((analysis) => analysis.branch === project.defaultBranch);
  const latestRun = branchRuns[0];
  const lastGood = branchRuns.find((analysis) => analysis.status === "COMPLETED");
  const analyzed = Boolean(lastGood);
  const model = lastGood?.knowledgeModel;
  const lastAnalyzedAt = lastGood?.completedAt ?? lastGood?.createdAt;
  const pagesLinked = model?.codeLinks;
  const crawled = model?.routeSummary;
  const featureCount = model?.flowSpecs?.length;
  const endpointCount = model?.endpoints?.length;
  const report = generation?.report;
  const generatedBefore = generation && generation.status === "COMPLETED" && report;
  const analyzing = busyId === `analyze-${project.id}` || isAnalysisRunning(latestRun);
  const generating = busyId === `generate-${project.id}` || serverGenerating;
  const genStale = generation?.status === "RUNNING" && !serverGenerating;
  const analysisSince = latestRun?.createdAt ? new Date(latestRun.createdAt).getTime() : busySince;
  const generationSince = serverGenerating && generation ? new Date(generation.createdAt).getTime() : busySince;
  const analysisElapsed = useElapsed(analysisSince, analyzing);
  const generationElapsed = useElapsed(generationSince, generating);
  const connected = connectedProviders.includes(provider);
  const connectHint = `Connect ${providerLabels[provider]} in Settings → Repository providers to enable this.`;
  const analyzeDisabled = !connected || analyzing || generating;
  const generateDisabled = !connected || !analyzed || analyzing || generating;
  const analyzeTooltip = !connected ? connectHint : undefined;
  const generateTooltip = !connected ? connectHint : !analyzed ? "Analyze the repository before generating test cases." : undefined;
  
  return <article className="project-card">
    <div className="project-card-main">
      <div className="project-title">
        <span className="provider-badge">{getProviderIcon(provider)}{providerLabels[provider]}</span>
        <h2>{project.name}</h2>
      </div>
      <div className="project-meta">
        <a className="project-url" href={project.repositoryUrl} target="_blank" rel="noreferrer" title={project.repositoryUrl}>{project.repoFullName}</a>
        {project.rootDirectory && <span title="Root directory"><FolderTree size={12} />{project.rootDirectory}</span>}
        {editingBackend && onSaveBackend
          ? <form className="backend-edit" onSubmit={async (event) => { event.preventDefault(); const value = String(new FormData(event.currentTarget).get("backendDirectories") ?? ""); if (await onSaveBackend(project, value)) setEditingBackend(false); }}>
              <Server size={12} /><input name="backendDirectories" defaultValue={project.backendDirectories?.join(", ") ?? ""} placeholder="api, services/orders" aria-label="Backend directories" autoFocus onKeyDown={(event) => { if (event.key === "Escape") setEditingBackend(false); }} />
              <button type="submit" className="mini-button" aria-label="Save backend directories"><Check size={12} /></button>
              <button type="button" className="mini-button ghost" aria-label="Cancel" onClick={() => setEditingBackend(false)}><X size={12} /></button>
            </form>
          : onSaveBackend
            ? <button type="button" className="backend-chip" title="Backend directories analysis reads for API endpoints and server rules. Click to edit." onClick={() => setEditingBackend(true)}><Server size={12} />{backendLabel}</button>
            : project.backendDirectories?.length ? <span title="Backend directories"><Server size={12} />{backendLabel}</span> : null}
        <span><GitBranch size={12} />{project.defaultBranch}</span>
        {analyzing
          ? <span className="status-live"><Loader2 size={12} className="spin" />{analyzed ? "re-analyzing" : "analyzing"}{analysisElapsed ? ` · ${analysisElapsed}` : ""}</span>
          : latestRun?.status === "FAILED"
            ? <span className="gen-failed" title={analyzed ? "The latest run failed; the previous analysis is still in use." : undefined}><AlertCircle size={12} />analysis failed{analyzed ? " · using previous" : ""}</span>
            : <span className={analyzed ? "state-done" : undefined} title={analyzed ? `Analyzed ${new Date(lastAnalyzedAt ?? "").toLocaleString()}${lastGood?.commitSha ? ` at commit ${shortSha(lastGood.commitSha)}` : ""}` : undefined}><Clock3 size={12} />{analyzed ? `Analyzed ${fmtDay(lastAnalyzedAt)}` : "ready to analyze"}</span>}
        {generating
          ? <span className="status-live"><Loader2 size={12} className="spin" />Generating tests{generationElapsed ? ` · ${generationElapsed}` : ""}</span>
          : genStale || generation?.status === "FAILED"
            ? <span className="gen-failed"><Bot size={12} />{genStale ? "generation timed out" : "generation failed"}</span>
            : null}
      </div>
      {analyzed && <div className="project-stats">
        {crawled && <span title="Pages the live crawl opened, out of all routes found in the code and the app"><MapIcon size={12} />{crawled.verified} of {crawled.total} routes crawled</span>}
        {pagesLinked && <span className={pagesLinked.unlinked.length ? "warn" : undefined} title={pagesLinked.unlinked.length ? `No source file found for: ${pagesLinked.unlinked.join(", ")}. These pages get no generated tests.` : "Every crawled page was matched to its source file."}><FolderTree size={12} />{pagesLinked.linked} of {pagesLinked.pages} pages linked to code</span>}
        {featureCount != null && <span title="Features described from the code: the basis of generated tests"><SearchCode size={12} />{featureCount} feature{featureCount === 1 ? "" : "s"}{endpointCount != null ? ` · ${endpointCount} endpoints` : ""}</span>}
        {generatedBefore && <span title={`${report.planned ?? 0} scenarios planned, ${report.generated ?? 0} drafted, ${report.verified ?? 0} verified against the live app, ${report.heldOut ?? 0} held out for review`}><Bot size={12} />generated {fmtDay(generation.completedAt ?? generation.createdAt)} · {report.generated ?? 0} drafted · {report.verified ?? 0} verified{report.heldOut ? ` · ${report.heldOut} held out` : ""}</span>}
      </div>}
    </div>
    <div className="project-card-actions">
      <div className="test-count">
        <small>test cases</small>
        <strong>{testCount != null ? testCount.total : "–"}</strong>
        {testCount != null && (testCount.review > 0 || testCount.heldOut > 0 || testCount.approved > 0) && <small title="Pending review · held out by verification · approved">{[testCount.review && `${testCount.review} to review`, testCount.heldOut && `${testCount.heldOut} held out`, testCount.approved && `${testCount.approved} approved`].filter(Boolean).join(" · ")}</small>}
      </div>
      <div className="project-buttons">
        {analyzed && <button className="analyze-button" title="Pages found in the live app" onClick={() => setRouteMapOpen(true)}><MapIcon size={13} />Routes</button>}
        <span className="generate-tooltip" data-tooltip={analyzeTooltip}>
          {can(me, PERMISSIONS.TEST_CASES_CREATE) && <button className="analyze-button" disabled={analyzeDisabled} onClick={() => onAnalyze(project)}>
            <SearchCode size={13} />{analyzing ? "Analyzing…" : "Analyze"}</button>}
        </span>
        <span className="generate-tooltip" data-tooltip={generateTooltip}>{can(me, PERMISSIONS.TEST_CASES_CREATE) && <button className="generate-button" disabled={generateDisabled} onClick={() => onGenerate(project)}>
          <Bot size={13} />{generating ? "Generating…" : "Generate tests"}</button>}
        </span>{can(me, PERMISSIONS.PROJECTS_DELETE) && <button className="delete-project" aria-label={`Delete ${project.name}`} title="Delete project" onClick={() => onDelete(project)}><Trash2 size={14} /></button>}</div>
    </div>
    {(analyzing || generating) && <div className="project-progress" role="progressbar" aria-label={analyzing ? "Analyzing repository" : "Generating tests"}><span /></div>}
  {routeMapOpen && <RouteMapModal projectId={project.id} projectName={project.name} canEdit={can(me, PERMISSIONS.TEST_CASES_CREATE)} onClose={() => setRouteMapOpen(false)} />}
  </article>;
}
