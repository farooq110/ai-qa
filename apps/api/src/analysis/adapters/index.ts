import type { ModelProvider } from "@ai-qa/model-provider";
import { fileBasedRoutes, type PackageInfo } from "./file-based";
import { reactRouterRoutes } from "./react-router";
import type { RouteHint } from "./types";
import { resolveImport, type AliasRule } from "../analyzer";

export type { RouteHint } from "./types";

const ROUTER_LIBRARY = /react-router|vue-router|@angular\/router|@tanstack\/(?:react-)?router|wouter|reach\/router|svelte-routing|page\.js|navigo/;
const ROUTER_FILE = /(?:^|\/)(?:router|routes?|routing|app[.-]routes?|app[.-]routing|navigation)[^/]*\.[jt]sx?$|(?:^|\/)(?:App|main|index)\.[jt]sx?$/i;

/**
 * Route hints from the code. Deterministic adapters first (file-based frameworks, React Router AST);
 * only when a router library is installed and nothing was found does the model read the router
 * files. Every hint is verified against the running app before it is used for tests.
 */
export async function codeRouteHints(
  sources: Map<string, string>, allPaths: string[], provider: ModelProvider | null,
  configs: Map<string, string> = new Map(), aliases: AliasRule[] = []
): Promise<RouteHint[]> {
  const packageJson = sources.get("package.json") ?? "";
  // One PackageInfo per package.json found (root + each app in a monorepo), so file-based routing
  // scopes to the app that actually declares the framework instead of the whole repo.
  const packages: PackageInfo[] = [...configs].filter(([file]) => /(^|\/)package\.json$/.test(file))
    .map(([file, json]) => ({ dir: file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "", json }));
  if (!packages.length) packages.push({ dir: "", json: packageJson });
  const hints = new Map<string, RouteHint>();
  for (const hint of [...fileBasedRoutes([...allPaths, ...sources.keys()], packages), ...reactRouterRoutes(sources, aliases)]) {
    if (!hints.has(hint.pattern)) hints.set(hint.pattern, hint);
  }
  if (hints.size || !provider || !ROUTER_LIBRARY.test(packageJson)) return [...hints.values()];

  // Fallback: ask the model to list the routes in the router files (small, capped input).
  let budget = 30_000;
  const files: Record<string, string> = {};
  for (const [file, content] of sources) {
    if (!ROUTER_FILE.test(file) || !ROUTER_LIBRARY.test(content + file) && !/routes?|router/i.test(content.slice(0, 4_000))) continue;
    if (content.length > budget) continue;
    files[file] = content;
    budget -= content.length;
  }
  if (!Object.keys(files).length) return [];
  const allFiles = new Set(sources.keys());
  const routerFiles = Object.keys(files);
  // The model reports "file" however the router file itself wrote it: a real path, a relative
  // import ("./views/Home"), or a bare alias ("@/views/Home"). Only a real key into `sources` is
  // useful downstream (code-context, flow-spec slicing); resolve it the same way a real import
  // would, trying each router file as the "from" context since we don't track which one named it.
  const resolveHintFile = (raw: string): string | undefined => {
    if (allFiles.has(raw)) return raw;
    for (const fromFile of routerFiles) {
      const resolved = resolveImport(raw, fromFile, allFiles, aliases);
      if (resolved) return resolved;
    }
    return undefined;
  };
  try {
    const response = await provider.generateStructured<{ routes?: Array<{ path?: string; file?: string }> }>({
      organizationId: "", projectId: "", jobId: "route-discovery", capability: "classification",
      systemPrompt: "You read web application router configuration. Return ONLY JSON {\"routes\":[{\"path\":string,\"file\":string?}]}: every page route (full URL path from the app root, with :param segments), and the source file of its page component when it is visible. Skip wildcard/404 routes. Never invent routes that the files do not declare.",
      prompt: JSON.stringify({ files }), schemaName: "RouteList", schema: {}, temperature: 0
    });
    for (const route of response.output?.routes ?? []) {
      const path = String(route?.path ?? "").trim();
      if (!path || path === "*" || /[\s{}]/.test(path)) continue;
      const pattern = ("/" + path).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
      const resolvedFile = route.file ? resolveHintFile(String(route.file)) : undefined;
      if (!hints.has(pattern)) hints.set(pattern, { pattern, framework: "llm", ...(resolvedFile ? { file: resolvedFile } : {}) });
    }
  } catch { /* the fallback is best effort */ }
  return [...hints.values()];
}
