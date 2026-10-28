/**
 * Route parameter values saved on an environment: { "/route": { name: value } } or, for a page that
 * shows different data per parameter (a customizer per 3D model), a list of such sets:
 * { "/customizer": [{ modelCode: "112" }, { modelCode: "168" }] }.
 *
 * Analysis, generation and verification use the first set; executions run a test once per set of
 * every route it opens (testVariants), so one test covers every listed model.
 */
export type FixtureValues = Record<string, string>;
export type RouteFixtures = Record<string, FixtureValues | FixtureValues[]>;

const isValues = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Every set saved for one route: none, one, or a list. */
export function fixtureSets(value: unknown): FixtureValues[] {
  const sets = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return sets.filter(isValues).map((set) => Object.fromEntries(Object.entries(set).map(([name, item]) => [name, String(item)])));
}

/** Route -> its first set: what everything except executions works with. */
export function firstFixtures(all: unknown): Record<string, FixtureValues> {
  if (!isValues(all)) return {};
  return Object.fromEntries(Object.entries(all).flatMap(([route, value]) => {
    const [first] = fixtureSets(value);
    return first ? [[route, first]] : [];
  }));
}

export interface TestVariant { label: string; values: FixtureValues }

/**
 * The parameter sets a test runs under: one per set of the route it uses that has several. A test
 * "uses" a route when its steps carry one of the route's {{parameters}} or it navigates to the route's
 * path. Empty when nothing it uses has more than one set (the test runs once, as before).
 * ponytail: only the first such route varies; two varying routes in one test would need a cross product.
 */
export function testVariants(steps: Array<{ action: string; target: string; value?: string }>, all: unknown): TestVariant[] {
  if (!isValues(all)) return [];
  const text = JSON.stringify(steps);
  const paths = steps.filter((step) => step.action === "navigate").map((step) => step.target.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0].replace(/(.)\/$/, "$1"));
  for (const [route, value] of Object.entries(all)) {
    const sets = fixtureSets(value);
    if (sets.length < 2) continue;
    const names = Object.keys(sets[0]);
    const pattern = new RegExp("^" + route.replace(/(.)\/$/, "$1").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]\w*/g, "[^/]+") + "$");
    const used = names.some((name) => text.includes(`{{${name}}}`)) || paths.some((path) => pattern.test(path));
    if (used) return sets.map((values) => ({ label: Object.entries(values).map(([name, item]) => `${name}=${item}`).join(" "), values }));
  }
  return [];
}
