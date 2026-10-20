/**
 * Dev-only benchmark: run the real analysis functions against a repo on disk and print how much of
 * it they actually see. Not wired into CI or the app - it's how the code-analysis bug-fix batch was
 * measured, and how to re-measure it on a real app later.
 *
 * Run: pnpm exec tsc -p tsconfig.json --outDir .check-out && node .check-out/analysis/analysis.bench.js <repoDir> [rootDir]
 * (delete .check-out afterwards)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  aliasRules, buildImportGraph, extractRouteParams, extractRoutes, importNeighborhood,
  prioritizePaths, reachableFromRoutes
} from "./analyzer";
import { codeRouteHints } from "./adapters";
import { summarizeCodebase } from "./code-context";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".nuxt", ".git", "out"]);
const CODE_FILE = /\.(tsx?|jsx?|vue|svelte|astro)$/;
const CONFIG_FILE = /(^|\/)(package\.json|(?:tsconfig|jsconfig)[^/]*\.json|next\.config\.(?:[cm]?[jt]s))$/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

async function main() {
  const [repoDir, rootDir = ""] = process.argv.slice(2);
  if (!repoDir) { console.error("usage: analysis.bench.js <repoDir> [rootDir]"); process.exitCode = 1; return; }
  const root = join(repoDir, rootDir);
  const allFiles = walk(root).map((file) => relative(repoDir, file));
  const codePaths = allFiles.filter((file) => CODE_FILE.test(file) && statSync(join(repoDir, file)).size < 250_000);
  const configFiles = allFiles.filter((file) => CONFIG_FILE.test(file));
  const prioritized = prioritizePaths(codePaths.filter((file) => /\.(tsx?|jsx?)$/.test(file))).slice(0, 600);
  const sources = new Map(prioritized.map((file) => [file, readFileSync(join(repoDir, file), "utf8")]));
  const configs = new Map(configFiles.map((file) => [file, readFileSync(join(repoDir, file), "utf8")]));

  const aliases = aliasRules(configs);
  const hints = await codeRouteHints(sources, codePaths, null, configs, aliases);
  const regex = extractRoutes(sources);
  const graph = buildImportGraph(sources, aliases);
  const seen = new Set(hints.map((hint) => hint.pattern));
  const merged = [...hints.map((hint) => ({ path: hint.pattern, page: "x", feature: "x", file: hint.file })), ...regex.filter((route) => !seen.has(route.path))];
  const withParams = extractRouteParams(merged, sources, graph);
  const routes = withParams.map((route) => (route.file ? { ...route, files: importNeighborhood(route.file, sources, graph) } : route));
  const reachable = reachableFromRoutes(routes, sources, graph);
  const ctx = summarizeCodebase(new Map([...reachable].filter((file) => sources.has(file)).map((file) => [file, sources.get(file)!])));

  const routeFiles = [...new Set(routes.map((route) => route.file).filter((file): file is string => Boolean(file)))];
  const ctxFiles = new Set(ctx.map((entry) => entry.file));
  const elements = ctx.reduce((sum, entry) => sum + entry.renderedElements.length, 0);
  const apiCalls = [...new Set(ctx.flatMap((entry) => entry.apiCalls))];

  console.log(JSON.stringify({
    repoDir, rootDir, configFiles: configFiles.length, aliasRules: aliases.length,
    codeFiles: codePaths.length, routesFound: routes.length, routesWithFile: routes.filter((route) => route.file).length,
    reachableFiles: reachable.size, routeFilesWithContext: routeFiles.filter((file) => ctxFiles.has(file)).length, routeFiles: routeFiles.length,
    contextComponents: ctx.length, elementsExtracted: elements, apiCallStrings: apiCalls.length, apiCallSample: apiCalls.slice(0, 8)
  }, null, 1));
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
