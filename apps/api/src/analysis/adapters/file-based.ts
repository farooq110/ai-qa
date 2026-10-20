import { nextRoutePath } from "../analyzer";
import type { RouteHint } from "./types";

/** `[id]`, `[...slug]`, `[[opt]]`, `$id`, `:id` segments -> `:id`; `(group)` segments vanish. */
function dynamic(segment: string): string | null {
  if (/^\(.*\)$/.test(segment)) return null;
  const bracket = segment.match(/^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/);
  if (bracket) return `:${bracket[1]}`;
  if (segment.startsWith("$") && segment.length > 1) return `:${segment.slice(1)}`;
  return segment;
}

const join = (segments: Array<string | null>) => "/" + segments.filter((segment): segment is string => Boolean(segment)).join("/");

/** A package's directory ("" = repo root) and its package.json content. */
export interface PackageInfo { dir: string; json: string }

/**
 * Routes that are just file paths (Next, Nuxt, SvelteKit, Remix, Astro). Needs paths only, no file
 * contents. Each rule applies only under a package directory whose own package.json names that
 * framework — so one Next app in a monorepo never turns another app's `pages/` folder into routes.
 */
export function fileBasedRoutes(paths: string[], packages: PackageInfo[]): RouteHint[] {
  const under = (file: string, dir: string) => (dir ? file === dir || file.startsWith(`${dir}/`) : true);
  const hints = new Map<string, RouteHint>();
  const add = (pattern: string, file: string, framework: string) => { if (!hints.has(pattern)) hints.set(pattern, { pattern, file, framework }); };

  for (const pkg of packages) {
    const has = (name: RegExp) => name.test(pkg.json);
    const ownFiles = paths.filter((file) => under(file, pkg.dir));
    for (const file of ownFiles) {
      if (has(/"next"\s*:/)) {
        const route = nextRoutePath(file, pkg.dir);
        if (route) add(route, file, "next");
      }
      if (has(/"nuxt"\s*:|"nuxt3"\s*:/)) {
        const match = file.match(/(?:^|\/)pages\/(.+)\.vue$/);
        if (match) add(join(match[1].split("/").map((segment) => (segment === "index" ? null : dynamic(segment)))), file, "nuxt");
      }
      if (has(/"@sveltejs\/kit"\s*:/)) {
        const match = file.match(/(?:^|\/)src\/routes\/((?:.+\/)?)\+page\.svelte$/);
        if (match) add(join(match[1].split("/").filter(Boolean).map(dynamic)), file, "sveltekit");
      }
      if (has(/"@remix-run\/[a-z-]+"\s*:/)) {
        const match = file.match(/(?:^|\/)app\/routes\/([^/]+)\.[jt]sx?$/);
        if (match && !match[1].startsWith("_layout")) {
          // Flat routes: dots are path separators, `_index` is the index, a leading `_x.` is a pathless layout.
          const parts = match[1].split(".").filter((part) => part !== "_index" && !part.startsWith("_"));
          add(join(parts.map((part) => (part.startsWith("$") ? `:${part.slice(1)}` : part))), file, "remix");
        }
      }
      if (has(/"astro"\s*:/)) {
        const match = file.match(/(?:^|\/)src\/pages\/(.+)\.astro$/);
        if (match) add(join(match[1].split("/").map((segment) => (segment === "index" ? null : dynamic(segment)))), file, "astro");
      }
    }
  }
  return [...hints.values()];
}
