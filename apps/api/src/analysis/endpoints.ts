/**
 * Backend endpoint discovery (Phase 3): generic candidate-file selection + a quote-anchored LLM
 * read of route declarations, then fully deterministic composition (mount-prefix concatenation,
 * handler-file resolution via the import graph). The LLM only ever describes what one file's text
 * says; every path/prefix/handler claim is verified against that file's own source, and false
 * claims are dropped rather than trusted. No per-framework knowledge here: the candidate-file
 * regex matches "a call or decorator whose first argument is a path-like string", which is true
 * of Express, Fastify, NestJS, Koa and friends alike.
 */
import { createHash } from "node:crypto";
import type { ModelProvider } from "@ai-qa/model-provider";
import { normalizeEndpointPath } from "@ai-qa/test-dsl";
import { resolveImport, type ImportGraph } from "./analyzer";
import type { PrismaService } from "../database/prisma.service";

export interface EndpointRow {
  id: string;
  method: string;
  fullPath: string;
  norm: string;
  file: string;
  line: number;
  handler: string;
  handlerFile?: string;
  middleware: string[];
}

interface LlmMount { prefix: string; target: string; quote: string }
interface LlmEndpoint { method: string; path: string; handler: string; middleware: string[]; quote: string }
interface LlmFileEntry { mounts: LlmMount[]; endpoints: LlmEndpoint[] }
interface EndpointMap { files: Record<string, LlmFileEntry> }

// A call or decorator whose first argument is a path-like string: router.get('/x'), app.use('/api', r),
// @Get('/orders/:id'), fastify.route({ method, url: '/x' }) partially (url literal also matches this pattern
// when on its own line). \s already matches newlines, so this also catches a Prettier-wrapped call with
// the identifier and its opening paren on one line and the path literal on the next. Deliberately broad
// and framework-agnostic. Run with matchAll against the whole file, not line-by-line, so the \s can bridge
// lines; a per-line test would never see the call and its literal as adjacent.
const PATH_CALL = /@?[\w.]+\(\s*["'`](\/[^"'`]*)["'`]/g;
const IMPORT_LINE = /^\s*(?:import\b|const\s+.+=\s*require\()/;
const CONTEXT_LINES = 2;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const LINE_NUMBER_PREFIX = /^\s*\d+:\s?/;
/** The LLM is told to quote verbatim "including the line-number prefix given" (candidateFiles' own "N: " markers), so a quote never appears in the raw source as-is; strip those markers before checking it against the file's real text. */
const stripLineNumbers = (quote: string) => quote.split("\n").map((line) => line.replace(LINE_NUMBER_PREFIX, "")).join("\n");

/**
 * End offset of the call statement that opened at `openParenOffset` (the "(" right after the
 * matched identifier): scans forward counting paren depth so a route call with many multi-line
 * middleware arguments (where the real handler sits well past the path literal) keeps its whole
 * statement, not just a fixed window around the path. Depth also tracks [] and {} since a call's
 * arguments routinely contain object/array literals with their own parens.
 */
function statementEnd(content: string, openParenOffset: number): number {
  let depth = 0;
  for (let i = openParenOffset; i < content.length; i++) {
    if ("([{".includes(content[i])) depth++;
    else if (")]}".includes(content[i])) { depth--; if (depth === 0) return i; }
  }
  return content.length - 1;
}

/** Backend files containing at least one path-like call, each reduced to its import lines + the full statement around every match (with line numbers), to keep the LLM's input small and quote-checkable. */
// Test suites call routes (request(app).get('/api/x')) rather than declare them.
const TEST_FILE = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

export function candidateFiles(sources: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, content] of sources) {
    if (TEST_FILE.test(file)) continue;
    const lines = content.split("\n");
    const lineStarts: number[] = [0];
    for (const line of lines) lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);
    const lineOfOffset = (offset: number) => { let lo = 0, hi = lines.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; } return lo; };

    const matchLines = new Set<number>();
    for (const match of content.matchAll(PATH_CALL)) {
      const start = lineOfOffset(match.index ?? 0);
      const openParenOffset = (match.index ?? 0) + match[0].indexOf("(");
      const end = lineOfOffset(statementEnd(content, openParenOffset));
      for (let i = start; i <= end; i++) matchLines.add(i);
    }
    if (!matchLines.size) continue;
    const keep = new Set<number>();
    for (const index of matchLines) for (let i = Math.max(0, index - CONTEXT_LINES); i <= Math.min(lines.length - 1, index + CONTEXT_LINES); i++) keep.add(i);
    for (let i = 0; i < lines.length; i++) if (IMPORT_LINE.test(lines[i])) keep.add(i);
    const view = [...keep].sort((a, b) => a - b).map((index) => `${index + 1}: ${lines[index]}`).join("\n");
    out.set(file, view);
  }
  return out;
}

const SCHEMA_VERSION = "v1";

function cacheKey(files: Map<string, string>, model: string): string {
  const sorted = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(sorted) + SCHEMA_VERSION + model).digest("hex");
}

// One file's route declarations can run long (ERP's orders.routes.ts alone has ~15 endpoints with
// quotes); asking the model for all 34 candidate files in one call made its JSON output exceed the
// model's own output-token limit and get cut off mid-string. Capped at MAX_FILES_PER_CALL files per
// call keeps each response small enough to finish, win or lose on its own — this is a generic
// batching limit, not a per-framework rule.
const MAX_FILES_PER_CALL = 8;

const SYSTEM_PROMPT = "You read backend route-declaration code. For each file given, return ONLY JSON {\"files\":{\"<path>\":{\"mounts\":[{\"prefix\":string,\"target\":string,\"quote\":string}],\"endpoints\":[{\"method\":string,\"path\":string,\"handler\":string,\"middleware\":string[],\"quote\":string}]}}}. "
  + "\"mounts\" are calls that mount a sub-router/sub-app at a prefix (e.g. app.use('/api', apiRouter)); \"target\" is the imported identifier being mounted, or \"self\" when the endpoints are declared directly in this same file under that prefix. "
  + "\"endpoints\" are individual route declarations in this file (method + path + the handler function/identifier named). "
  + "\"quote\" MUST be the exact source line (or lines) this fact comes from, verbatim including the line-number prefix given. Only report what the file's own text literally declares — never invent a route, mount, method or handler. Skip anything you are not sure about rather than guessing.";

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Full orchestration: candidate selection -> cached or fresh LLM read (batched, see
 * MAX_FILES_PER_CALL) -> verified, deterministic composition into EndpointRow[]. Returns [] (never
 * throws) when there's nothing backend-shaped to read, or the provider is unavailable — endpoint
 * discovery is additive, not load-bearing.
 */
export async function discoverEndpoints(
  prisma: PrismaService,
  provider: ModelProvider | null,
  projectId: string,
  organizationId: string,
  backendSources: Map<string, string>,
  graph: ImportGraph
): Promise<EndpointRow[]> {
  const candidates = candidateFiles(backendSources);
  if (!candidates.size || !provider) return [];

  const key = cacheKey(candidates, "endpoint-map");
  const cached = await prisma.llmCache.findUnique({ where: { projectId_kind_key: { projectId, kind: "endpoints", key } } }).catch(() => null);
  let output: EndpointMap;
  if (cached) {
    output = cached.output as unknown as EndpointMap;
  } else {
    const batches = chunk([...candidates.entries()], MAX_FILES_PER_CALL);
    output = { files: {} };
    let inputTokens = 0, outputTokens = 0, failedBatches = 0;
    for (const batch of batches) {
      try {
        const response = await provider.generateStructured<EndpointMap>({
          organizationId, projectId, jobId: "endpoint-discovery", capability: "classification",
          systemPrompt: SYSTEM_PROMPT, prompt: JSON.stringify(Object.fromEntries(batch)), schemaName: "EndpointMap", schema: {}, temperature: 0
        });
        Object.assign(output.files, response.output?.files ?? {});
        inputTokens += response.usage.inputTokens;
        outputTokens += response.usage.outputTokens;
      } catch {
        // One bad batch (still-too-large output, a transient provider error) loses only that
        // batch's files, not the whole discovery run.
        failedBatches++;
      }
    }
    // A partial map is still used for this run, but never cached - otherwise the lost batch's
    // files stay missing on every re-analysis of the same commit.
    if (!failedBatches) await prisma.llmCache.upsert({
      where: { projectId_kind_key: { projectId, kind: "endpoints", key } },
      create: { projectId, kind: "endpoints", key, output: output as never, inputTokens, outputTokens },
      update: { output: output as never, inputTokens, outputTokens }
    }).catch(() => undefined);
  }
  return composeEndpoints(output, backendSources, graph);
}

/**
 * Resolves a handler identifier (e.g. "ordersController" in "ordersController.approve") to the
 * file that defines it: a direct import, or - the common controller-instance pattern, generic
 * across frameworks, not Express-specific - a local "const ordersController = new OrdersController()"
 * whose class is imported.
 */
function resolveHandlerFile(handlerName: string | undefined, file: string, content: string, graph: ImportGraph, allFiles: Set<string>): string | undefined {
  // The LLM's "handler" field is sometimes messier than one identifier (an inline arrow function,
  // a call expression); only a plain identifier can be a direct import or instance name, so
  // anything else just has nothing to resolve.
  if (!handlerName || !/^[A-Za-z_]\w*$/.test(handlerName)) return undefined;
  const direct = (graph.importsByFile.get(file) ?? []).find((edge) => edge.names.includes(handlerName));
  if (direct) return resolveImport(direct.specifier, file, allFiles, graph.aliases) ?? undefined;
  const instantiation = content.match(new RegExp(`\\b(?:const|let|var)\\s+${handlerName}\\s*=\\s*new\\s+([A-Za-z0-9_]+)\\s*\\(`));
  if (!instantiation) return undefined;
  const classEdge = (graph.importsByFile.get(file) ?? []).find((edge) => edge.names.includes(instantiation[1]));
  return classEdge ? resolveImport(classEdge.specifier, file, allFiles, graph.aliases) ?? undefined : undefined;
}

/** a/b -> "a/b" with exactly one "/" between non-empty parts; "" segments drop out. */
function joinPath(...parts: string[]): string {
  const joined = parts.filter(Boolean).join("/").replace(/\/+/g, "/");
  return `/${joined}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") || "/";
}

/** 1-indexed line number: read directly off the quote's own "N: " prefix (candidateFiles always puts one on its first line), else 0. */
function lineOf(quote: string): number {
  return Number(quote.match(LINE_NUMBER_PREFIX)?.[0].match(/\d+/)?.[0]) || 0;
}

/**
 * Weaker models quote one line of a multi-line route call (the handler line, or the closing ");")
 * instead of the line holding the path literal. The quote still anchors when that line, at the line
 * number it claims, really says what was quoted AND sits inside a call statement whose path literal
 * is exactly the reported path - so the literal is still proven to be in the source.
 */
export function quoteInsideCallWithPath(source: string, quote: string, path: string): boolean {
  const line = lineOf(quote);
  const lines = source.split("\n");
  const firstQuoted = normalize(stripLineNumbers(quote.split("\n")[0] ?? ""));
  if (!line || !firstQuoted || !normalize(lines[line - 1] ?? "").includes(firstQuoted)) return false;
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  for (const match of source.matchAll(PATH_CALL)) {
    if (match[1] !== path) continue;
    const openParen = (match.index ?? 0) + match[0].indexOf("(");
    if (lineAt(match.index ?? 0) <= line && line <= lineAt(statementEnd(source, openParen))) return true;
  }
  return false;
}

/**
 * Deterministic composition: verifies every quote against the file's real source, resolves mount
 * targets through the import graph, concatenates prefixes from un-mounted root files down to each
 * endpoint's declaring file, and resolves each handler's file the same way.
 */
export function composeEndpoints(output: EndpointMap, sources: Map<string, string>, graph: ImportGraph): EndpointRow[] {
  const allFiles = new Set(sources.keys());
  const verified: Record<string, LlmFileEntry> = {};
  for (const [file, entry] of Object.entries(output.files ?? {})) {
    const raw = sources.get(file) ?? "";
    const content = normalize(raw);
    if (!content) continue;
    const mounts = (entry.mounts ?? []).filter((mount) => mount.quote && content.includes(normalize(stripLineNumbers(mount.quote))));
    const endpoints = (entry.endpoints ?? []).filter((endpoint) => endpoint.quote && endpoint.path && content.includes(normalize(stripLineNumbers(endpoint.quote)))
      && (endpoint.quote.includes(endpoint.path) || quoteInsideCallWithPath(raw, endpoint.quote, endpoint.path)));
    if (mounts.length || endpoints.length) verified[file] = { mounts, endpoints };
  }

  const resolvedMounts = new Map<string, Array<{ prefix: string; targetFile: string }>>();
  for (const [file, entry] of Object.entries(verified)) {
    const list: Array<{ prefix: string; targetFile: string }> = [];
    for (const mount of entry.mounts) {
      if (mount.target === "self") { list.push({ prefix: mount.prefix, targetFile: file }); continue; }
      const edge = (graph.importsByFile.get(file) ?? []).find((candidate) => candidate.names.includes(mount.target));
      const targetFile = edge ? resolveImport(edge.specifier, file, allFiles, graph.aliases) : null;
      if (targetFile) list.push({ prefix: mount.prefix, targetFile });
    }
    resolvedMounts.set(file, list);
  }

  const incoming = new Set<string>();
  for (const list of resolvedMounts.values()) for (const mount of list) incoming.add(mount.targetFile);
  const prefixByFile = new Map<string, string>();
  const queue: Array<{ file: string; prefix: string }> = Object.keys(verified).filter((file) => !incoming.has(file)).map((file) => ({ file, prefix: "" }));
  const queued = new Set(queue.map((entry) => entry.file));
  while (queue.length) {
    const { file, prefix } = queue.shift()!;
    if (prefixByFile.has(file)) continue;
    prefixByFile.set(file, prefix);
    for (const mount of resolvedMounts.get(file) ?? []) {
      if (prefixByFile.has(mount.targetFile) || queued.has(mount.targetFile)) continue;
      queued.add(mount.targetFile);
      queue.push({ file: mount.targetFile, prefix: joinPath(prefix, mount.prefix) });
    }
  }

  const rows: EndpointRow[] = [];
  let counter = 0;
  for (const [file, entry] of Object.entries(verified)) {
    const base = prefixByFile.get(file) ?? "";
    const content = sources.get(file) ?? "";
    for (const endpoint of entry.endpoints) {
      const fullPath = joinPath(base, endpoint.path);
      const handlerFile = resolveHandlerFile(endpoint.handler?.split(".")[0], file, content, graph, allFiles);
      rows.push({
        id: `ep_${counter++}`,
        method: (endpoint.method ?? "GET").toUpperCase(),
        fullPath,
        norm: normalizeEndpointPath(fullPath),
        file, line: lineOf(endpoint.quote),
        handler: endpoint.handler ?? "",
        ...(handlerFile ? { handlerFile } : {}),
        middleware: endpoint.middleware ?? []
      });
    }
  }
  return rows;
}
