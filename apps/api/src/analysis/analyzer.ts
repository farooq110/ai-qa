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
  /** Source file of the page, when routing is file-based (Next.js). */
  file?: string;
  /** Parameters the page reads: `:name` path segments and query keys found in its code. */
  params?: RouteParam[];
  /** The page file plus its near import neighborhood (see importNeighborhood): where code context is read from. */
  files?: string[];
}

export interface RouteParam { name: string; in: "path" | "query" }

export interface ImportEdge {
  names: string[];
  specifier: string;
}

/** `@/*` or a bare `baseUrl` import, resolved under one directory of the repo (a package in a monorepo). */
export interface AliasRule {
  /** Package directory this rule applies in ("" = repo root). */
  dir: string;
  /** Specifier prefix this rule rewrites, e.g. "@/" ("" = any bare specifier, via baseUrl). */
  prefix: string;
  /** Repo-relative directory the prefix maps to. */
  target: string;
}

export interface ImportGraph {
  importsByFile: Map<string, ImportEdge[]>;
  exportsByFile: Map<string, Set<string>>;
  aliases: AliasRule[];
}

const CONFIG_FILE = /(?:^|\/)(?:tsconfig|jsconfig)[^/]*\.json$/;
const VITE_CONFIG_FILE = /(?:^|\/)vite\.config\.[cm]?[jt]s$/;
// Vite's own alias object, inside resolve.alias: { "@": fileURLToPath(new URL("./src", ...)) } or
// { "@": path.resolve(__dirname, "./src") } or a plain { "@": "./src" } string - the handful of
// shapes vite.config files actually use in practice, not a JS evaluator.
const VITE_ALIAS_ENTRY = /["'`]([^"'`]+)["'`]\s*:\s*(?:fileURLToPath\(\s*new URL\(\s*["'`]([^"'`]+)["'`]|path\.(?:resolve|join)\([^,]*,\s*["'`]([^"'`]+)["'`]\)|["'`]([^"'`]+)["'`])/g;

interface TsconfigOptions { baseUrl?: string; paths?: Record<string, string[]> }

/** `tsconfig.json#compilerOptions.paths` / `baseUrl`, and vite.config's `resolve.alias` - one rule per config file found (and any relative tsconfig `extends` it follows), longest `dir` wins first. */
export function aliasRules(configs: Map<string, string>): AliasRule[] {
  const rules: AliasRule[] = [];
  for (const [file, content] of configs) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    if (VITE_CONFIG_FILE.test(file)) {
      const aliasBlock = content.match(/resolve\s*:\s*\{[^]*?alias\s*:\s*\{([^]*?)\}/)?.[1] ?? content.match(/\balias\s*:\s*\{([^]*?)\}/)?.[1];
      if (!aliasBlock) continue;
      for (const match of aliasBlock.matchAll(VITE_ALIAS_ENTRY)) {
        const target = match[2] ?? match[3] ?? match[4];
        if (!target) continue;
        rules.push({ dir, prefix: match[1], target: [dir, target.replace(/^\.\/?/, "")].filter(Boolean).join("/").replace(/\/+/g, "/") });
      }
      continue;
    }
    if (!CONFIG_FILE.test(file)) continue;
    const options = resolveTsconfig(file, configs, new Set());
    if (!options) continue;
    const baseUrl = (options.baseUrl ?? ".").replace(/^\.\/?/, "");
    const join = (sub: string) => [dir, baseUrl, sub].filter(Boolean).join("/").replace(/\/+/g, "/");
    for (const [key, value] of Object.entries(options.paths ?? {})) {
      const target = join((value[0] ?? "").replace(/\*$/, ""));
      rules.push({ dir, prefix: key.replace(/\*$/, ""), target });
    }
    if (options.baseUrl) rules.push({ dir, prefix: "", target: join("") });
  }
  return rules.sort((a, b) => b.dir.length - a.dir.length || b.prefix.length - a.prefix.length);
}

/** Parses one tsconfig's compilerOptions, merging in a relative `extends` chain (cycle-safe). */
function resolveTsconfig(file: string, configs: Map<string, string>, seen: Set<string>): TsconfigOptions | undefined {
  const content = configs.get(file);
  if (!content || seen.has(file)) return undefined;
  seen.add(file);
  let parsed: { extends?: string; compilerOptions?: TsconfigOptions } | undefined;
  try {
    // ts-morph re-exports the TypeScript compiler; its config parser tolerates comments and trailing commas.
    const tsModule = require("ts-morph").ts as { parseConfigFileTextToJson: (fileName: string, text: string) => { config?: { extends?: string; compilerOptions?: TsconfigOptions } } };
    parsed = tsModule.parseConfigFileTextToJson(file, content).config;
  } catch { return undefined; }
  const own = parsed?.compilerOptions;
  const extendsPath = parsed?.extends;
  if (!extendsPath?.startsWith(".")) return own;
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const base = normalizePath(`${dir}/${extendsPath}`);
  const candidate = [...configs.keys()].find((path) => path === base || path === `${base}.json`);
  const parent = candidate ? resolveTsconfig(candidate, configs, seen) : undefined;
  return { ...parent, ...own, paths: { ...parent?.paths, ...own?.paths } };
}

const GENERIC_NAMES = new Set([
  "App", "AppShell", "Index", "Main", "Root", "Wrapper", "Container", "Layout",
  "Page", "ErrorBoundary", "Provider", "Routes", "Route", "Router", "Component",
  "ThemeProvider", "BrowserRouter", "HashRouter", "MemoryRouter", "Suspense", "Fragment"
]);

export function prioritizePaths(paths: string[]): string[] {
  const score = (path: string): number => {
    if (/(^|\/)(routes|pages|views|screens)\//i.test(path) || /(^|\/)page\.[jt]sx?$/.test(path)) return 0;
    if (/(^|\/)(App|app|main|index|Bootstrap)\.(t|j)sx?$/.test(path)) return 1;
    if (/(^|\/)components?\//i.test(path)) return 2;
    return 3;
  };
  return [...paths].sort((a, b) => score(a) - score(b) || a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** Extract real routes from React Router declarations and Next.js file-based routing. */
export function extractRoutes(sources: Map<string, string>): RouteInfo[] {
  const routes = new Map<string, RouteInfo>();
  const consider = (path: string, page: string, file?: string) => {
    const cleanPath = path.trim();
    const cleanPage = page.split(".").pop()?.trim() ?? page.trim();
    if (!cleanPath || !cleanPage || routes.has(cleanPath)) return;
    routes.set(cleanPath, { path: cleanPath, page: cleanPage, feature: featureName(cleanPath, cleanPage), ...(file ? { file } : {}) });
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

/**
 * URL path for a Next.js page file under `appDir` ("" = repo root; scopes a monorepo's Next app so
 * other apps' `pages/` folders are never mistaken for Next routes), or null if the file is not a page.
 * App Router: app/(group)/shop/[id]/page.tsx → /shop/:id. Pages Router: pages/blog/[slug].tsx → /blog/:slug.
 * A parallel slot (@dashboard) adds no URL segment, like a route group — two slots at the same URL, first wins.
 * Intercepting ((.)x) and private (_x) segments are not standalone pages and are skipped.
 */
export function nextRoutePath(file: string, appDir = ""): string | null {
  const under = appDir ? file.startsWith(`${appDir}/`) ? file.slice(appDir.length + 1) : null : file;
  if (under === null) return null;
  const app = under.match(/(?:^|\/)(?:src\/)?app\/((?:[^/]+\/)*)page\.[jt]sx?$/);
  const pages = app ? null : under.match(/(?:^|\/)(?:src\/)?pages\/(.+)\.[jt]sx?$/);
  const raw = app ? app[1].split("/").filter(Boolean) : pages ? pages[1].split("/") : null;
  if (!raw) return null;
  if (pages && (raw[0] === "api" || raw.some((segment) => segment.startsWith("_")))) return null;
  const segments: string[] = [];
  for (const segment of raw) {
    if (/^\(\.+\)/.test(segment) || segment.startsWith("_")) return null;
    if (/^\(.*\)$/.test(segment) || segment.startsWith("@")) continue; // route group or parallel slot: no URL segment
    const dynamic = segment.match(/^\[\[?(\.\.\.)?([^\]]+)\]\]?$/);
    segments.push(dynamic ? `:${dynamic[2]}${dynamic[1] ? "*" : ""}` : segment);
  }
  if (pages && segments[segments.length - 1] === "index") segments.pop();
  return `/${segments.join("/")}`;
}

export function featureName(path: string, page: string): string {
  const fromPage = page.replace(/Page$/i, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  if (path === "/" || path === "") return fromPage || "Home";
  // Dynamic segments (:id, :slug*) name nothing; skip them rather than truncating — /:countryCode/cart is "Cart".
  const fromPath = path.split("/").filter((part) => part && !/^[:*]/.test(part)).map((part) => part.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())).join(" ");
  return fromPath || fromPage || path;
}

/** Build import edges and exported-name sets for every fetched source file. */
export function buildImportGraph(sources: Map<string, string>, aliases: AliasRule[] = []): ImportGraph {
  const importsByFile = new Map<string, ImportEdge[]>();
  const exportsByFile = new Map<string, Set<string>>();
  const importRe = /import\s+(?:type\s+)?(?:(\w+)\s*,\s*)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))?\s*from\s*["']([^"']+)["']/g;
  // Side-effect import ("import './x'") and dynamic import()/require() carry no names of their own,
  // but they still create a reachability edge (lazy-loaded route pages resolve through these).
  const sideEffectImportRe = /import\s*["']([^"']+)["']/g;
  const dynamicImportRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  const exportDeclRe = /export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z0-9_]+)/g;
  const exportListRe = /export\s*\{([^}]+)\}(?!\s*from)/g;
  // Re-exports: "export * from 'x'" (no local names to add) and "export {a, b} from 'x'" (adds a
  // reachability edge AND makes a/b resolvable through this file, i.e. a barrel).
  const exportStarRe = /export\s*\*\s*(?:as\s+\w+\s+)?from\s*["']([^"']+)["']/g;
  const exportFromRe = /export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;

  for (const [file, content] of sources) {
    const edges: ImportEdge[] = [];
    for (const match of content.matchAll(importRe)) {
      const names: string[] = [];
      if (match[1]) names.push(match[1]);
      if (match[2]) names.push(...match[2].split(",").map((part) => part.split(/\s+as\s+/).pop()?.trim() ?? "").filter(Boolean));
      if (!names.length && match[4]) names.push(match[4]);
      if (names.length) edges.push({ names, specifier: match[5] });
    }
    for (const match of content.matchAll(sideEffectImportRe)) edges.push({ names: [], specifier: match[1] });
    for (const match of content.matchAll(dynamicImportRe)) edges.push({ names: [], specifier: match[1] });
    for (const match of content.matchAll(requireRe)) edges.push({ names: [], specifier: match[1] });
    for (const match of content.matchAll(exportStarRe)) edges.push({ names: [], specifier: match[1] });
    for (const match of content.matchAll(exportFromRe)) {
      const names = match[1].split(",").map((part) => part.split(/\s+as\s+/).pop()?.trim() ?? "").filter(Boolean);
      edges.push({ names, specifier: match[2] });
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
    for (const match of content.matchAll(exportFromRe)) {
      for (const part of match[1].split(",")) {
        const name = part.split(/\s+as\s+/).pop()?.trim();
        if (name) exported.add(name);
      }
    }
    exportsByFile.set(file, exported);
  }
  return { importsByFile, exportsByFile, aliases };
}

/** A specifier's extension already names a real emitted-JS extension that the source is actually under TS: .js/.mjs/.cjs -> .ts, .jsx -> .tsx. */
const JS_TO_TS: Record<string, string> = { ".js": ".ts", ".mjs": ".ts", ".cjs": ".ts", ".jsx": ".tsx" };

export function resolveImport(specifier: string, fromFile: string, filePaths: Set<string>, aliases: AliasRule[] = []): string | null {
  const bare = specifier.replace(/[?#].*$/, ""); // drop a trailing ?query or #hash (e.g. Vite's "?raw")
  let base: string;
  if (bare.startsWith(".")) {
    const dir = fromFile.split("/").slice(0, -1).join("/");
    base = normalizePath(`${dir}/${bare}`);
  } else {
    // Longest matching package dir, then longest matching prefix (aliasRules is pre-sorted that way).
    const rule = aliases.find((entry) => (entry.dir === "" || fromFile === entry.dir || fromFile.startsWith(`${entry.dir}/`)) && bare.startsWith(entry.prefix));
    if (!rule) return null;
    base = normalizePath(`${rule.target}/${bare.slice(rule.prefix.length)}`);
  }
  const explicitExt = base.match(/(\.[a-z]+)$/i)?.[1];
  const remapped = explicitExt && JS_TO_TS[explicitExt] ? base.slice(0, -explicitExt.length) + JS_TO_TS[explicitExt] : null;
  // .vue/.svelte/.astro alongside the TS/JS set: a bare specifier names a component file in any
  // of these frameworks the same way, and resolution here is generic file-extension matching, not
  // framework logic.
  const candidates = [
    base, remapped,
    `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`, `${base}.vue`, `${base}.svelte`, `${base}.astro`,
    `${base}/index.tsx`, `${base}/index.ts`, `${base}/index.jsx`, `${base}/index.js`, `${base}/index.vue`
  ].filter((candidate): candidate is string => Boolean(candidate));
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
    const file = route.file ?? nameToFile.get(route.page);
    if (file) frontier.push(file);
  }
  const reachable = new Set<string>(frontier);
  while (frontier.length) {
    const file = frontier.pop()!;
    for (const edge of graph.importsByFile.get(file) ?? []) {
      const target = resolveImport(edge.specifier, file, allFiles, graph.aliases);
      if (target && !reachable.has(target)) {
        reachable.add(target);
        frontier.push(target);
      }
    }
  }
  return reachable;
}

const SEARCH_PARAM_API = /useSearchParams|URLSearchParams|searchParams|location\.search|router\.query|useRouter/;
const NOT_A_PARAM = new Set(["get", "getAll", "has", "set", "append", "delete", "toString", "entries", "keys", "values", "forEach", "size", "sort"]);

/**
 * Parameters each page needs: `:name` path segments (always) plus query keys the page
 * code reads (page file + its direct relative imports). Names only — values come from
 * environment fixtures, since code cannot say which values exist in a deployed app.
 */
export function extractRouteParams(routes: RouteInfo[], sources: Map<string, string>, graph: ImportGraph): RouteInfo[] {
  const nameToFile = new Map<string, string>();
  for (const [file, exported] of graph.exportsByFile) for (const name of exported) if (!nameToFile.has(name)) nameToFile.set(name, file);
  const allFiles = new Set(sources.keys());
  return routes.map((route) => {
    const params = new Map<string, RouteParam>();
    for (const match of route.path.matchAll(/:([A-Za-z_]\w*)/g)) params.set(match[1], { name: match[1], in: "path" });
    const pageFile = route.file ?? nameToFile.get(route.page);
    const files = pageFile ? [pageFile, ...(graph.importsByFile.get(pageFile) ?? []).map((edge) => resolveImport(edge.specifier, pageFile, allFiles, graph.aliases)).filter((file): file is string => Boolean(file))] : [];
    for (const file of files) {
      const content = sources.get(file) ?? "";
      if (!SEARCH_PARAM_API.test(content)) continue;
      const names: string[] = [];
      for (const match of content.matchAll(/\.get\(\s*["'`]([\w-]+)["'`]\s*\)/g)) names.push(match[1]);
      for (const match of content.matchAll(/\b(?:searchParams|query)\.([A-Za-z_]\w*)/g)) if (!NOT_A_PARAM.has(match[1])) names.push(match[1]);
      for (const match of content.matchAll(/\b(?:searchParams|query)\[\s*["'`]([\w-]+)["'`]\s*\]/g)) names.push(match[1]);
      for (const match of content.matchAll(/\{([^{}]+)\}\s*=\s*(?:router\.)?(?:query|searchParams)\b/g)) {
        for (const part of match[1].split(",")) names.push(part.split(":")[0].split("=")[0].trim());
      }
      for (const name of names) if (/^[A-Za-z_][\w-]*$/.test(name) && !params.has(name)) params.set(name, { name, in: "query" });
    }
    return params.size ? { ...route, params: [...params.values()] } : route;
  });
}

/** A page file plus its near import neighborhood (BFS, capped), so code context can attach to a route by real file identity. */
export function importNeighborhood(file: string, sources: Map<string, string>, graph: ImportGraph, hops = 2, cap = 12): string[] {
  const allFiles = new Set(sources.keys());
  const result = [file];
  let frontier = [file];
  for (let hop = 0; hop < hops && result.length < cap; hop++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of graph.importsByFile.get(current) ?? []) {
        const target = resolveImport(edge.specifier, current, allFiles, graph.aliases);
        if (target && !result.includes(target)) { result.push(target); next.push(target); if (result.length >= cap) break; }
      }
      if (result.length >= cap) break;
    }
    frontier = next;
  }
  return result;
}

/** How many of `entries`' reachable sets a file falls into — a shared/leaf file (e.g. a UI button) has high fan-in across unrelated route entries, while a module-specific file has low fan-in. */
export function fanIn(graph: ImportGraph, entries: Array<{ file: string; sources: Map<string, string> }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { file, sources } of entries) {
    const reachable = reachableFromRoutes([{ path: "", page: "", feature: "", file }], sources, graph);
    for (const path of reachable) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/**
 * Breadth-first slice of the import graph starting at `entries`, stopping once the token budget
 * (chars / 3.5) is spent. Skips files `shared` flags as fan-in noise (e.g. a generic button
 * component every page imports) so the budget goes to module-specific code. Closer files (fewer
 * hops) are included first.
 */
export function sliceModule(
  entries: string[],
  sources: Map<string, string>,
  graph: ImportGraph,
  options: { budgetTokens: number; shared?: Set<string> }
): string[] {
  const allFiles = new Set(sources.keys());
  const result: string[] = [];
  let usedChars = 0;
  const budgetChars = options.budgetTokens * 3.5;
  let frontier = [...new Set(entries)];
  const seen = new Set(frontier);
  while (frontier.length && usedChars < budgetChars) {
    const next: string[] = [];
    for (const file of frontier) {
      if (options.shared?.has(file)) continue;
      const content = sources.get(file);
      if (content === undefined) continue;
      if (usedChars + content.length > budgetChars && result.length > 0) continue; // always take at least the entry file
      result.push(file);
      usedChars += content.length;
      for (const edge of graph.importsByFile.get(file) ?? []) {
        const target = resolveImport(edge.specifier, file, allFiles, graph.aliases);
        if (target && !seen.has(target)) { seen.add(target); next.push(target); }
      }
    }
    if (usedChars >= budgetChars) break;
    frontier = next;
  }
  return result;
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
