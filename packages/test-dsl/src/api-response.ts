/**
 * Pure helpers for the `assertResponse` step, shared by the API (shape building, grounding)
 * and the worker (execution). No I/O: every function takes plain JSON.
 *
 * A step is: target = GET path pattern ("/orders", "/orders/:id"), value = one rule:
 *   all <field> == <value>      every item has the value (also: contains)
 *   count <op> <n>              item count, op is == > >= < <=
 *   shown <field>               the first items' text values appear on the page
 */

type Item = Record<string, unknown>;

export interface FoundList { /** Dot path of the list inside the body; "" when the body is the array. */ path: string; items: Item[] }

type CountOp = "==" | ">" | ">=" | "<" | "<=";

export type ResponseRule =
  | { kind: "all"; field: string; op: "==" | "contains"; value: string }
  | { kind: "count"; op: CountOp; n: number }
  | { kind: "shown"; field: string };

const LIST_KEYS = ["data", "items", "results", "rows", "records", "list", "content"];
const SHOWN_LIMIT = 5;

const isRecord = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);
const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

/** The list of records in a response body: the body itself, or an array under `data`, `items`... (two levels deep). */
export function findList(json: unknown, depth = 2): FoundList | null {
  if (Array.isArray(json)) return json.length === 0 || isRecord(json[0]) ? { path: "", items: json as Item[] } : null;
  if (!isRecord(json) || depth === 0) return null;
  const keys = [...LIST_KEYS.filter((key) => key in json), ...Object.keys(json).filter((key) => !LIST_KEYS.includes(key))];
  for (const key of keys) {
    const value = json[key];
    if (Array.isArray(value) && value.length === 0 && !LIST_KEYS.includes(key)) continue; // `errors: []` is not the list
    const found = findList(value, depth - 1);
    if (found) return { path: found.path ? `${key}.${found.path}` : key, items: found.items };
  }
  return null;
}

/** `territory.name` -> value, or undefined. */
export function getField(item: unknown, field: string): unknown {
  let value: unknown = item;
  for (const key of field.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

/** True when a GET request URL matches the step target; `:name` matches one path segment, the query string is ignored. */
export function matchesApiCall(pattern: string, method: string, url: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const wanted = pattern.replace(/^GET\s+/i, "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const source = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]\w*/g, "[^/]+");
  return new RegExp(`^${source}$`).test(path);
}

// A dynamic segment in any convention a backend/frontend might use for a path param, collapsed to
// one literal token (":") so two paths that differ only in param naming compare as equal structure.
const DYNAMIC_SEGMENT = /\$\{[^}]*\}|:[A-Za-z_]\w*|\{[^}]*\}|<[^>]*>|\[[^\]]*\]/g;

/** Drops origin/query/hash and collapses every param-segment convention to ":", for structural comparison. */
export function normalizeEndpointPath(raw: string): string {
  const noOrigin = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  const noQuery = noOrigin.split(/[?#]/)[0];
  const collapsed = noQuery.replace(DYNAMIC_SEGMENT, ":").replace(/\/+/g, "/").replace(/\/+$/, "");
  return collapsed || "/";
}

/**
 * Joins a frontend path-like string literal to the backend endpoint it most likely calls: a
 * suffix match on normalized segments (so "/api/orders/:/approve" matches a frontend
 * "/orders/${id}/approve"), requiring at least one literal (non-":") segment to agree — "counts"
 * never matches a route whose same-position segment is dynamic — and preferring whichever prefix
 * (e.g. "/api") the candidate set agrees on most, when more than one row matches the suffix.
 */
export function joinEndpoint<T extends { norm: string }>(frontPath: string, rows: T[]): T | null {
  const front = normalizeEndpointPath(frontPath).split("/").filter(Boolean);
  if (!front.length) return null;
  const candidates = rows.filter((row) => {
    const segments = row.norm.split("/").filter(Boolean);
    if (segments.length < front.length) return false;
    const suffix = segments.slice(segments.length - front.length);
    return suffix.every((segment, index) => segment === front[index]) && suffix.some((segment) => segment !== ":");
  });
  if (candidates.length <= 1) return candidates[0] ?? null;
  const prefixOf = (row: T) => row.norm.split("/").filter(Boolean).slice(0, row.norm.split("/").filter(Boolean).length - front.length).join("/");
  const prefixCounts = new Map<string, number>();
  for (const row of candidates) prefixCounts.set(prefixOf(row), (prefixCounts.get(prefixOf(row)) ?? 0) + 1);
  const bestPrefix = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return candidates.find((row) => prefixOf(row) === bestPrefix) ?? candidates[0];
}

export function parseResponseRule(text: string): ResponseRule | null {
  const rule = text.trim();
  const all = /^all\s+([\w.-]+)\s*(==|contains)\s*(.+)$/i.exec(rule);
  if (all) return { kind: "all", field: all[1], op: all[2].toLowerCase() as "==" | "contains", value: all[3].trim().replace(/^(["'])(.*)\1$/, "$2") };
  const count = /^count\s*(==|>=|<=|>|<)\s*(\d+)$/i.exec(rule);
  if (count) return { kind: "count", op: count[1] as CountOp, n: Number(count[2]) };
  const shown = /^shown\s+([\w.-]+)$/i.exec(rule);
  if (shown) return { kind: "shown", field: shown[1] };
  return null;
}

/** Check a rule against one response body. `pageText` is only used by `shown`. */
export function evaluateResponseRule(rule: ResponseRule, json: unknown, pageText = ""): { ok: boolean; message: string } {
  const list = findList(json);
  if (!list) return { ok: false, message: "the response has no list of items" };
  const { items } = list;
  if (rule.kind === "count") {
    const ok = { "==": items.length === rule.n, ">": items.length > rule.n, ">=": items.length >= rule.n, "<": items.length < rule.n, "<=": items.length <= rule.n }[rule.op];
    return { ok, message: ok ? "" : `the response has ${items.length} items, expected ${rule.op} ${rule.n}` };
  }
  if (rule.kind === "all") {
    if (!items.length) return { ok: false, message: "the response list is empty, so the filter could not be checked" };
    const expected = norm(rule.value);
    for (const [index, item] of items.entries()) {
      const raw = getField(item, rule.field);
      const actual = raw === undefined || raw === null ? "" : norm(String(raw));
      const ok = rule.op === "==" ? actual === expected : actual.includes(expected);
      if (!ok) return { ok: false, message: `item ${index + 1} of ${items.length} has ${rule.field} "${raw === undefined ? "<missing>" : String(raw)}", expected ${rule.op} "${rule.value}"` };
    }
    return { ok: true, message: "" };
  }
  // shown: text values only, numbers and dates are formatted differently by the UI.
  const values = items.slice(0, SHOWN_LIMIT).map((item) => getField(item, rule.field)).filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (!values.length) return { ok: false, message: `no text values for "${rule.field}" in the response` };
  const text = norm(pageText);
  const missing = values.filter((value) => !text.includes(norm(value)));
  return missing.length
    ? { ok: false, message: `the response has ${rule.field} ${missing.map((value) => `"${value}"`).join(", ")} but the page does not show ${missing.length === 1 ? "it" : "them"}` }
    : { ok: true, message: "" };
}
