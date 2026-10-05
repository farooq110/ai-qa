/**
 * Semantic analyzer: turns raw repository sources into a grounded knowledge
 * model — real routes from the router config, and component reachability from
 * the import graph, so "capabilities" reflect user-facing features instead of
 * every exported identifier in the codebase.
 */

export interface RouteInfo {
  path: string;
  page: string;
  feature: string;
}

export interface ImportEdge {
  names: string[];
  specifier: string;
}

export interface ImportGraph {
  importsByFile: Map<string, ImportEdge[]>;
  exportsByFile: Map<string, Set<string>>;
}

const GENERIC_NAMES = new Set([
  "App", "AppShell", "Index", "Main", "Root", "Wrapper", "Container", "Layout",
  "Page", "ErrorBoundary", "Provider", "Routes", "Route", "Router", "Component",
  "ThemeProvider", "BrowserRouter", "HashRouter", "MemoryRouter", "Suspense", "Fragment"
]);

export function prioritizePaths(paths: string[]): string[] {
  const score = (path: string): number => {
    if (/(^|\/)(routes|pages|views|screens)\//i.test(path)) return 0;
    if (/(^|\/)(App|app|main|index|Bootstrap)\.(t|j)sx?$/.test(path)) return 1;
    if (/(^|\/)components?\//i.test(path)) return 2;
    return 3;
  };
  return [...paths].sort((a, b) => score(a) - score(b) || a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** Extract real routes from router-config-style and JSX-style declarations. */
export function extractRoutes(sources: Map<string, string>): RouteInfo[] {
  const routes = new Map<string, RouteInfo>();
  const consider = (path: string, page: string) => {
    const cleanPath = path.trim();
    const cleanPage = page.split(".").pop()?.trim() ?? page.trim();
    if (!cleanPath || !cleanPage || routes.has(cleanPath)) return;
    routes.set(cleanPath, { path: cleanPath, page: cleanPage, feature: featureName(cleanPath, cleanPage) });
  };

  for (const [file, content] of sources) {
    const isRouterFile = /(^|\/)(routes|router)\//i.test(file) || /createBrowserRouter|createHashRouter|<Routes|RouterProvider|<Route\b/.test(content);
    if (!isRouterFile) continue;

    // Object-style: { path: '/x', element: <Page /> }
    for (const match of content.matchAll(/path:\s*["'`]([^"'`]+)["'`][^{}]*?element:\s*<([A-Za-z0-9_.]+)/g)) {
      consider(match[1], match[2]);
    }
    // JSX-style: <Route path="/x" element={<Page />} />
    for (const match of content.matchAll(/<Route\b[^>]*?path=["']([^"']+)["'][^>]*?element=\{?\s*<([A-Za-z0-9_.]+)/g)) {
      consider(match[1], match[2]);
    }
    // path-only entries where the element follows on a later property
    for (const match of content.matchAll(/element=\{?\s*<([A-Za-z0-9_.]+)[^}]*?path=["']([^"']+)["']/g)) {
      consider(match[2], match[1]);
    }
  }
  return [...routes.values()];
}

export function featureName(path: string, page: string): string {
  const fromPage = page.replace(/Page$/i, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  if (path === "/" || path === "") return fromPage || "Home";
  const fromPath = path.replace(/[:*].*$/, "").split("/").filter(Boolean).map((part) => part.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())).join(" ");
  return fromPath || fromPage || path;
}

/** Build import edges and exported-name sets for every fetched source file. */
export function buildImportGraph(sources: Map<string, string>): ImportGraph {
  const importsByFile = new Map<string, ImportEdge[]>();
  const exportsByFile = new Map<string, Set<string>>();
  const importRe = /import\s+(?:type\s+)?(?:(\w+)\s*,\s*)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))?\s*from\s*["']([^"']+)["']/g;
  const exportDeclRe = /export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z0-9_]+)/g;
  const exportListRe = /export\s*\{([^}]+)\}/g;

  for (const [file, content] of sources) {
    const edges: ImportEdge[] = [];
    for (const match of content.matchAll(importRe)) {
      const names: string[] = [];
      if (match[1]) names.push(match[1]);
      if (match[2]) names.push(...match[2].split(",").map((part) => part.split(/\s+as\s+/).pop()?.trim() ?? "").filter(Boolean));
      if (!names.length && match[4]) names.push(match[4]);
      if (names.length) edges.push({ names, specifier: match[5] });
    }
    importsByFile.set(file, edges);

    const exported = new Set<string>();
    for (const match of content.matchAll(exportDeclRe)) exported.add(match[1]);
    for (const match of content.matchAll(exportListRe)) {
      for (const part of match[1].split(",")) {
        const name = part.split(/\s+as\s+/)[0]?.trim();
        if (name) exported.add(name);
      }
    }
    exportsByFile.set(file, exported);
  }
  return { importsByFile, exportsByFile };
}

export function resolveImport(specifier: string, fromFile: string, filePaths: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = fromFile.split("/").slice(0, -1).join("/");
  const base = normalizePath(`${dir}/${specifier}`);
  const candidates = [
    base,
    `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`,
    `${base}/index.tsx`, `${base}/index.ts`, `${base}/index.jsx`, `${base}/index.js`
  ];
  for (const candidate of candidates) {
    const stripped = candidate.replace(/\/\.\//g, "/");
    if (filePaths.has(stripped)) return stripped;
  }
  return null;
}

/** Files reachable from the route-declared page components (import-graph BFS). */
export function reachableFromRoutes(
  routes: RouteInfo[],
  sources: Map<string, string>,
  graph: ImportGraph
): Set<string> {
  const nameToFile = new Map<string, string>();
  for (const [file, exported] of graph.exportsByFile) {
    for (const name of exported) if (!nameToFile.has(name)) nameToFile.set(name, file);
  }
  const allFiles = new Set(sources.keys());
  const frontier: string[] = [];
  for (const route of routes) {
    const file = nameToFile.get(route.page);
    if (file) frontier.push(file);
  }
  const reachable = new Set<string>(frontier);
  while (frontier.length) {
    const file = frontier.pop()!;
    for (const edge of graph.importsByFile.get(file) ?? []) {
      const target = resolveImport(edge.specifier, file, allFiles);
      if (target && !reachable.has(target)) {
        reachable.add(target);
        frontier.push(target);
      }
    }
  }
  return reachable;
}

/** Exported PascalCase component names defined inside reachable files. */
export function extractComponentNames(sources: Map<string, string>, reachableFiles: Set<string>): string[] {
  const names = new Set<string>();
  for (const file of reachableFiles) {
    const content = sources.get(file);
    if (!content) continue;
    for (const match of content.matchAll(/export\s+(?:async\s+)?(?:const|function|class)\s+([A-Z][A-Za-z0-9_]*)/g)) {
      names.add(match[1]);
    }
    for (const match of content.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of match[1].split(",")) {
        const name = part.split(/\s+as\s+/).pop()?.trim() ?? "";
        if (/^[A-Z]/.test(name)) names.add(name);
      }
    }
  }
  return [...names].filter((name) => isFeatureWorthy(name));
}

/** Noise gate: constants, hooks, single letters, and generic app scaffolding. */
export function isFeatureWorthy(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 3) return false;
  if (/^[A-Z0-9_]+$/.test(trimmed)) return false;
  if (/^use[A-Z]/.test(trimmed)) return false;
  if (GENERIC_NAMES.has(trimmed)) return false;
  if (/(Modal)?Root$|Context$|Provider$|Reducer$|Service$|Helpers?$|Utils$|Types$|Enum$|Constants$/i.test(trimmed)) return false;
  return true;
}

function normalizePath(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
