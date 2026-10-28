import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RepositoryConnectionsService, githubHeaders, providerLabel } from "../repository-connections/repository-connections.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { linkPagesToCode, type LinkCoverage } from "./page-linker";
import { extractRoutes, extractRouteParams, prioritizePaths, buildImportGraph, reachableFromRoutes, extractComponentNames, featureName, aliasRules, importNeighborhood, type RouteInfo } from "../analysis/analyzer";
import { dedupeSharedControls, discoveryAuth, type DiscoveredPage } from "../analysis/live-discovery";
import { crawlApp, type CrawledRoute } from "../analysis/crawler";
import { enqueueAnalysis } from "../common/queue";
import { resolveModelProvider } from "../common/model-provider";
import { codeRouteHints } from "./adapters";
import { summarizeCodebase } from "../analysis/code-context";
import { PermissionsService } from "../rbac/permissions.service";
import { PERMISSIONS } from "@ai-qa/domain";
import { loadSessionState, sessionStore } from "../common/environment-session";
import { downloadSnapshot } from "./repo-archive";
import { discoverEndpoints, type EndpointRow } from "./endpoints";
import { normalizeEndpointPath } from "@ai-qa/test-dsl";
import { buildFlowSpecs, buildModules, type FlowSpecResult } from "./specs";
import { UsageLedger } from "../common/usage-ledger";

interface GithubTreeEntry { path: string; type: string; sha: string; size?: number; }
interface GithubTree { tree: GithubTreeEntry[]; }
interface GithubBranch { commit: { sha: string }; }
interface GithubBlob { content: string; encoding: string; }
interface BitbucketBranch { target: { hash: string }; }
interface BitbucketSrcEntry { type: string; path: string; size?: number; }
interface BitbucketSrcPage { values?: BitbucketSrcEntry[]; next?: string; }
interface GitlabBranch { commit: { id: string }; }
interface GitlabTreeEntry { id: string; name: string; type: "tree" | "blob"; path: string; mode: string }

type AnalysisProvider = "GITHUB" | "BITBUCKET" | "GITLAB";

interface RepositorySnapshot { sources: Map<string, string>; codePaths: string[]; prioritizedCount: number; configs: Map<string, string>; areas: Map<string, "frontend" | "backend">; fileCapReached: boolean; }
/** Where one repository lives: API path, GitLab API host, and the subfolder (+ backend dirs) analysis is scoped to. */
interface RepositoryTarget { provider: AnalysisProvider; repository: string; gitlabApi: string; root: string; backendDirs: string[] }

const MAX_FILES = 600;
const FETCH_CHUNK = 25;
const MAX_TREE_ENTRIES = 20_000;
/** tsconfig/jsconfig (import aliases) and package.json (which framework an app uses): read once per repo, not treated as analyzable code. */
const CONFIG_PATH = /(^|\/)(package\.json|(?:tsconfig|jsconfig)[^/]*\.json|next\.config\.(?:[cm]?[jt]s)|vite\.config\.(?:[cm]?[jt]s))$/i;

@Injectable()
export class AnalysisService {
  constructor(private readonly prisma: PrismaService, private readonly connections: RepositoryConnectionsService, private readonly permissions: PermissionsService) {}

  /** Validates, pins the commit, and queues the run. The crawl itself runs in the background (execute). */
  async analyze(user: AuthenticatedUser, projectId: string, branch?: string) {
    await this.permissions.assert(user, PERMISSIONS.TEST_CASES_CREATE);
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const active = await this.prisma.analysisRun.findFirst({ where: { projectId, status: { in: ["QUEUED", "RUNNING"] } }, orderBy: { createdAt: "desc" } });
    if (active) return active; // one analysis at a time per project: the UI keeps polling this run
    const selectedBranch = branch ?? project.defaultBranch;
    const access = await this.connections.projectAccess(project);
    const target: RepositoryTarget = { provider: project.provider, repository: project.repoFullName, gitlabApi: access.gitlabApi, root: project.rootDirectory.replace(/^\/+|\/+$/g, ""), backendDirs: project.backendDirectories };
    const commitSha = await this.resolveBranch(target, selectedBranch, this.providerHeaders(target.provider, access.token));
    const analysis = await this.prisma.analysisRun.create({ data: { organizationId: user.organizationId, projectId, branch: selectedBranch, commitSha, status: "QUEUED" } });
    await enqueueAnalysis(analysis.id);
    return analysis;
  }

  /** Background job: read the code, crawl the live app, and write the Route Map. */
  async execute(analysisId: string) {
    const analysis = await this.prisma.analysisRun.findUnique({ where: { id: analysisId }, include: { project: true } });
    if (!analysis || analysis.status !== "QUEUED") return;
    const { project, projectId, commitSha } = analysis;
    await this.prisma.analysisRun.update({ where: { id: analysisId }, data: { status: "RUNNING", progress: { stage: "reading-code" } as never } });

    try {
      const access = await this.connections.projectAccess(project);
      const target: RepositoryTarget = { provider: project.provider, repository: project.repoFullName, gitlabApi: access.gitlabApi, root: project.rootDirectory.replace(/^\/+|\/+$/g, ""), backendDirs: project.backendDirectories };
      const headers: Record<string, string> = this.providerHeaders(target.provider, access.token);
      const { sources, codePaths, configs, areas, fileCapReached } = await this.collectSources(target, commitSha, headers);

      // A. Code hints: routes from the router config + import-graph reachability.
      // Aliases (tsconfig "paths" / baseUrl) are resolved once here so a repo's "@/" imports don't
      // silently fail reachability and code-context attachment later.
      const aliases = aliasRules(configs);
      const graph = buildImportGraph(sources, aliases);
      // Adapters (AST / file paths / model fallback) win; the regex extractor only fills what they missed.
      const provider = await resolveModelProvider(this.prisma);
      const hints = await codeRouteHints(sources, codePaths, provider.impl, configs, aliases);
      const seenPaths = new Set<string>();
      const merged: RouteInfo[] = [];
      for (const hint of hints) {
        seenPaths.add(hint.pattern);
        const page = hint.file?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Page";
        merged.push({ path: hint.pattern, page, feature: featureName(hint.pattern, page), ...(hint.file ? { file: hint.file } : {}) });
      }
      for (const route of extractRoutes(sources)) {
        const path = route.path.startsWith("/") || route.path === "*" ? route.path : `/${route.path}`;
        if (!seenPaths.has(path)) merged.push({ ...route, path });
      }
      const withParams = extractRouteParams(merged, sources, graph);
      // Each route also carries its page file's near import neighborhood: what generation reads as
      // that page's code context (summarizeCodebase is keyed by real file path, see code-context.ts).
      const routerRoutes = withParams.map((route) => (route.file ? { ...route, files: importNeighborhood(route.file, sources, graph) } : route));
      // What the route readers found, plus every crawled page they could not tie to a file: those are
      // linked by the text the page shows (page-linker.ts), whatever routing style the app uses.
      let routes = routerRoutes;
      let linkCoverage: LinkCoverage | undefined;

      const packageJson = sources.get("package.json");
      const framework = packageJson?.includes('"react"') ? "React" : "Unknown";
      const language = codePaths.some((path) => path.endsWith(".tsx")) ? "TypeScript" : "JavaScript";

      // B. Live crawl: the running app decides which pages exist (framework independent).
      // D. Backend endpoint discovery runs concurrently with it; the flow specs wait for the crawl,
      // because which source file each page lives in is settled by what the crawl saw.
      const runCrawl = async () => {
        const environment = await this.prisma.environmentProfile.findFirst({ where: { projectId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
        let discoveredPages: DiscoveredPage[] = [];
        let discoveryError: string | undefined;
        let loginStatus: "none" | "ok" | "failed" = "none";
        let routeSummary: { total: number; verified: number; budgetHit: boolean } | undefined;
        let crawlApiCalls: string[] = [];
        if (environment?.url) {
          const auth = discoveryAuth(environment);
          const known = await this.prisma.projectRoute.findMany({ where: { projectId, excluded: false }, select: { pattern: true } });
          const hints = [...new Set([
            ...routerRoutes.map((route) => route.path).filter((path) => path && !path.includes("*")).map((path) => (path.startsWith("/") ? path : `/${path}`)),
            ...known.map((route) => route.pattern),
            ...Object.keys(auth.fixtures ?? {})
          ])];
          const crawl = await crawlApp(environment.url.replace(/\/$/, ""), { auth, hints, sessionState: loadSessionState(environment), sessionStore: sessionStore(this.prisma, environment.id) });
          loginStatus = crawl.login;
          discoveredPages = crawl.routes.flatMap((route) => (route.page ? [route.page] : []));
          dedupeSharedControls(discoveredPages);
          discoveryError = loginStatus === "failed"
            ? `Login failed${crawl.loginRateLimited ? " (the app rate-limited it, HTTP 429; wait a few minutes)" : ""} with the saved credentials for environment "${environment.name}". Check the username, password, login URL and login trigger in Settings, then analyze again.`
            : crawl.routes.some((route) => route.verified) ? undefined : (crawl.error ?? "no pages could be crawled");
          routeSummary = { total: crawl.routes.length, verified: crawl.routes.filter((route) => route.verified).length, budgetHit: Boolean(crawl.budgetHit) };
          crawlApiCalls = crawl.routes.flatMap((route) => route.apiCalls ?? []);
          if (loginStatus === "failed") {
            // Never replace a good logged-in crawl with a logged-out one: keep the last pages that were not gated.
            const previous = await this.prisma.analysisRun.findFirst({ where: { projectId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } });
            const kept = ((previous?.knowledgeModel as { discoveredPages?: DiscoveredPage[] } | null)?.discoveredPages ?? []).filter((entry) => !entry.authGated);
            if (kept.length) discoveredPages = kept;
          }
          const linked = linkPagesToCode(discoveredPages, routerRoutes, sources, graph, areas);
          routes = linked.routes;
          linkCoverage = linked.coverage;
          await this.saveRouteMap(projectId, crawl.routes, routes, loginStatus === "failed");
        } else {
          // No app to crawl yet: the Route Map still lists what the code declares, as not yet opened.
          await this.saveRouteMap(projectId, [], routes, false);
        }
        return { discoveredPages, discoveryError, loginStatus, routeSummary, crawlApiCalls };
      };

      const runEndpoints = async (): Promise<EndpointRow[]> => {
        try {
          const backendSources = new Map([...sources].filter(([path]) => areas.get(path) === "backend"));
          return await discoverEndpoints(this.prisma, provider.impl, projectId, project.organizationId, backendSources, graph);
        } catch (endpointError) {
          console.warn(`Endpoint discovery skipped: ${endpointError instanceof Error ? endpointError.message : endpointError}`);
          return [];
        }
      };

      const runSpecs = async (endpoints: EndpointRow[]): Promise<FlowSpecResult[]> => {
        try {
          await this.prisma.analysisRun.update({ where: { id: analysisId }, data: { progress: { stage: "specs", modulesPlanned: buildModules(routes, endpoints).length, modulesDone: 0 } as never } }).catch(() => undefined);
          return await buildFlowSpecs(this.prisma, provider.impl, projectId, analysisId, routes, endpoints, sources, graph, provider.model, (done, total) => {
            this.prisma.analysisRun.update({ where: { id: analysisId }, data: { progress: { stage: "specs", modulesPlanned: total, modulesDone: done } as never } }).catch(() => undefined);
          });
        } catch (specError) {
          console.warn(`Flow specs skipped: ${specError instanceof Error ? specError.message : specError}`);
          return [];
        }
      };

      const [{ discoveredPages: rawDiscoveredPages, discoveryError, loginStatus, routeSummary, crawlApiCalls }, discoveredEndpoints] = await Promise.all([runCrawl(), runEndpoints()]);
      const flowSpecs = await runSpecs(discoveredEndpoints);
      let discoveredPages = rawDiscoveredPages;

      // C. Deep code context: AST summaries of the components reachable from the routes (handlers,
      // rendered elements, API calls, state). Computed here, not before the crawl, so it includes pages
      // the crawl linked to their code by text.
      const reachableFiles = reachableFromRoutes(routes, sources, graph);
      const reachableComponents = extractComponentNames(sources, reachableFiles);
      const reachableSourceFiles = new Map<string, string>();
      const reachableNameSet = new Set(reachableComponents);
      for (const path of reachableFiles) {
        const content = sources.get(path);
        if (!content) continue;
        const definesReachable = [...content.matchAll(/export\s+(?:async\s+)?(?:const|function|class)\s+([A-Z][A-Za-z0-9_]*)/g)]
          .some((match) => reachableNameSet.has(match[1]) || path.includes("pages") || path.includes("routes"));
        if (definesReachable || path.includes("pages") || path.includes("routes")) reachableSourceFiles.set(path, content);
      }
      let codeContext: Array<{ component: string; file: string; kind: string; renderedElements: Array<{ kind: string; label: string; onClickHandler?: string; name?: string }>; handlers: Array<{ handler: string; apiCalls: string[]; navigations: string[]; stateUpdates: string[]; toastOrAlert: boolean }>; apiCalls: string[]; navigations: string[]; stateVariables: string[]; loc: number }> = [];
      try {
        codeContext = summarizeCodebase(reachableSourceFiles).slice(0, 200);
      } catch (contextError) {
        console.warn(`Code-context extraction skipped: ${contextError instanceof Error ? contextError.message : contextError}`);
      }
      const liveCalls = new Set(crawlApiCalls.map((call) => { const [method, path] = call.split(/\s+/); return `${method} ${normalizeEndpointPath(path ?? "")}`; }));
      const endpoints: Array<EndpointRow & { liveObserved: boolean }> = discoveredEndpoints.map((row) => ({ ...row, liveObserved: liveCalls.has(`${row.method} ${row.norm}`) }));
      const usageLedger = new UsageLedger();
      for (const spec of flowSpecs) if (spec.inputTokens || spec.outputTokens) usageLedger.recordDirect(provider.name, provider.model, spec.inputTokens, spec.outputTokens);
      await usageLedger.flush(this.prisma, { organizationId: project.organizationId, projectId, analysisRunId: analysisId });

      const knowledgeModel = {
        framework,
        endpoints,
        flowSpecs: flowSpecs.map((spec) => ({ moduleKey: spec.moduleKey, name: spec.name, spec: spec.spec, stats: spec.stats, cached: spec.cached })),
        language,
        routes,
        features: routes.map((route) => ({ name: route.feature, kind: "page", path: route.path })),
        reachableComponents,
        codeContext,
        discoveredPages,
        routeSummary,
        codeLinks: linkCoverage,
        loginStatus,
        discoveryError: discoveryError ?? (discoveredPages.length ? undefined : "no environment URL configured for this project"),
        analyzedFiles: [...sources.keys()].filter((path) => path !== "package.json"),
        fileCapReached
      };

      return await this.prisma.analysisRun.update({
        where: { id: analysisId },
        data: { status: "COMPLETED", knowledgeModel: knowledgeModel as never, progress: { stage: "completed" } as never, completedAt: new Date() }
      });
    } catch (error) {
      await this.prisma.analysisRun.update({
        where: { id: analysisId },
        data: { status: "FAILED", errorMessage: error instanceof Error ? error.message : "Analysis failed", completedAt: new Date() }
      });
      throw error;
    }
  }

  /**
   * Upsert the Route Map. Crawl facts (status, inventory, samples) are refreshed; user decisions
   * (pinned, excluded, user-added routes, labels) are never overwritten. After a failed login only
   * new routes are added, so a logged-out crawl cannot degrade a good map.
   */
  private async saveRouteMap(projectId: string, crawled: CrawledRoute[], codeRoutes: RouteInfo[], loginFailed: boolean) {
    const existing = new Map((await this.prisma.projectRoute.findMany({ where: { projectId } })).map((row) => [row.pattern, row]));
    const codeByPattern = new Map(codeRoutes.map((route) => [route.path.startsWith("/") ? route.path : `/${route.path}`, route]));
    // A catch-all ("*", "/*") is the not-found page, not a page of the app.
    const patterns = new Set([...crawled.map((route) => route.pattern), ...codeByPattern.keys()].filter((pattern) => !pattern.includes("*")));
    for (const pattern of patterns) {
      const found = crawled.find((route) => route.pattern === pattern);
      const code = codeByPattern.get(pattern);
      const row = existing.get(pattern);
      const sources = [...new Set([...(row?.sources ?? []), ...(found?.sources ?? []), ...(code ? ["code"] : [])])];
      const verified = Boolean(found?.verified);
      const attempted = Boolean(found?.page);
      if (!row) {
        await this.prisma.projectRoute.create({ data: {
          projectId, pattern, sources, label: found?.label ?? code?.feature, navOrder: found?.navOrder,
          status: verified ? "VERIFIED" : attempted ? "UNREACHABLE" : "DISCOVERED",
          reason: verified ? null : found?.reason ?? (code ? "found in the code but not opened by the crawl" : null),
          requiresAuth: found?.page?.authGated ? true : null,
          pageFile: code?.file ?? null,
          params: (found?.params.length ? found.params : (code?.params ?? []).map((param) => ({ ...param, samples: [] }))) as never,
          inventory: (found?.page ?? null) as never, apiCalls: found?.apiCalls ?? [],
          lastVerifiedAt: verified ? new Date() : null
        } });
        continue;
      }
      if (loginFailed) continue;
      const params = new Map<string, { name: string; in: string; samples: string[] }>();
      for (const param of [...((row.params as Array<{ name: string; in: string; samples: string[] }> | null) ?? []), ...(found?.params ?? [])]) {
        const key = `${param.in}:${param.name}`;
        const merged = params.get(key) ?? { name: param.name, in: param.in, samples: [] };
        for (const sample of param.samples ?? []) if (!merged.samples.includes(sample) && merged.samples.length < 3) merged.samples.push(sample);
        params.set(key, merged);
      }
      await this.prisma.projectRoute.update({ where: { id: row.id }, data: {
        sources,
        label: row.label ?? found?.label ?? code?.feature,
        pageFile: row.pageFile ?? code?.file ?? null,
        navOrder: found?.navOrder ?? row.navOrder,
        ...(attempted || verified ? {
          status: verified ? "VERIFIED" : "UNREACHABLE", reason: verified ? null : found?.reason ?? row.reason,
          inventory: (found?.page ?? null) as never, apiCalls: found?.apiCalls ?? row.apiCalls,
          requiresAuth: found?.page?.authGated ? true : row.requiresAuth,
          lastVerifiedAt: verified ? new Date() : row.lastVerifiedAt
        } : {}),
        params: [...params.values()] as never
      } });
    }

    // Stale code-only rows: a route the old (buggy) scoping invented — e.g. a sibling app's `pages/`
    // folder read as Next routes — that this run's code hints no longer produce. Every analysis re-feeds
    // existing patterns back into the crawler as hints, so a junk route can pick up "hint" and even get
    // opened (a client router falling through to a 404 page still "verifies"); neither tag is real
    // confirmation, so a row survives this prune only if real navigation ("crawl") or a person ("user")
    // ever put it there. Only when this run actually read code routes, so a transient empty read prunes
    // nothing. Pinned and excluded rows are never touched, whatever code says this run.
    if (codeRoutes.length) {
      const neverConfirmed = (row: { sources: string[] }) => row.sources.every((source) => source === "code" || source === "hint");
      const stale = [...existing.values()].filter((row) => !patterns.has(row.pattern) && !row.pinned && !row.excluded && neverConfirmed(row));
      if (stale.length) await this.prisma.projectRoute.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }
  }

  list(user: AuthenticatedUser, projectId: string) {
    return this.prisma.analysisRun.findMany({ where: { organizationId: user.organizationId, projectId }, orderBy: { createdAt: "desc" } });
  }

  private providerHeaders(provider: AnalysisProvider, token: string): Record<string, string> {
    if (provider === "BITBUCKET") return { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (provider === "GITLAB") return { Authorization: `Bearer ${token}` };
    return githubHeaders(token);
  }

  private async resolveBranch({ provider, repository, gitlabApi }: RepositoryTarget, branch: string, headers: Record<string, string>) {
    const url = provider === "BITBUCKET"
      ? `https://api.bitbucket.org/2.0/repositories/${repository}/refs/branches/${encodeURIComponent(branch)}`
      : provider === "GITLAB"
        ? `${gitlabApi}/projects/${encodeURIComponent(repository)}/repository/branches/${encodeURIComponent(branch)}`
        : `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(branch)}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const label = providerLabel(provider);
      if (response.status === 401) throw new BadRequestException(`${label} rejected this organization's saved access token (401). Open Settings, disconnect the ${label} account, and connect it again to refresh the token.`);
      if (response.status === 404) throw new BadRequestException(`${label} could not find ${repository} (404) at branch ${branch} with the connected account — check that the branch exists and the connected ${label} account still has access to the repository.`);
      if (response.status === 403) throw new BadRequestException(`${label} rate limit or permission denied (403) for the connected account. Try again shortly, or reconnect with an account that has access.`);
      throw new BadRequestException(`${label} branch lookup failed with status ${response.status}`);
    }
    return provider === "BITBUCKET"
      ? (await response.json() as BitbucketBranch).target.hash
      : provider === "GITLAB"
        ? (await response.json() as GitlabBranch).commit.id
        : (await response.json() as GithubBranch).commit.sha;
  }

  private async collectSources(target: RepositoryTarget, commitSha: string, headers: Record<string, string>): Promise<RepositorySnapshot> {
    const archived = await this.archiveSources(target, commitSha, headers);
    if (archived) return archived;
    if (target.provider === "BITBUCKET") return this.bitbucketSources(target, commitSha, headers);
    if (target.provider === "GITLAB") return this.gitlabSources(target, commitSha, headers);
    return this.githubSources(target, commitSha, headers);
  }

  /** One archive request instead of one HTTP call per file; also the only path that reads backendDirs. Null = fall back to the per-file readers below. */
  private async archiveSources(target: RepositoryTarget, commitSha: string, headers: Record<string, string>): Promise<RepositorySnapshot | null> {
    const snapshot = await downloadSnapshot(target, commitSha, headers, { root: target.root, backendDirs: target.backendDirs });
    if (!snapshot) return null;
    const sources = new Map<string, string>();
    const configs = new Map<string, string>();
    const areas = new Map<string, "frontend" | "backend">();
    const codePaths: string[] = [];
    const rootPackageJson = rootPath(target.root, "package.json");
    for (const file of snapshot.files) {
      // walk() already returns paths relative to the repo root (it prefixes each scope's dir), so
      // no re-rooting is needed here — unlike the per-file readers, which key the root package.json
      // under the sentinel "package.json" for convenience; mirror that one special case.
      if (file.path === rootPackageJson) sources.set("package.json", file.content);
      if (/\.(tsx?|jsx?|vue|svelte|astro)$/.test(file.path)) { sources.set(file.path, file.content); codePaths.push(file.path); areas.set(file.path, file.area); }
      else configs.set(file.path, file.content);
    }
    return { sources, codePaths, prioritizedCount: codePaths.length, configs, areas, fileCapReached: snapshot.truncated };
  }

  private async githubSources({ repository, root }: RepositoryTarget, commitSha: string, headers: Record<string, string>): Promise<RepositorySnapshot> {
    const treeResponse = await fetch(`https://api.github.com/repos/${repository}/git/trees/${commitSha}?recursive=1`, { headers });
    if (!treeResponse.ok) throw new BadRequestException(`GitHub tree lookup failed with status ${treeResponse.status}`);
    const tree = await treeResponse.json() as GithubTree;

    const codePaths = tree.tree
      .filter((entry) => entry.type === "blob" && underRoot(entry.path, root) && /\.(tsx?|jsx?|vue|svelte|astro)$/.test(entry.path) && (entry.size ?? 0) < 250_000)
      .map((entry) => entry.path);
    const prioritized = prioritizePaths(codePaths.filter((path) => /\.(tsx?|jsx?)$/.test(path))).slice(0, MAX_FILES);

    const sources = await fetchInChunks(prioritized, (path) => this.readBlob(repository, tree.tree.find((candidate) => candidate.path === path)!.sha, headers));
    const packageEntry = tree.tree.find((entry) => entry.path === rootPath(root, "package.json") && entry.type === "blob");
    if (packageEntry) sources.set("package.json", await this.readBlob(repository, packageEntry.sha, headers));

    const configEntries = configPaths(tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path), root);
    const configs = new Map<string, string>();
    for (const path of configEntries) {
      const entry = tree.tree.find((candidate) => candidate.path === path);
      if (entry) configs.set(path, await this.readBlob(repository, entry.sha, headers));
    }
    return { sources, codePaths, prioritizedCount: prioritized.length, configs, areas: frontendAreas(sources), fileCapReached: prioritized.length >= MAX_FILES && codePaths.length > MAX_FILES };
  }

  private async bitbucketSources({ repository, root }: RepositoryTarget, commitSha: string, headers: Record<string, string>): Promise<RepositorySnapshot> {
    // Bitbucket has no recursive tree endpoint: walk the src listing breadth-first,
    // following its pagination. Raw file reads must not send Accept: application/json,
    // or Bitbucket answers with file metadata instead of the contents.
    const rawHeaders: Record<string, string> = { Authorization: headers.Authorization };
    const codePaths: string[] = [];
    const directories = [root];
    let hasPackageJson = false;
    let seen = 0;
    const foundConfigs: string[] = [];
    while (directories.length && seen < MAX_TREE_ENTRIES) {
      const directory = directories.shift()!;
      let next = `https://api.bitbucket.org/2.0/repositories/${repository}/src/${commitSha}/${directory ? `${directory}/` : ""}?pagelen=100`;
      do {
        const pageResponse = await fetch(next, { headers });
        if (!pageResponse.ok) throw new BadRequestException(`Bitbucket tree lookup failed with status ${pageResponse.status}`);
        const page = await pageResponse.json() as BitbucketSrcPage;
        for (const entry of page.values ?? []) {
          if (entry.path === rootPath(root, "package.json")) hasPackageJson = true;
          if (entry.type === "commit_directory") directories.push(entry.path);
          else if (entry.type === "commit_file" && /\.(tsx?|jsx?|vue|svelte|astro)$/.test(entry.path) && (entry.size ?? 0) < 250_000) codePaths.push(entry.path);
          if (entry.type === "commit_file" && CONFIG_PATH.test(entry.path)) foundConfigs.push(entry.path);
        }
        seen += page.values?.length ?? 0;
        next = page.next ?? "";
      } while (next && seen < MAX_TREE_ENTRIES);
    }

    const prioritized = prioritizePaths(codePaths.filter((path) => /\.(tsx?|jsx?)$/.test(path))).slice(0, MAX_FILES);
    const sources = await fetchInChunks(prioritized, (path) => this.readBitbucketFile(repository, commitSha, path, rawHeaders));
    if (hasPackageJson) sources.set("package.json", await this.readBitbucketFile(repository, commitSha, rootPath(root, "package.json"), rawHeaders));

    const configs = new Map<string, string>();
    for (const path of configPaths(foundConfigs, root)) {
      const content = await this.readBitbucketFile(repository, commitSha, path, rawHeaders);
      if (content) configs.set(path, content);
    }
    return { sources, codePaths, prioritizedCount: prioritized.length, configs, areas: frontendAreas(sources), fileCapReached: prioritized.length >= MAX_FILES && codePaths.length > MAX_FILES };
  }

  private async readBlob(repository: string, sha: string, headers: Record<string, string>) {
    const response = await fetch(`https://api.github.com/repos/${repository}/git/blobs/${sha}`, { headers });
    if (!response.ok) return "";
    const blob = await response.json() as GithubBlob;
    return blob.encoding === "base64" ? Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString("utf8") : "";
  }

  /**
   * GitLab sources via the repository tree + raw-file endpoints. GitLab addresses
   * projects (including nested groups like group/subgroup/project) by their
   * URL-encoded full path. The tree API exposes no file sizes, so the byte cap is
   * applied to each fetched file's content instead of the tree entry.
   */
  private async gitlabSources({ repository, gitlabApi, root }: RepositoryTarget, commitSha: string, headers: Record<string, string>): Promise<RepositorySnapshot> {
    const projectId = encodeURIComponent(repository);
    const codePaths: string[] = [];
    let hasPackageJson = false;
    let page = 1;
    let seen = 0;
    const foundConfigs: string[] = [];
    while (seen < MAX_TREE_ENTRIES) {
      const response = await fetch(`${gitlabApi}/projects/${projectId}/repository/tree?ref=${encodeURIComponent(commitSha)}${root ? `&path=${encodeURIComponent(root)}` : ""}&recursive=true&per_page=100&page=${page}`, { headers });
      if (!response.ok) throw new BadRequestException(`GitLab tree lookup failed with status ${response.status}`);
      const entries = await response.json() as GitlabTreeEntry[];
      if (!entries.length) break;
      for (const entry of entries) {
        if (entry.type !== "blob") continue;
        if (entry.path === rootPath(root, "package.json")) hasPackageJson = true;
        if (/\.(tsx?|jsx?|vue|svelte|astro)$/.test(entry.path)) codePaths.push(entry.path);
        if (CONFIG_PATH.test(entry.path)) foundConfigs.push(entry.path);
      }
      seen += entries.length;
      const next = response.headers.get("x-next-page");
      if (!next) break;
      page = Number(next);
    }

    const prioritized = prioritizePaths(codePaths.filter((path) => /\.(tsx?|jsx?)$/.test(path))).slice(0, MAX_FILES);
    const sources = await fetchInChunks(prioritized, (path) => this.readGitlabFile(gitlabApi, repository, commitSha, path, headers));
    if (hasPackageJson) {
      const packageJson = await this.readGitlabFile(gitlabApi, repository, commitSha, rootPath(root, "package.json"), headers);
      if (packageJson) sources.set("package.json", packageJson);
    }

    const configs = new Map<string, string>();
    for (const path of configPaths(foundConfigs, root)) {
      const content = await this.readGitlabFile(gitlabApi, repository, commitSha, path, headers);
      if (content) configs.set(path, content);
    }
    return { sources, codePaths, prioritizedCount: prioritized.length, configs, areas: frontendAreas(sources), fileCapReached: prioritized.length >= MAX_FILES && codePaths.length > MAX_FILES };
  }

  private async readGitlabFile(gitlabApi: string, repository: string, commitSha: string, path: string, headers: Record<string, string>) {
    const response = await fetch(`${gitlabApi}/projects/${encodeURIComponent(repository)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(commitSha)}`, { headers });
    if (!response.ok) return "";
    const content = await response.text();
    return content.length > 250_000 ? "" : content;
  }

  private async readBitbucketFile(repository: string, commitSha: string, path: string, headers: Record<string, string>) {
    const response = await fetch(`https://api.bitbucket.org/2.0/repositories/${repository}/src/${commitSha}/${path}`, { headers });
    if (!response.ok) return "";
    return response.text();
  }

}

/** The per-file readers' fetch loop: in chunks, to stay friendly to providers' secondary rate limits. Empty reads are dropped. */
async function fetchInChunks(paths: string[], read: (path: string) => Promise<string>): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (let index = 0; index < paths.length; index += FETCH_CHUNK) {
    const entries = await Promise.all(paths.slice(index, index + FETCH_CHUNK).map(async (path) => [path, await read(path)] as const));
    for (const [path, content] of entries) if (content) sources.set(path, content);
  }
  return sources;
}

/** The per-file readers only ever read frontend code (backend dirs come from the archive path). */
const frontendAreas = (sources: Map<string, string>) => new Map([...sources.keys()].filter((path) => path !== "package.json").map((path) => [path, "frontend" as const]));

/** Paths are repository-relative; `root` ("" = whole repository) scopes analysis to a monorepo package. */
const underRoot = (path: string, root: string) => !root || path.startsWith(`${root}/`);
const rootPath = (root: string, file: string) => (root ? `${root}/${file}` : file);
/** Up to 20 config files, under the analyzed root, excluding node_modules/build output — closest to root first (so caps favor the project's own apps over nested library copies). */
function configPaths(paths: string[], root: string): string[] {
  return paths
    .filter((path) => underRoot(path, root) && !/(^|\/)(node_modules|dist|build|\.next|\.nuxt|out)\//.test(path) && CONFIG_PATH.test(path))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, 20);
}
