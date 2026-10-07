"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Clock3, FolderGit2,   Plus, Search, SearchCode, TestTube2, Trash2, X } from "lucide-react";
import { BitbucketIcon, GithubIcon, GitlabIcon } from "@/components/brand-icons";
import { AppShell } from "@/components/app-shell";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Provider = "all" | "github" | "bitbucket" | "gitlab";
const providerLabels: Record<Exclude<Provider, "all">, string> = { github: "GitHub", bitbucket: "Bitbucket", gitlab: "GitLab" };
interface Project { id: string; name: string; repositoryUrl: string; defaultBranch: string; }
interface ConnectionDto { id: string; provider: string; }
interface AnalysisRun { branch: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"; completedAt: string | null; }
interface GenerationRunDto { id: string; mode: string; status: string; created: number | null; duplicatesSkipped: number | null; errorMessage: string | null; createdAt: string; completedAt: string | null; }

function providerFor(project: Project): Exclude<Provider, "all"> {
  if (project.repositoryUrl.includes("bitbucket.org")) return "bitbucket";
  if (/gitlab\./i.test(project.repositoryUrl)) return "gitlab";
  return "github";
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [filter, setFilter] = useState<Provider>("all");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [analysisByProject, setAnalysisByProject] = useState<Record<string, AnalysisRun[]>>({});
  const [genByProject, setGenByProject] = useState<Record<string, GenerationRunDto>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  const prevGenStatus = useRef<Record<string, string>>({});
  const STALE_MS = 15 * 60 * 1000;
  const token = typeof window === "undefined" ? null : window.localStorage.getItem("proofline.accessToken");

  // Buttons are gated on the organization's connected accounts (Settings →
  // Connected accounts), not on the repository's provider alone.
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
        const analyses = await Promise.all(loadedProjects.map(async (project) => [project.id, await fetch(`${apiUrl}/v1/projects/${project.id}/analysis`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok ? response.json() as Promise<AnalysisRun[]> : [])] as const));
        setAnalysisByProject(Object.fromEntries(analyses));
      })
      .catch(() => setMessage("Unable to load projects. Please sign in again."));
  }, [token]);

  const loadCounts = useCallback(async () => {
    if (!token) return;
    try {
      const rows = await fetch(`${apiUrl}/v1/test-cases`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json() as Promise<Array<{ projectId: string }>> : Promise.reject()));
      const next: Record<string, number> = {};
      for (const row of rows) next[row.projectId] = (next[row.projectId] ?? 0) + 1;
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
        setMessage(`${projectName}: ${run.created ?? 0} test cases generated — review them under Test cases.`);
        void loadCounts();
      } else if (before === "RUNNING" && run.status === "FAILED") {
        setMessage(`${projectName}: generation failed — ${run.errorMessage ?? "unknown error"}.`);
      }
      prevGenStatus.current[projectId] = run.status;
    }
    setGenByProject(map);
  }, [projects, token, loadCounts]);

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
    const value = `${project.name} ${project.repositoryUrl}`.toLowerCase();
    return matchesFilter && value.includes(search.toLowerCase());
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch(`${apiUrl}/v1/projects`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
    if (!response.ok) { setMessage("Unable to connect the project."); return; }
    const project = await response.json() as Project;
    setProjects((current) => [project, ...current]);
    setShowModal(false);
    setMessage("Project connected. Analyze the selected branch to begin generating tests.");
  }

  async function deleteProject(project: Project) {
    if (!window.confirm(`Disconnect ${project.name}? This permanently removes its test cases and execution history.`)) return;
    const response = await fetch(`${apiUrl}/v1/projects/${project.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) { setMessage("Unable to delete project. Only organization admins can delete projects."); return; }
    setProjects((current) => current.filter((item) => item.id !== project.id));
    setMessage(`${project.name} was removed from this organization.`);
  }

  async function analyze(project: Project) {
    setBusyId(`analyze-${project.id}`);
    setMessage(`Analyzing ${project.name} on ${project.defaultBranch}...`);
    const response = await fetch(`${apiUrl}/v1/projects/${project.id}/analysis?branch=${encodeURIComponent(project.defaultBranch)}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json() as { message?: string; commitSha?: string };
    setBusyId(null);
    if (response.ok) setAnalysisByProject((current) => ({ ...current, [project.id]: [{ branch: project.defaultBranch, status: "COMPLETED", completedAt: new Date().toISOString() }] }));
    setMessage(response.ok ? `Analysis completed at ${result.commitSha?.slice(0, 8) ?? "the selected commit"}. You can now generate tests.` : result.message ?? "Analysis failed. Ensure the repository provider is connected in Settings.");
  }

  async function generate(project: Project) {
    setBusyId(`generate-${project.id}`);
    setMessage(`Generating pending-review tests for ${project.name}...`);
    const response = await fetch(`${apiUrl}/v1/projects/${project.id}/generations/candidates`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json() as { message?: string; created?: number };
    setBusyId(null);
    setMessage(response.ok ? `${result.created ?? 0} pending-review test cases were generated — review them under Test cases.` : result.message ?? "Generate tests failed. Analyze the repository first.");
    void refreshGenerations();
    void loadCounts();
  }

  const githubCount = projects.filter((project) => providerFor(project) === "github").length;
  const bitbucketCount = projects.filter((project) => providerFor(project) === "bitbucket").length;
  const gitlabCount = projects.filter((project) => providerFor(project) === "gitlab").length;
  const [testCount, setTestCount] = useState<number | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch(`${apiUrl}/v1/test-cases`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.ok ? response.json() as Promise<unknown[]> : Promise.reject())
      .then((rows) => setTestCount(rows.length))
      .catch(() => undefined);
  }, [token]);

  return <AppShell activePath="/projects"><section className="projects-dashboard">
    <header className="projects-header">
      <div><span className="page-kicker">Organization projects</span><h1>Projects</h1><p>Repositories and test environments connected to your organization workspace.</p></div>
      <button className="new-project-button" onClick={() => setShowModal(true)}><Plus size={16} />New project</button>
    </header>

    <section className="project-stats" aria-label="Project statistics">
      <Stat icon={<FolderGit2 />} label="Connected repos" value={projects.length} tone="emerald" />
      <Stat icon={<TestTube2 />} label="Total test cases" value={testCount ?? "-"} tone="teal" />
      <Stat icon={<GithubIcon />} label="GitHub repos" value={githubCount} tone="slate" />
      <Stat icon={<BitbucketIcon />} label="Bitbucket repos" value={bitbucketCount} tone="blue" />
      <Stat icon={<GitlabIcon />} label="GitLab repos" value={gitlabCount} tone="coral" />
    </section>

    <section className="project-toolbar">
      <label className="project-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by repo name or URL..." /></label>
      <div className="provider-filter"><span>Provider:</span><div>{(["all", "github", "bitbucket", "gitlab"] as Provider[]).map((provider) => <button key={provider} className={filter === provider ? "selected" : ""} onClick={() => setFilter(provider)}>{provider === "github" && <GithubIcon size={13} />}{provider === "bitbucket" && <BitbucketIcon size={13} />}{provider === "gitlab" && <GitlabIcon size={13} />}{provider === "all" ? "All" : providerLabels[provider]}</button>)}</div></div>
    </section>

    {message && <div className="project-feedback"><Check size={16} />{message}</div>}
    <section className="project-cards">{visibleProjects.length ? visibleProjects.map((project) => <ProjectCard key={project.id} project={project} analyses={analysisByProject[project.id] ?? []} busyId={busyId} generation={genByProject[project.id]} testCount={counts[project.id]} serverGenerating={isServerGenerating(project.id)} connectedProviders={connectedProviders} onAnalyze={analyze} onGenerate={generate} onDelete={deleteProject} />) : <div className="project-empty"><FolderGit2 size={26} /><h2>No projects found</h2><p>Try another filter, or connect a repository to create your first project.</p></div>}</section>

    {showModal && <div className="project-modal-backdrop" role="presentation" onMouseDown={() => setShowModal(false)}><form className="project-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><header><div><span className="modal-icon"><Plus size={16} /></span><div><h2>Connect new repository</h2><p>Import a project to analyze and generate reviewable test suites.</p></div></div><button type="button" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button></header><div className="modal-fields"><label>Project name<input name="name" required placeholder="checkout-payment-service" /></label><label>Repository URL<input name="repositoryUrl" type="url" required placeholder="https://github.com/org/repository" /></label><div className="modal-row"><label>Default branch<input name="defaultBranch" defaultValue="main" required /></label><label>Provider<select name="provider" defaultValue="github"><option value="github">GitHub</option><option value="bitbucket">Bitbucket</option><option value="gitlab">GitLab</option></select></label></div></div><footer><button type="button" className="modal-cancel" onClick={() => setShowModal(false)}>Cancel</button><button className="new-project-button"><Check size={15} />Connect project</button></footer></form></div>}
  </section></AppShell>;
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string | number; tone: string }) { return <article className={`stat-card ${tone}`}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></article>; }

function ProjectCard({ project, analyses, busyId, generation, testCount, serverGenerating, connectedProviders, onAnalyze, onGenerate, onDelete }: { project: Project; analyses: AnalysisRun[]; busyId: string | null; generation?: GenerationRunDto; testCount?: number; serverGenerating: boolean; connectedProviders: string[]; onAnalyze: (project: Project) => void; onGenerate: (project: Project) => void; onDelete: (project: Project) => void }) {
  const provider = providerFor(project);
  const analyzing = busyId === `analyze-${project.id}`;
  const generating = busyId === `generate-${project.id}` || serverGenerating;
  const genStale = generation?.status === "RUNNING" && !serverGenerating;
  const genState = generating ? "Generating tests…" : genStale ? "Generation timed out" : generation?.status === "COMPLETED" ? `Generated ${generation.created ?? 0} tests` : generation?.status === "FAILED" ? "Generation failed" : null;
  const analyzed = analyses.some((analysis) => analysis.branch === project.defaultBranch && analysis.status === "COMPLETED");
  const unsupported = provider === "gitlab";
  const connected = connectedProviders.includes(provider);
  const connectHint = `Connect ${providerLabels[provider]} in Settings → Connected accounts to enable this.`;
  const unsupportedHint = "GitLab analysis is on the roadmap — GitHub and Bitbucket are supported today.";
  const analyzeDisabled = unsupported || !connected || analyzing || generating;
  const generateDisabled = unsupported || !connected || !analyzed || analyzing || generating;
  const analyzeTooltip = unsupported ? unsupportedHint : !connected ? connectHint : undefined;
  const generateTooltip = unsupported ? unsupportedHint : !connected ? connectHint : !analyzed ? "Analyze the repository before generating test cases." : undefined;
  return <article className="project-card"><div className="project-card-main"><div className="project-title"><span className={`provider-badge ${provider}`}>{provider === "github" ? <GitlabIcon size={13} /> : provider === "bitbucket" ? <BitbucketIcon size={13} /> : <GitlabIcon size={13} />}{providerLabels[provider]}</span><h2>{project.name}</h2></div><div className="project-meta"><span className="project-url">{project.repositoryUrl}</span><span className="branch"><ChevronDown size={13} />{project.defaultBranch}</span><span><Clock3 size={13} />{analyzed ? "Analysis complete" : "Ready to analyze"}</span>{genState && <span className={generating ? "gen-live" : genStale || generation?.status === "FAILED" ? "gen-failed" : "gen-done"}><Bot size={13} />{genState}</span>}</div></div><div className="project-card-actions"><div className="test-count"><span><TestTube2 size={15} /></span><div><small>Test cases</small><strong>{testCount != null ? testCount : "Not generated"}</strong></div></div><div className="project-buttons"><span className="generate-tooltip" data-tooltip={analyzeTooltip}><button className="analyze-button" disabled={analyzeDisabled} onClick={() => onAnalyze(project)}><SearchCode size={14} />{analyzing ? "Analyzing..." : "Analyze"}</button></span><span className="generate-tooltip" data-tooltip={generateTooltip}><button className="generate-button" disabled={generateDisabled} onClick={() => onGenerate(project)}><Bot size={14} />{generating ? "Generating…" : "Generate tests"}</button></span><button className="delete-project" aria-label={`Delete ${project.name}`} onClick={() => onDelete(project)}><Trash2 size={16} /></button></div></div></article>;
}
