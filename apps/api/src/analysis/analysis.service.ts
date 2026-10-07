import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RepositoryConnectionsService } from "../repository-connections/repository-connections.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { extractRoutes, prioritizePaths, buildImportGraph, reachableFromRoutes, extractComponentNames } from "../analysis/analyzer";
import { discoverLiveApp } from "../analysis/live-discovery";
import { summarizeCodebase } from "../analysis/code-context";

interface GithubTreeEntry { path: string; type: string; sha: string; size?: number; }
interface GithubTree { tree: GithubTreeEntry[]; }
interface GithubBranch { commit: { sha: string }; }
interface GithubBlob { content: string; encoding: string; }
interface BitbucketBranch { target: { hash: string }; }
interface BitbucketSrcEntry { type: string; path: string; size?: number; }
interface BitbucketSrcPage { values?: BitbucketSrcEntry[]; next?: string; }

type AnalysisProvider = "GITHUB" | "BITBUCKET";

interface RepositorySnapshot { sources: Map<string, string>; codePaths: string[]; prioritizedCount: number; }

const MAX_FILES = 300;
const FETCH_CHUNK = 25;
const MAX_TREE_ENTRIES = 20_000;

@Injectable()
export class AnalysisService {
  constructor(private readonly prisma: PrismaService, private readonly connections: RepositoryConnectionsService) {}

  async analyze(user: AuthenticatedUser, projectId: string, branch?: string) {
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot analyze repositories");
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const provider = this.detectProvider(project.repositoryUrl);
    if (provider === "GITLAB") throw new BadRequestException("GitLab analysis is not supported yet — GitHub and Bitbucket repositories can be analyzed today.");
    const analysisProvider: AnalysisProvider = provider;
    const repository = this.repositoryFullName(project.repositoryUrl, analysisProvider);
    const selectedBranch = branch ?? project.defaultBranch;
    const token = await this.connections.providerToken(user.organizationId, analysisProvider);
    const headers: Record<string, string> = analysisProvider === "BITBUCKET"
      ? { Authorization: `Bearer ${token}`, Accept: "application/json" }
      : { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "proofline-local" };
    const commitSha = await this.resolveBranch(analysisProvider, repository, selectedBranch, headers);
    const analysis = await this.prisma.analysisRun.create({ data: { organizationId: user.organizationId, projectId, branch: selectedBranch, commitSha, status: "RUNNING" } });

    try {
      const { sources, codePaths, prioritizedCount } = await this.collectSources(analysisProvider, repository, commitSha, headers);

      // A. Semantic analysis: real routes + import-graph reachability.
      const routes = extractRoutes(sources);
      const graph = buildImportGraph(sources);
      const reachableFiles = reachableFromRoutes(routes, sources, graph);
      const reachableComponents = extractComponentNames(sources, reachableFiles);

      const packageJson = sources.get("package.json");
      const framework = packageJson?.includes('"react"') ? "React" : "Unknown";
      const language = codePaths.some((path) => path.endsWith(".tsx")) ? "TypeScript" : "JavaScript";

      // B. Live discovery: crawl the deployed environment for the real UI surface.
      const environment = await this.prisma.environmentProfile.findFirst({
        where: { projectId },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }]
      });
      let discoveredPages: Array<{ url: string; route: string; title: string; navItems: string[]; buttons: string[]; inputs: string[]; headings: string[] }> = [];
      let discoveryError: string | undefined;
      if (environment?.url) {
        const discovery = await discoverLiveApp(environment.url.replace(/\/$/, ""), routes.map((route) => route.path));
        discoveredPages = discovery.pages;
        discoveryError = discovery.pages.length ? undefined : (discovery.error ?? "no pages could be crawled");
      }

      // B. Deep code context: AST summaries of reachable components (handlers,
      // rendered elements, API calls, state). Compact per-component records.
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
        codeContext = summarizeCodebase(reachableSourceFiles).slice(0, 60);
      } catch (contextError) {
        console.warn(`Code-context extraction skipped: ${contextError instanceof Error ? contextError.message : contextError}`);
      }

      const knowledgeModel = {
        framework,
        language,
        routes,
        features: routes.map((route) => ({ name: route.feature, kind: "page", path: route.path })),
        reachableComponents,
        codeContext,
        discoveredPages,
        discoveryError: discoveredPages.length ? undefined : (discoveryError ?? "no environment URL configured for this project"),
        analyzedFiles: [...sources.keys()].filter((path) => path !== "package.json"),
        fileCapReached: prioritizedCount >= MAX_FILES && codePaths.length > MAX_FILES
      };

      return await this.prisma.analysisRun.update({
        where: { id: analysis.id },
        data: { status: "COMPLETED", knowledgeModel: knowledgeModel as never, completedAt: new Date() }
      });
    } catch (error) {
      await this.prisma.analysisRun.update({
        where: { id: analysis.id },
        data: { status: "FAILED", errorMessage: error instanceof Error ? error.message : "Analysis failed", completedAt: new Date() }
      });
      throw error;
    }
  }

  list(user: AuthenticatedUser, projectId: string) {
    return this.prisma.analysisRun.findMany({ where: { organizationId: user.organizationId, projectId }, orderBy: { createdAt: "desc" } });
  }

  private detectProvider(url: string): "GITHUB" | "BITBUCKET" | "GITLAB" {
    if (/bitbucket\.org/i.test(url)) return "BITBUCKET";
    if (/gitlab\./i.test(url)) return "GITLAB";
    return "GITHUB";
  }

  private async resolveBranch(provider: AnalysisProvider, repository: string, branch: string, headers: Record<string, string>) {
    const url = provider === "BITBUCKET"
      ? `https://api.bitbucket.org/2.0/repositories/${repository}/refs/branches/${encodeURIComponent(branch)}`
      : `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(branch)}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const label = provider === "BITBUCKET" ? "Bitbucket" : "GitHub";
      if (response.status === 401) throw new BadRequestException(`${label} rejected this organization's saved access token (401). Open Settings, disconnect the ${label} account, and connect it again to refresh the token.`);
      if (response.status === 404) throw new BadRequestException(`${label} could not find ${repository} (404) at branch ${branch} with the connected account — check the repository URL and that the connected ${label} user has access.`);
      if (response.status === 403) throw new BadRequestException(`${label} rate limit or permission denied (403) for the connected account. Try again shortly, or reconnect with an account that has access.`);
      throw new BadRequestException(`${label} branch lookup failed with status ${response.status}`);
    }
    return provider === "BITBUCKET"
      ? (await response.json() as BitbucketBranch).target.hash
      : (await response.json() as GithubBranch).commit.sha;
  }

  private async collectSources(provider: AnalysisProvider, repository: string, commitSha: string, headers: Record<string, string>) {
    return provider === "BITBUCKET" ? this.bitbucketSources(repository, commitSha, headers) : this.githubSources(repository, commitSha, headers);
  }

  private async githubSources(repository: string, commitSha: string, headers: Record<string, string>): Promise<RepositorySnapshot> {
    const treeResponse = await fetch(`https://api.github.com/repos/${repository}/git/trees/${commitSha}?recursive=1`, { headers });
    if (!treeResponse.ok) throw new BadRequestException(`GitHub tree lookup failed with status ${treeResponse.status}`);
    const tree = await treeResponse.json() as GithubTree;

    const codePaths = tree.tree
      .filter((entry) => entry.type === "blob" && /\.(tsx?|jsx?)$/.test(entry.path) && (entry.size ?? 0) < 250_000)
      .map((entry) => entry.path);
    const prioritized = prioritizePaths(codePaths).slice(0, MAX_FILES);

    // Fetch in chunks to stay friendly to GitHub's secondary rate limits.
    const sources = new Map<string, string>();
    for (let index = 0; index < prioritized.length; index += FETCH_CHUNK) {
      const chunk = prioritized.slice(index, index + FETCH_CHUNK);
      const entries = await Promise.all(chunk.map(async (path) => {
        const entry = tree.tree.find((candidate) => candidate.path === path)!;
        return [path, await this.readBlob(repository, entry.sha, headers)] as const;
      }));
      for (const [path, content] of entries) if (content) sources.set(path, content);
    }
    const packageEntry = tree.tree.find((entry) => entry.path === "package.json" && entry.type === "blob");
    if (packageEntry) sources.set("package.json", await this.readBlob(repository, packageEntry.sha, headers));
    return { sources, codePaths, prioritizedCount: prioritized.length };
  }

  private async bitbucketSources(repository: string, commitSha: string, headers: Record<string, string>): Promise<RepositorySnapshot> {
    // Bitbucket has no recursive tree endpoint: walk the src listing breadth-first,
    // following its pagination. Raw file reads must not send Accept: application/json,
    // or Bitbucket answers with file metadata instead of the contents.
    const rawHeaders: Record<string, string> = { Authorization: headers.Authorization };
    const codePaths: string[] = [];
    const directories = [""];
    let hasPackageJson = false;
    let seen = 0;
    while (directories.length && seen < MAX_TREE_ENTRIES) {
      const directory = directories.shift()!;
      let next = `https://api.bitbucket.org/2.0/repositories/${repository}/src/${commitSha}/${directory ? `${directory}/` : ""}?pagelen=100`;
      do {
        const pageResponse = await fetch(next, { headers });
        if (!pageResponse.ok) throw new BadRequestException(`Bitbucket tree lookup failed with status ${pageResponse.status}`);
        const page = await pageResponse.json() as BitbucketSrcPage;
        for (const entry of page.values ?? []) {
          if (entry.path === "package.json") hasPackageJson = true;
          if (entry.type === "commit_directory") directories.push(entry.path);
          else if (entry.type === "commit_file" && /\.(tsx?|jsx?)$/.test(entry.path) && (entry.size ?? 0) < 250_000) codePaths.push(entry.path);
        }
        seen += page.values?.length ?? 0;
        next = page.next ?? "";
      } while (next && seen < MAX_TREE_ENTRIES);
    }

    const prioritized = prioritizePaths(codePaths).slice(0, MAX_FILES);
    const sources = new Map<string, string>();
    for (let index = 0; index < prioritized.length; index += FETCH_CHUNK) {
      const chunk = prioritized.slice(index, index + FETCH_CHUNK);
      const entries = await Promise.all(chunk.map(async (path) => [path, await this.readBitbucketFile(repository, commitSha, path, rawHeaders)] as const));
      for (const [path, content] of entries) if (content) sources.set(path, content);
    }
    if (hasPackageJson) sources.set("package.json", await this.readBitbucketFile(repository, commitSha, "package.json", rawHeaders));
    return { sources, codePaths, prioritizedCount: prioritized.length };
  }

  private async readBlob(repository: string, sha: string, headers: Record<string, string>) {
    const response = await fetch(`https://api.github.com/repos/${repository}/git/blobs/${sha}`, { headers });
    if (!response.ok) return "";
    const blob = await response.json() as GithubBlob;
    return blob.encoding === "base64" ? Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString("utf8") : "";
  }

  private async readBitbucketFile(repository: string, commitSha: string, path: string, headers: Record<string, string>) {
    const response = await fetch(`https://api.bitbucket.org/2.0/repositories/${repository}/src/${commitSha}/${path}`, { headers });
    if (!response.ok) return "";
    return response.text();
  }

  private repositoryFullName(url: string, provider: AnalysisProvider) {
    const pattern = provider === "BITBUCKET"
      ? /bitbucket\.org[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/
      : /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/;
    const match = url.match(pattern);
    if (!match) throw new BadRequestException(`Project repository must be a ${provider === "BITBUCKET" ? "Bitbucket workspace" : "GitHub owner"}/repository URL`);
    return `${match[1]}/${match[2]}`;
  }
}
