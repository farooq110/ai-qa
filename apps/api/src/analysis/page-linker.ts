/**
 * Links each crawled page to the source file that renders it, by the text the page shows.
 *
 * Reading a router's code finds a page's file only for the routing styles we have written a reader for;
 * every app writes its visible text (headings, buttons, field labels) as literals in its source files,
 * whatever its router looks like. So: take the text distinctive to a page, find which UI files contain
 * it, and take the file that best explains it. Pages the route readers already linked are left alone.
 */
import { isAuthRoute } from "@ai-qa/test-dsl";
import { featureName, importNeighborhood, resolveImport, type ImportGraph, type RouteInfo } from "./analyzer";
import type { DiscoveredPage } from "./live-discovery";

const UI_FILE = /\.(?:[jt]sx?|vue|svelte|astro|html)$/;
const NOT_UI_FILE = /\.(?:test|spec|stories|d)\.[jt]sx?$|(?:^|\/)(?:__tests__|__mocks__|node_modules|dist|build)\//;
/** Text on at least this share of the crawled pages is chrome (sidebar, header, footer), not the page's own. */
const CHROME_SHARE = 0.3;
/** A phrase found in more files than this is a common word ("Save", "Name"): it explains no page. */
const MAX_FILES_PER_PHRASE = 15;
/** A file above this share of the linked pages' files is a router/layout/barrel, never a page. */
const HUB_SHARE = 0.25;

export interface PageLink { pattern: string; file: string; phrases: number }
export interface LinkCoverage {
  /** Crawled pages that have their own content (not login screens, redirects or auth routes). */
  pages: number;
  /** Of those, pages with a source file after linking (router code or text match). */
  linked: number;
  /** Of `linked`, pages linked by text because the route readers had no file for them. */
  byText: number;
  unlinked: string[];
}

const FILLER = new Set(["src", "web", "app", "apps", "pages", "page", "views", "screens", "routes", "index", "component", "components", "tsx", "ts", "jsx", "js", "vue", "svelte", "html"]);
const tokens = (text: string) => new Set(text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token && !FILLER.has(token)).map((token) => token.replace(/s$/, "")));
/** How well a file's folder and name read as the route's name ("/order/pending" ~ Order/index.tsx), 0..1. */
function nameFit(route: string, file: string): number {
  const wanted = tokens(route.split("/").filter((part) => !part.startsWith(":")).join(" "));
  const have = tokens(file.split("/").slice(-2).join(" "));
  const shared = [...wanted].filter((token) => have.has(token)).length;
  return shared / Math.max(1, wanted.size + have.size - shared);
}
const withSlash = (path: string) => (path.startsWith("/") || path === "*" ? path : `/${path}`);

/** Visible text worth searching for: short, has letters, not data (digits vary per record). */
function phrasesOf(page: DiscoveredPage): string[] {
  // Without the page's own texts (a crawl from before they were captured), the flat page text split at
  // digits (counters, totals) is the best there is: runs of words such as a table's column headers.
  const raw = [
    ...(page.texts ?? (page.pageText ?? "").split(/\d+|[|·•]/)),
    ...page.headings, ...page.buttons, ...page.inputs, ...page.clickables,
    ...page.labelPairs.flatMap((pair) => [pair.label, pair.input]),
    ...page.selects.map((select) => select.name)
  ];
  const out = new Set<string>();
  for (const text of raw) {
    const phrase = (text ?? "").replace(/\s+/g, " ").replace(/\s*[*:]+\s*$/, "").trim().toLowerCase();
    if (phrase.length < 4 || phrase.length > 60 || !/[a-z]/.test(phrase) || /\d{2,}/.test(phrase)) continue;
    out.add(phrase);
  }
  return [...out];
}

/** Every file containing `phrase` as a whole word run (so "order" does not match inside "reorder"). */
function filesContaining(phrase: string, files: Array<[string, string]>): string[] {
  const hits: string[] = [];
  for (const [path, text] of files) {
    for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
      const before = text[at - 1];
      const after = text[at + phrase.length];
      if (!(before && /[a-z0-9]/.test(before)) && !(after && /[a-z0-9]/.test(after))) { hits.push(path); break; }
    }
  }
  return hits;
}

export function linkPagesToCode(
  pages: DiscoveredPage[], routes: RouteInfo[], sources: Map<string, string>, graph: ImportGraph, areas?: Map<string, string>
): { routes: RouteInfo[]; links: PageLink[]; coverage: LinkCoverage } {
  const real = pages.filter((page) => !page.authGated && !page.redirectedTo && !isAuthRoute(page.route));
  const fileFor = new Map(routes.filter((route) => route.file).map((route) => [withSlash(route.path), route.file!]));
  const todo = real.filter((page) => !fileFor.has(withSlash(page.route)));
  const links: PageLink[] = [];

  if (todo.length) {
    const files: Array<[string, string]> = [...sources]
      .filter(([path]) => UI_FILE.test(path) && !NOT_UI_FILE.test(path) && areas?.get(path) !== "backend")
      .map(([path, text]) => [path, text.toLowerCase().replace(/\s+/g, " ")]);
    const pagePhrases = new Map(real.map((page) => [page, phrasesOf(page)] as const));
    const frequency = new Map<string, number>();
    for (const list of pagePhrases.values()) for (const phrase of list) frequency.set(phrase, (frequency.get(phrase) ?? 0) + 1);
    const chrome = (phrase: string) => real.length >= 4 && (frequency.get(phrase) ?? 0) / real.length >= CHROME_SHARE;
    const found = new Map<string, string[]>();
    const where = (phrase: string) => {
      let hits = found.get(phrase);
      if (!hits) { hits = filesContaining(phrase, files); found.set(phrase, hits); }
      return hits;
    };

    let importers: Map<string, string[]> | undefined;
    const importersOf = () => {
      if (importers) return importers;
      importers = new Map();
      const known = new Set(files.map(([path]) => path));
      for (const [path] of files) {
        for (const edge of graph.importsByFile.get(path) ?? []) {
          const target = resolveImport(edge.specifier, path, known, graph.aliases);
          if (target && target !== path) importers.set(target, [...(importers.get(target) ?? []), path]);
        }
      }
      return importers;
    };

    // Pass 1: which files carry each page's text, and the best of them.
    const scored: Array<{ page: DiscoveredPage; score: Map<string, number>; hits: string[][]; best: string }> = [];
    for (const page of todo) {
      const score = new Map<string, number>();
      const hitLists: string[][] = [];
      for (const phrase of pagePhrases.get(page) ?? []) {
        if (chrome(phrase)) continue;
        const hits = where(phrase);
        if (!hits.length || hits.length > MAX_FILES_PER_PHRASE) continue;
        const weight = Math.log(1 + files.length / hits.length);
        hitLists.push(hits);
        for (const file of hits) score.set(file, (score.get(file) ?? 0) + weight);
      }
      const best = [...score].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (best) scored.push({ page, score, hits: hitLists, best });
    }

    // A router, layout or barrel file sits above many pages' files. A page's own file is the one such a
    // hub imports: structure, not a router syntax, tells pages from the components they render.
    const ancestors = (file: string) => {
      const seen = new Set<string>();
      let frontier = [file];
      for (let level = 0; level < 5 && frontier.length; level++) {
        frontier = frontier.flatMap((current) => importersOf().get(current) ?? []).filter((parent) => !seen.has(parent) && seen.add(parent));
      }
      return seen;
    };
    const pageFiles = new Set([...routes.flatMap((route) => (route.file ? [route.file] : [])), ...scored.map((entry) => entry.best)]);
    const reaches = new Map<string, number>();
    for (const file of pageFiles) for (const parent of ancestors(file)) reaches.set(parent, (reaches.get(parent) ?? 0) + 1);
    const hub = (file: string) => (reaches.get(file) ?? 0) >= Math.max(3, Math.ceil(pageFiles.size * HUB_SHARE));
    const underHub = (file: string) => (importersOf().get(file) ?? []).some(hub);
    const near = new Map<string, string[]>();
    const nearOf = (file: string) => near.get(file) ?? (near.set(file, importNeighborhood(file, sources, graph, 3, 60)), near.get(file)!);

    // Pass 2: from the best file, go up through its importers to the nearest files a hub imports - the
    // pages that render this text. Several (sibling pages sharing a component): the one whose name fits the
    // route, then the one that explains the most of the page's text.
    for (const { page, score, hits, best } of scored) {
      const explained = (file: string) => nearOf(file).reduce((sum, other) => sum + (score.get(other) ?? 0), 0);
      let level = [best];
      const seen = new Set(level);
      let pages: string[] = [];
      for (let depth = 0; depth < 5 && level.length; depth++) {
        pages = level.filter(underHub);
        if (pages.length) break;
        level = level.flatMap((file) => importersOf().get(file) ?? []).filter((parent) => !hub(parent) && !seen.has(parent) && seen.add(parent));
      }
      const top = Math.max(1, ...pages.map(explained));
      const entry = pages.map((file) => ({ file, rank: nameFit(page.route, file) + 0.5 * explained(file) / top })).sort((a, b) => b.rank - a.rank)[0]?.file ?? best;
      // A wrong link is worse than none (an unlinked page is listed in the coverage): the page's file and
      // what it imports must hold at least two of the page's phrases.
      const inside = new Set(nearOf(entry));
      const phrases = hits.filter((files) => files.some((file) => inside.has(file))).length;
      if (phrases >= 2) links.push({ pattern: withSlash(page.route), file: entry, phrases });
    }
  }

  const linked = new Map(links.map((link) => [link.pattern, link.file]));
  const next = routes.map((route) => (!route.file && linked.has(withSlash(route.path)) ? { ...route, file: linked.get(withSlash(route.path)), files: importNeighborhood(linked.get(withSlash(route.path))!, sources, graph) } : route));
  for (const link of links) {
    if (next.some((route) => withSlash(route.path) === link.pattern)) continue;
    const page = link.file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Page";
    next.push({ path: link.pattern, page, feature: featureName(link.pattern, page), file: link.file, files: importNeighborhood(link.file, sources, graph) });
  }

  const unlinked = [...new Set(real.filter((page) => !fileFor.has(withSlash(page.route)) && !linked.has(withSlash(page.route))).map((page) => withSlash(page.route)))];
  const patterns = new Set(real.map((page) => withSlash(page.route)));
  return {
    routes: next,
    links,
    coverage: { pages: patterns.size, linked: patterns.size - unlinked.length, byText: new Set(links.map((link) => link.pattern)).size, unlinked }
  };
}
