/**
 * Flow specs (Phase 4): one typed, source-anchored FlowSpecData per module, built from a generic
 * code slice (frontend + backend, both stack-agnostic) and cached by a hash of that slice's own
 * content. The LLM reads real code and reports facts with verbatim quotes; nothing it reports is
 * trusted until anchorFlowSpec confirms the quote is really in that file and every literal the
 * fact claims (a label, a message, a permission name) sits inside one of its quotes. A fact that
 * fails either check is dropped, not kept "probably right" - the dry run in Phase 5 is the only
 * thing allowed to decide a spec-grounded test is good, and it needs clean facts to start from.
 */
import { createHash } from "node:crypto";
import type { ModelProvider } from "@ai-qa/model-provider";
import type { FlowSpecAction, FlowSpecData } from "@ai-qa/contracts";
import { isAuthRoute, joinEndpoint } from "@ai-qa/test-dsl";
import { fanIn, featureName, resolveImport, sliceModule, type ImportGraph, type RouteInfo } from "./analyzer";
import type { EndpointRow } from "./endpoints";
import type { PrismaService } from "../database/prisma.service";

const PROMPT_VERSION = "v5"; // v5: success messages from mutation hooks
const SCHEMA_VERSION = "v4"; // v4: submit + options anchored; // v3: literal recovery in anchorFlowSpec - stored specs are post-anchoring, so they must be rebuilt
const FRONTEND_BUDGET_TOKENS = 50_000;
const BACKEND_BUDGET_TOKENS = 35_000;
const CONVENTIONS_BUDGET_TOKENS = 30_000;
const CONCURRENCY = 3;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const quoteContains = (haystack: string, literal: string | null | undefined) => !literal || normalize(haystack).includes(normalize(literal));

export interface ModuleGroup { key: string; name: string; entryFiles: string[]; routePaths: string[]; endpoints: EndpointRow[] }

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const basename = (path: string) => path.split("/").pop() ?? path;

/**
 * Deterministic: groups routes by their first static path segment (excluding auth routes), then
 * splits any group whose entry files span more than one directory - a catch-all bucket like
 * "/settings/*" otherwise merges many unrelated pages (territories, roles, warehouses, tax...)
 * into one module, which starves sliceModule's token budget and leaves most of those pages'
 * code out of the prompt entirely; the model then answers anyway, with nothing real to anchor to.
 * Splitting by page directory keeps each module's slice to the one feature it actually covers.
 */
export function buildModules(routes: RouteInfo[], endpoints: EndpointRow[]): ModuleGroup[] {
  const parents = new Map<string, { key: string; routes: RouteInfo[] }>();
  for (const route of routes) {
    if (!route.path || route.path === "*" || isAuthRoute(route.path)) continue;
    const segment = route.path.split("/").filter(Boolean)[0];
    if (!segment) continue;
    const key = segment.toLowerCase();
    const parent = parents.get(key) ?? { key, routes: [] };
    parent.routes.push(route);
    parents.set(key, parent);
  }

  const groups: ModuleGroup[] = [];
  for (const parent of parents.values()) {
    const directories = new Set(parent.routes.map((route) => route.file).filter((file): file is string => Boolean(file)).map(dirname));
    if (directories.size <= 1) {
      const entryFiles = [...new Set(parent.routes.map((route) => route.file).filter((file): file is string => Boolean(file)))];
      groups.push({ key: parent.key, name: featureName(`/${parent.key}`, parent.key), entryFiles, routePaths: parent.routes.map((route) => route.path), endpoints: [] });
      continue;
    }
    const subGroups = new Map<string, ModuleGroup>();
    for (const route of parent.routes) {
      const dir = route.file ? dirname(route.file) : "";
      const subKey = dir ? `${parent.key}/${basename(dir)}` : parent.key;
      const subGroup = subGroups.get(subKey) ?? { key: subKey, name: featureName(route.path, basename(dir) || parent.key), entryFiles: [], routePaths: [], endpoints: [] };
      if (!subGroup.routePaths.includes(route.path)) subGroup.routePaths.push(route.path);
      if (route.file && !subGroup.entryFiles.includes(route.file)) subGroup.entryFiles.push(route.file);
      subGroups.set(subKey, subGroup);
    }
    groups.push(...subGroups.values());
  }

  // Endpoints are matched by segment overlap, not key equality: a backend route like
  // "/api/territories" and a frontend group keyed "settings/territories" share no key, but both
  // contain the literal segment "territories" in their own path - that shared resource name is
  // what ties them together regardless of how each side nests its URLs.
  // The endpoint's own resource (its first segment) wins: "/api/orders/:/approve" belongs to orders,
  // while "/api/deliveries/:/orders" only names orders as a sub-resource - letting it in pulled the
  // deliveries backend into the orders slice and starved the real orders handlers of budget. Any-
  // segment overlap is only the fallback for a group no endpoint is primarily about.
  const endpointSegments = endpoints.map((endpoint) => endpoint.norm.split("/").filter((part) => part && part !== "api" && part !== ":"));
  for (const group of groups) {
    const groupSegments = new Set(group.routePaths.flatMap((path) => path.split("/").filter((part) => part && !part.startsWith(":"))));
    const primary = endpoints.filter((_, index) => groupSegments.has(endpointSegments[index][0] ?? ""));
    group.endpoints.push(...(primary.length ? primary : endpoints.filter((_, index) => endpointSegments[index].some((segment) => groupSegments.has(segment)))));
  }
  // A group with no page file (a redirect or alias route) has no UI to describe; its endpoints already
  // belong to the module whose pages call them, and summarizing it again only duplicates that module.
  return groups.filter((group) => group.entryFiles.length);
}

/** One cached LLM call over the files with the highest fan-in: a short prose digest of error/permission/validation conventions, so every module's prompt shares the same grounding without re-deriving it. */
export async function conventionsDigest(
  prisma: PrismaService, provider: ModelProvider | null, projectId: string,
  routes: RouteInfo[], sources: Map<string, string>, graph: ImportGraph
): Promise<{ text: string; hash: string; inputTokens: number; outputTokens: number }> {
  const entries = routes.filter((route): route is RouteInfo & { file: string } => Boolean(route.file)).map((route) => ({ file: route.file, sources }));
  if (!entries.length || !provider) return { text: "", hash: sha256(""), inputTokens: 0, outputTokens: 0 };
  const counts = fanIn(graph, entries);
  const topFiles = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([file]) => file);

  const key = sha256(JSON.stringify(topFiles) + PROMPT_VERSION);
  const cached = await prisma.llmCache.findUnique({ where: { projectId_kind_key: { projectId, kind: "conventions", key } } }).catch(() => null);
  if (cached) return { text: (cached.output as { text: string }).text, hash: sha256((cached.output as { text: string }).text), inputTokens: 0, outputTokens: 0 };

  let budget = CONVENTIONS_BUDGET_TOKENS * 3.5;
  const files: Record<string, string> = {};
  for (const file of topFiles) {
    const content = sources.get(file);
    if (!content || content.length > budget) continue;
    files[file] = content;
    budget -= content.length;
  }
  if (!Object.keys(files).length) return { text: "", hash: sha256(""), inputTokens: 0, outputTokens: 0 };

  try {
    const response = await provider.generateStructured<{ text?: string }>({
      organizationId: "", projectId, jobId: "conventions-digest", capability: "classification",
      systemPrompt: "You read application code shared across many pages/modules. In under 300 words of plain prose, describe: how errors from the backend are shown to the user, how permission/role checks are done (and where - client, server, or both), and how form validation works (client-side rules vs backend rules). Return ONLY JSON {\"text\": string}. Base every sentence only on what the given files actually show.",
      prompt: JSON.stringify(files), schemaName: "ConventionsDigest", schema: {}, temperature: 0
    });
    const text = response.output?.text ?? "";
    await prisma.llmCache.upsert({
      where: { projectId_kind_key: { projectId, kind: "conventions", key } },
      create: { projectId, kind: "conventions", key, output: { text } as never, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
      update: { output: { text } as never, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
    }).catch(() => undefined);
    return { text, hash: sha256(text), inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens };
  } catch {
    return { text: "", hash: sha256(""), inputTokens: 0, outputTokens: 0 };
  }
}

const SOURCE_QUOTE_SCHEMA = { type: "object", additionalProperties: false, properties: { file: { type: "string" }, quote: { type: "string" } }, required: ["file", "quote"] };
const ENUM2 = (a: string, b: string) => ({ type: "string", enum: [a, b] });

/** OpenAI strict-mode JSON Schema for FlowSpecData: every property required, null in place of optional, additionalProperties false at every object level. */
export const FLOW_SPEC_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    module: { type: "object", additionalProperties: false, properties: { key: { type: "string" }, name: { type: "string" }, summary: { type: "string" } }, required: ["key", "name", "summary"] },
    routes: { type: "array", items: { type: "string" } },
    entities: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: { name: { type: "string" }, statuses: { type: "array", items: { type: "object", additionalProperties: false, properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value", "label"] } } },
        required: ["name", "statuses"]
      }
    },
    navigation: { type: "array", items: { type: "string" } },
    actions: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: {
          id: { type: "string" }, name: { type: "string" }, kind: { type: "string" },
          trigger: { type: "object", additionalProperties: false, properties: { route: { type: "string" }, label: { type: "string" }, control: { type: "string" }, container: { type: "string" } }, required: ["route", "label", "control", "container"] },
          preconditions: { type: "array", items: { type: "object", additionalProperties: false, properties: { kind: { type: "string" }, entity: { type: "string" }, values: { type: "array", items: { type: "string" } }, description: { type: "string" }, enforcedBy: ENUM2("client", "server") }, required: ["kind", "entity", "values", "description", "enforcedBy"] } },
          submit: { type: ["object", "null"], additionalProperties: false, properties: { label: { type: "string" } }, required: ["label"] },
          permission: { type: ["object", "null"], additionalProperties: false, properties: { value: { type: "string" }, enforcedBy: ENUM2("client", "server") }, required: ["value", "enforcedBy"] },
          form: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, label: { type: "string" }, control: { type: "string" }, options: { type: "array", items: { type: "string" } }, rules: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, kind: { type: "string" }, value: { type: ["string", "null"] }, message: { type: "string" }, layer: ENUM2("client", "server") }, required: ["id", "kind", "value", "message", "layer"] } } }, required: ["name", "label", "control", "options", "rules"] } },
          calls: { type: "array", items: { type: "object", additionalProperties: false, properties: { method: { type: "string" }, path: { type: "string" }, endpointId: { type: ["string", "null"] } }, required: ["method", "path", "endpointId"] } },
          backendRules: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, condition: { type: "string" }, message: { type: "string" }, reproducibleViaUi: { type: "boolean" } }, required: ["id", "condition", "message", "reproducibleViaUi"] } },
          effects: { type: "array", items: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: ["transition", "message", "navigate", "list-change", "field-change"] }, entity: { type: ["string", "null"] }, from: { type: "array", items: { type: "string" } }, to: { type: ["string", "null"] }, text: { type: ["string", "null"] }, route: { type: ["string", "null"] } }, required: ["kind", "entity", "from", "to", "text", "route"] } },
          src: { type: "array", items: SOURCE_QUOTE_SCHEMA }
        },
        required: ["id", "name", "kind", "trigger", "submit", "preconditions", "permission", "form", "calls", "backendRules", "effects", "src"]
      }
    }
  },
  required: ["module", "routes", "entities", "navigation", "actions"]
};

const SYSTEM_PROMPT = "You read one module's frontend and backend code (both given below) and describe its user-facing actions. "
  + "Return ONLY JSON matching the given schema. Every action needs: its trigger (the route, the visible label, what kind of control it is, and its containing page/section), any precondition the UI enforces before showing it (e.g. an entity must be in a certain status), the permission it requires if the code checks one, its form fields and their validation rules (client AND backend), the backend endpoint(s) it calls, any backend-only business rule with a user-visible message, and what happens after it succeeds (status change, message shown, navigation, list update). "
  + "A success message is often NOT in the component: it sits in a mutation hook or service callback (onSuccess -> toast(...), successMessage(...), notify(...), message.success(...)) in another file of the slice - follow the call from the form's submit handler and report that text as a 'message' effect, copied with its exact casing. "
  + "When the trigger opens a form, dialog or confirmation, 'submit' is the visible label of the button that saves or confirms it (e.g. \"Save\", \"Create\", \"Confirm\", or the same text as the trigger) - quote its line too; null only when the trigger itself performs the action. For a select/radio/combobox field, 'options' lists the visible option labels ONLY when they are written literally in the code (a static array, enum or <option> list); leave it empty when options come from an API. "
  + "'src' is a LIST of quotes, not one: every literal you report (the trigger's visible label text, a permission name, a validation/rule message, an effect's message text) must have its OWN entry in 'src' pointing at the exact line, in whichever file that literal actually appears in - the trigger's label almost always comes from a DIFFERENT file (a frontend component) than its permission check or backend rule (a backend route/controller/service file). Citing only the backend route line for an action whose trigger label is frontend text is NOT enough; add the frontend line too. "
  + "Every 'src' entry's 'quote' must be copied verbatim, including the line-number prefix given. Never invent a label, message, permission name or rule that the given code does not literally contain. If you are not sure an action exists, or cannot find the real source line for one of its literals, leave that literal out (or the whole action out) rather than guessing.";

/**
 * The exact line where `literal` appears in the slice as a whole string literal ("x", 'x', `x`) or
 * as JSX text (>x<, or alone on its line), as a numbered quote. Weaker models on large slices often
 * report a real label/message but cite only a different line (the backend route) for it; this finds
 * the citation they skipped. It never vouches for a literal the code does not contain.
 */
export function locateLiteral(literal: string, sliceSources: Map<string, string>, preferFiles: string[] = []): { file: string; quote: string } | null {
  const target = normalize(literal);
  if (target.length < 2) return null;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  const pattern = new RegExp(`["'\`]${escaped}["'\`]|>\\s*${escaped}\\s*<|^\\s*\\d+:\\s*${escaped}\\s*$`);
  // Files the action already cites first (a short label like "Delete" is far more likely to be the
  // one in its own component than in an unrelated one), then the rest in slice order (frontend first).
  const order = [...new Set([...preferFiles.filter((file) => sliceSources.has(file)), ...sliceSources.keys()])];
  for (const file of order) {
    for (const line of sliceSources.get(file)!.split("\n")) if (pattern.test(line)) return { file, quote: line };
  }
  return null;
}

export function anchorFlowSpec(raw: Partial<FlowSpecData>, sliceSources: Map<string, string>): { spec: FlowSpecData; stats: { facts: number; dropped: string[] } } {
  const normalizedContents = new Map([...sliceSources].map(([file, content]) => [file, normalize(content)]));
  const dropped: string[] = [];
  const actions: FlowSpecAction[] = [];

  for (const action of raw.actions ?? []) {
    const quotes = (action.src ?? []).filter((quote) => quote.file && quote.quote && normalizedContents.get(quote.file)?.includes(normalize(stripLineNumbers(quote.quote))));
    if (!quotes.length) { dropped.push(`${action.id ?? "?"}: no anchored source quote`); continue; }
    let anchoredText = quotes.map((quote) => quote.quote).join(" \n ");
    // Every literal checked below gets one chance to be located in the slice when the model's own
    // quotes skipped it; what is found becomes a real quote, so later checks and the spec viewer see it.
    const recover = (literal: string | null | undefined) => {
      if (!literal || quoteContains(anchoredText, literal)) return;
      const found = locateLiteral(literal, sliceSources, quotes.map((quote) => quote.file));
      if (found) { quotes.push(found); anchoredText += ` \n ${found.quote}`; }
    };
    recover(action.trigger?.label);
    recover(action.submit?.label);
    for (const field of action.form ?? []) for (const option of field.options ?? []) recover(option);
    recover(action.permission?.value);
    for (const rule of action.backendRules ?? []) recover(rule.message);
    for (const field of action.form ?? []) for (const rule of field.rules) recover(rule.message);
    for (const precondition of action.preconditions ?? []) for (const value of precondition.values) recover(value);
    for (const effect of action.effects ?? []) { recover(effect.text); recover(effect.to); for (const value of effect.from) recover(value); }
    if (!action.trigger || !quoteContains(anchoredText, action.trigger.label)) { dropped.push(`${action.id ?? "?"}: trigger label not anchored`); continue; }
    if (!(action.calls ?? []).length && !action.trigger.control) { dropped.push(`${action.id ?? "?"}: no call or trigger control`); continue; }

    const permission = action.permission && quoteContains(anchoredText, action.permission.value) ? action.permission : null;
    const backendRules = (action.backendRules ?? []).filter((rule) => quoteContains(anchoredText, rule.message));
    // A status/entity-state literal (precondition values, an effect's from/to) is exactly the kind
    // of thing a model invents when it's guessing at a state machine instead of reading one - hold
    // it to the same bar as a label or message, not a free pass just because it's a short word.
    const preconditions = (action.preconditions ?? []).filter((precondition) => precondition.values.every((value) => quoteContains(anchoredText, value)));
    const effects = (action.effects ?? []).filter((effect) => quoteContains(anchoredText, effect.text) && quoteContains(anchoredText, effect.to) && effect.from.every((value) => quoteContains(anchoredText, value)));
    const form = (action.form ?? []).map((field) => ({ ...field, options: (field.options ?? []).filter((option) => quoteContains(anchoredText, option)), rules: field.rules.filter((rule) => quoteContains(anchoredText, rule.message)) }));
    const submit = action.submit?.label && quoteContains(anchoredText, action.submit.label) ? { label: action.submit.label } : null;

    actions.push({
      id: action.id ?? `action_${actions.length}`, name: action.name ?? "", kind: action.kind ?? "",
      trigger: action.trigger, submit, preconditions, permission, form,
      calls: action.calls ?? [], backendRules, effects, src: quotes
    });
  }

  return {
    spec: { module: raw.module ?? { key: "", name: "", summary: "" }, routes: raw.routes ?? [], entities: raw.entities ?? [], navigation: raw.navigation ?? [], actions },
    stats: { facts: actions.length, dropped }
  };
}

const LINE_NUMBER_PREFIX = /^\s*\d+:\s?/;
const stripLineNumbers = (quote: string) => quote.split("\n").map((line) => line.replace(LINE_NUMBER_PREFIX, "")).join("\n");
/** 1-indexed line number read off a quote's own "N: " prefix (numberedView's convention), for the spec viewer's deep link to source - computed here, never supplied by the LLM. */
export function quoteLine(quote: string): number {
  return Number(quote.match(LINE_NUMBER_PREFIX)?.[0].match(/\d+/)?.[0]) || 0;
}

/** Numbers every line "N: <line>" (1-indexed), the same convention Phase 3's endpoint quotes use, so anchoring can be checked the same way and the model can report an exact line. */
function numberedView(content: string): string {
  return content.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n");
}

interface ModuleSliceResult { files: Array<{ path: string; hash: string; role: "frontend" | "backend" }>; sources: Map<string, string>; promptFiles: Record<string, string> }

/** Frontend slice (sliceModule over entry files) + backend slice (route declaration lines + sliceModule over handler files), both as numbered views for anchoring. */
export function sliceForModule(group: ModuleGroup, sources: Map<string, string>, graph: ImportGraph, shared: Set<string>): ModuleSliceResult {
  const frontendFiles = sliceModule(group.entryFiles, sources, graph, { budgetTokens: FRONTEND_BUDGET_TOKENS, shared });
  const allFiles = new Set(sources.keys());
  const handlerFiles = [...new Set(group.endpoints.map((endpoint) => endpoint.handlerFile).filter((file): file is string => Boolean(file)))];
  const routeFiles = [...new Set(group.endpoints.map((endpoint) => endpoint.file))];
  const backendEntryFiles = [...new Set([...routeFiles, ...handlerFiles])];
  const backendSliceFiles = sliceModule(backendEntryFiles, sources, graph, { budgetTokens: BACKEND_BUDGET_TOKENS, shared });

  const files: ModuleSliceResult["files"] = [];
  const sliceSources = new Map<string, string>();
  const promptFiles: Record<string, string> = {};
  for (const path of frontendFiles) {
    const content = sources.get(path);
    if (content === undefined) continue;
    files.push({ path, hash: sha256(content), role: "frontend" });
    const numbered = numberedView(content);
    sliceSources.set(path, numbered);
    promptFiles[path] = numbered;
  }
  for (const path of backendSliceFiles) {
    const content = sources.get(path);
    if (content === undefined || !allFiles.has(path)) continue;
    files.push({ path, hash: sha256(content), role: "backend" });
    const numbered = numberedView(content);
    sliceSources.set(path, numbered);
    promptFiles[path] = numbered;
  }
  return { files, sources: sliceSources, promptFiles };
}

const GAP_ENDPOINTS_PER_CALL = 6;
const MAX_GAP_CALLS = 5;
const GAP_FRONTEND_BUDGET_CHARS = 40_000 * 3.5;
const GAP_BACKEND_BUDGET_CHARS = 30_000 * 3.5;
const PATH_LITERAL = /["'`](\/[^"'`\s]*)["'`]/g;

/** joinEndpoint, but among rows with the call's own method first: "/categories" is both GET and POST. */
export function joinCall(call: { method: string; path: string }, rows: EndpointRow[]): EndpointRow | null {
  const sameMethod = rows.filter((row) => row.method === call.method.toUpperCase());
  return joinEndpoint(call.path, sameMethod) ?? (sameMethod.length === rows.length ? null : joinEndpoint(call.path, rows));
}

/** Write endpoints of this module that no anchored action's call joins to - what one big call skipped. */
export function uncoveredWriteEndpoints(group: ModuleGroup, actions: FlowSpecAction[]): EndpointRow[] {
  const covered = new Set<string>();
  for (const action of actions) for (const call of action.calls) {
    const joined = joinCall(call, group.endpoints);
    if (joined) covered.add(joined.id);
  }
  return group.endpoints.filter((endpoint) => endpoint.method !== "GET" && !covered.has(endpoint.id));
}

/**
 * A focused slice for a handful of endpoints: frontend files (from the module's own slice) holding a
 * path literal that joins to one of them, plus up to two hops of slice files importing those (the
 * API client -> the hook -> the page that renders the button), and only those endpoints' own route
 * and handler files on the backend. Small enough that the model reads every action in it.
 */
export function gapSlice(endpoints: EndpointRow[], slice: ModuleSliceResult, sources: Map<string, string>, graph: ImportGraph): Record<string, string> {
  const allFiles = new Set(sources.keys());
  const importsOf = (path: string) => (graph.importsByFile.get(path) ?? []).map((edge) => resolveImport(edge.specifier, path, allFiles, graph.aliases)).filter((target): target is string => Boolean(target));
  const inSlice = (role: "frontend" | "backend") => new Set(slice.files.filter((file) => file.role === role).map((file) => file.path));
  const frontend = inSlice("frontend");
  const backend = inSlice("backend");

  // Frontend: files with a path literal joining one of these endpoints (the API client), then two hops
  // of slice files importing those (hook -> page), then one hop of what those pages import (the
  // dialog/modal that actually holds the confirm button and its messages).
  // Forward hops (what a picked file imports) are limited to files named after these endpoints' own
  // resource/action words - "ApproveOrderDialog", "orders.service" - not the date picker or PDF engine.
  const words = [...new Set(endpoints.flatMap((endpoint) => endpoint.norm.split(/[/-]/)).filter((word) => word.length > 2 && word !== "api" && word !== ":").map((word) => word.toLowerCase().replace(/(?:ies|es|s)$/, "")))];
  const namedForEndpoints = (path: string) => { const name = (path.split("/").pop() ?? "").toLowerCase(); return words.some((word) => name.includes(word)); };
  const picked = new Set([...frontend].filter((path) => [...(sources.get(path) ?? "").matchAll(PATH_LITERAL)].some((match) => joinEndpoint(match[1], endpoints))));
  for (let hop = 0; hop < 2; hop++) {
    for (const path of frontend) if (!picked.has(path) && importsOf(path).some((target) => picked.has(target))) picked.add(path);
  }
  for (const path of [...picked]) for (const target of importsOf(path)) if (frontend.has(target) && namedForEndpoints(target)) picked.add(target);

  // Backend: the endpoints' route and handler files, plus one hop of what those import (the service
  // that throws the rule messages, the DTO with server-side validation).
  const backendPicked = new Set(endpoints.flatMap((endpoint) => [endpoint.file, endpoint.handlerFile ?? ""]).filter(Boolean));
  for (const path of [...backendPicked]) for (const target of importsOf(path)) if (backend.has(target) && namedForEndpoints(target)) backendPicked.add(target);

  const out: Record<string, string> = {};
  let budget = GAP_FRONTEND_BUDGET_CHARS;
  for (const path of picked) {
    const numbered = slice.sources.get(path);
    if (!numbered || numbered.length > budget) continue;
    out[path] = numbered;
    budget -= numbered.length;
  }
  let backendBudget = GAP_BACKEND_BUDGET_CHARS;
  for (const path of backendPicked) {
    const content = sources.get(path);
    if (content === undefined) continue;
    const numbered = numberedView(content);
    if (numbered.length > backendBudget) continue;
    out[path] = numbered;
    backendBudget -= numbered.length;
  }
  return out;
}

export interface FlowSpecResult { moduleKey: string; name: string; spec: FlowSpecData; stats: { facts: number; dropped: string[]; tokens: number; chunks: number }; cached: boolean; inputTokens: number; outputTokens: number }

/** Builds (or reuses, by sliceHash) the flow spec for one module. Never throws - a failed module reports an empty spec with the error in stats.dropped, since one bad module should not stop the others. */
async function buildModuleSpec(
  prisma: PrismaService, provider: ModelProvider | null, projectId: string, analysisRunId: string,
  group: ModuleGroup, sources: Map<string, string>, graph: ImportGraph, shared: Set<string>,
  conventions: { text: string; hash: string }, model: string
): Promise<FlowSpecResult> {
  const slice = sliceForModule(group, sources, graph, shared);
  const sortedFileHashes = [...slice.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}:${file.hash}`).join(",");
  const sliceHash = sha256(sortedFileHashes + conventions.hash + PROMPT_VERSION + SCHEMA_VERSION + model);

  const existing = await prisma.flowSpec.findUnique({ where: { projectId_moduleKey_sliceHash: { projectId, moduleKey: group.key, sliceHash } } }).catch(() => null);
  if (existing) {
    const stats = existing.stats as { facts: number; dropped: string[]; tokens: number; chunks: number };
    return { moduleKey: group.key, name: group.name, spec: existing.spec as unknown as FlowSpecData, stats, cached: true, inputTokens: 0, outputTokens: 0 };
  }

  if (!provider || !Object.keys(slice.promptFiles).length) {
    const empty: FlowSpecData = { module: { key: group.key, name: group.name, summary: "" }, routes: group.routePaths, entities: [], navigation: [], actions: [] };
    return { moduleKey: group.key, name: group.name, spec: empty, stats: { facts: 0, dropped: ["no provider or empty slice"], tokens: 0, chunks: 0 }, cached: false, inputTokens: 0, outputTokens: 0 };
  }

  const prompt = JSON.stringify({ module: group.key, routes: group.routePaths, conventions: conventions.text, files: slice.promptFiles });
  let inputTokens = 0, outputTokens = 0;
  let raw: Partial<FlowSpecData> = {};
  try {
    const response = await provider.generateStructured<Partial<FlowSpecData>>({
      organizationId: "", projectId, jobId: `flow-spec-${group.key}`, capability: "classification",
      systemPrompt: SYSTEM_PROMPT, prompt, schemaName: "FlowSpecData", schema: FLOW_SPEC_SCHEMA, temperature: 0, maxTokens: 16_000
    });
    raw = response.output ?? {};
    inputTokens = response.usage.inputTokens;
    outputTokens = response.usage.outputTokens;
  } catch (error) {
    const empty: FlowSpecData = { module: { key: group.key, name: group.name, summary: "" }, routes: group.routePaths, entities: [], navigation: [], actions: [] };
    return { moduleKey: group.key, name: group.name, spec: empty, stats: { facts: 0, dropped: [`LLM call failed: ${error instanceof Error ? error.message : String(error)}`], tokens: 0, chunks: 1 }, cached: false, inputTokens: 0, outputTokens: 0 };
  }

  const { spec, stats: anchorStats } = anchorFlowSpec(raw, slice.sources);
  let chunks = 1;

  // One call over a ~90k-token slice reliably lists only a few of the module's actions. Every write
  // endpoint no action reaches is a checklist item: ask again, focused on just those endpoints.
  const gaps = uncoveredWriteEndpoints(group, spec.actions);
  for (let start = 0; start < gaps.length && chunks <= MAX_GAP_CALLS; start += GAP_ENDPOINTS_PER_CALL) {
    const batch = gaps.slice(start, start + GAP_ENDPOINTS_PER_CALL);
    const files = gapSlice(batch, slice, sources, graph);
    const gapSources = new Map(Object.entries(files));
    try {
      chunks++;
      const response = await provider.generateStructured<Partial<FlowSpecData>>({
        organizationId: "", projectId, jobId: `flow-spec-${group.key}-gap`, capability: "classification",
        systemPrompt: SYSTEM_PROMPT + " This is a focused follow-up: describe ONLY the user-facing actions whose backend call is one of the endpoints listed in 'endpoints' (each is declared in the backend files given). Skip any endpoint no UI control in the given frontend files triggers.",
        prompt: JSON.stringify({ module: group.key, routes: group.routePaths, conventions: conventions.text, endpoints: batch.map((endpoint) => `${endpoint.method} ${endpoint.fullPath}`), files }),
        schemaName: "FlowSpecData", schema: FLOW_SPEC_SCHEMA, temperature: 0, maxTokens: 16_000
      });
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
      const gap = anchorFlowSpec(response.output ?? {}, gapSources);
      anchorStats.dropped.push(...gap.stats.dropped.map((reason) => `gap: ${reason}`));
      // Keep a follow-up action only when it reaches an endpoint nothing already covers - the same
      // "Delete" found again from a second page is a duplicate, not a new action.
      const stillUncovered = new Set(uncoveredWriteEndpoints(group, spec.actions).map((endpoint) => endpoint.id));
      for (const action of gap.spec.actions) {
        const reaches = action.calls.map((call) => joinCall(call, group.endpoints)?.id).filter((id): id is string => Boolean(id && stillUncovered.has(id)));
        if (!reaches.length) continue;
        for (const id of reaches) stillUncovered.delete(id);
        spec.actions.push(action);
      }
    } catch (error) {
      anchorStats.dropped.push(`gap call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const stats = { facts: spec.actions.length, dropped: anchorStats.dropped, tokens: inputTokens + outputTokens, chunks };

  await prisma.flowSpec.upsert({
    where: { projectId_moduleKey_sliceHash: { projectId, moduleKey: group.key, sliceHash } },
    create: { projectId, analysisRunId, moduleKey: group.key, name: group.name, sliceHash, spec: spec as never, files: slice.files as never, stats: stats as never },
    update: { analysisRunId, name: group.name, spec: spec as never, files: slice.files as never, stats: stats as never }
  }).catch(() => undefined);

  return { moduleKey: group.key, name: group.name, spec, stats, cached: false, inputTokens, outputTokens };
}

/** Runs `task` over `items` with at most `limit` in flight at once. */
async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Full orchestration: groups modules, builds (or reuses) each module's spec with CONCURRENCY in
 * flight at once, and fills calls[].endpointId by joining each call's path to the discovered
 * endpoint rows (deterministic, after the LLM step - the model never sees endpoint ids).
 */
export async function buildFlowSpecs(
  prisma: PrismaService, provider: ModelProvider | null, projectId: string, analysisRunId: string,
  routes: RouteInfo[], endpoints: EndpointRow[], sources: Map<string, string>, graph: ImportGraph, model: string,
  onProgress?: (done: number, total: number) => void
): Promise<FlowSpecResult[]> {
  const groups = buildModules(routes, endpoints);
  if (!groups.length) return [];

  const entries = routes.filter((route): route is RouteInfo & { file: string } => Boolean(route.file)).map((route) => ({ file: route.file, sources }));
  const fanInCounts = fanIn(graph, entries);
  const shared = new Set([...fanInCounts.entries()].filter(([, count]) => count >= Math.max(5, entries.length * 0.25)).map(([file]) => file));

  const conventions = await conventionsDigest(prisma, provider, projectId, routes, sources, graph);

  let done = 0;
  const results = await pool(groups, CONCURRENCY, async (group) => {
    const result = await buildModuleSpec(prisma, provider, projectId, analysisRunId, group, sources, graph, shared, conventions, model);
    done += 1;
    onProgress?.(done, groups.length);
    return result;
  });

  for (const result of results) {
    for (const action of result.spec.actions) {
      for (const call of action.calls) {
        // Always our join, never the model's own guess at an id ("createCategory").
        call.endpointId = joinCall(call, endpoints)?.id ?? null;
      }
    }
  }
  return results;
}
