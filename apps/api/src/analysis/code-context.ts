/**
 * Analysis v3 — deep code context via AST parsing (ts-morph).
 * Extracts behavioral summaries for reachable components: rendered buttons/inputs,
 * click/change handlers, and what those handlers DO (API calls, navigations,
 * state mutations). Stored as compact summaries — never raw source code.
 */
import { Node, Project, SyntaxKind, type JsxAttribute, type JsxElement, type JsxSelfClosingElement, type SourceFile, type MethodDeclaration } from "ts-morph";

export interface HandlerSummary {
  handler: string;
  apiCalls: string[];
  navigations: string[];
  stateUpdates: string[];
  toastOrAlert: boolean;
}

export interface UiElementSummary {
  kind: "button" | "link" | "input" | "select" | "textarea";
  label: string;
  onClickHandler?: string;
  onSubmitHandler?: string;
  name?: string;
}

export interface ComponentCodeSummary {
  component: string;
  file: string;
  kind: "function" | "const" | "class";
  renderedElements: UiElementSummary[];
  handlers: HandlerSummary[];
  apiCalls: string[];
  navigations: string[];
  stateVariables: string[];
  loc: number;
}

const API_PATTERNS = [
  /(?:axios|api|http|client)?\.?(?:get|post|put|patch|delete|request)\s*[<(]/i,
  /fetch\s*\(/i,
  /\.mutate\(|\.query\(|useQuery|useMutation/i
];

/** `${id}` / `${x.id}` template holes become `:param`, so a call reads like a route pattern, not a template literal. */
const asPattern = (path: string) => path.replace(/\$\{[^}]*\}/g, ":param");

/**
 * Endpoint strings, from real call contexts only: fetch(...), an http client's .get/.post/...(...),
 * or a `url:` property (RTK Query / axios config style). A bare string anywhere in the text (a form
 * field name, a toast message) is never mistaken for an endpoint.
 */
function extractApiCalls(text: string): string[] {
  const calls = new Set<string>();
  const candidate = /^(?:https?:\/\/[^"'`]*)?\/[a-zA-Z0-9\-_/${}.]*$/;
  for (const match of text.matchAll(/\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g)) if (candidate.test(match[1])) calls.add(asPattern(match[1]));
  for (const match of text.matchAll(/\.(?:get|post|put|patch|delete|request)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) if (candidate.test(match[1])) calls.add(asPattern(match[1]));
  for (const match of text.matchAll(/\burl\s*:\s*["'`]([^"'`]+)["'`]/g)) if (candidate.test(match[1])) calls.add(asPattern(match[1]));
  return [...calls].slice(0, 10);
}

function extractNavigations(text: string): string[] {
  const navigations = new Set<string>();
  for (const match of text.matchAll(/navigate\(\s*["'`]([^"'`]+)["'`]/g)) navigations.add(match[1]);
  for (const match of text.matchAll(/history\.push\(\s*["'`]([^"'`]+)["'`]/g)) navigations.add(match[1]);
  for (const match of text.matchAll(/router\.(?:push|navigate)\([^)]*["'`]([^"'`]+)["'`]/g)) navigations.add(match[1]);
  return [...navigations].slice(0, 8);
}

function extractStateUpdates(text: string): string[] {
  const updates = new Set<string>();
  for (const match of text.matchAll(/set([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1];
    if (name && name.length > 2) updates.add(name.charAt(0).toLowerCase() + name.slice(1));
  }
  return [...updates].slice(0, 8);
}

function handlerSummaries(source: SourceFile): HandlerSummary[] {
  const summaries: HandlerSummary[] = [];
  const consider = (name: string, bodyText: string) => {
    if (bodyText.length < 10) return;
    const apiCalls = extractApiCalls(bodyText);
    const navigations = extractNavigations(bodyText);
    const stateUpdates = extractStateUpdates(bodyText);
    const toastOrAlert = /toast|alert\(|snackbar|notify|setShow|message/i.test(bodyText);
    if (!apiCalls.length && !navigations.length && !stateUpdates.length && !toastOrAlert) return;
    summaries.push({
      handler: name,
      apiCalls,
      navigations,
      stateUpdates,
      toastOrAlert
    });
  };
  for (const fn of source.getFunctions()) consider(fn.getName() ?? "anonymous", fn.getText());
  for (const variable of source.getVariableStatements()) {
    for (const declaration of variable.getDeclarations()) {
      const name = declaration.getName();
      const init = declaration.getInitializer();
      if (!init) continue;
      const isArrow = init.getKind() === SyntaxKind.ArrowFunction;
      const isComponent = /^[A-Z]/.test(name);
      if ((isArrow && !isComponent) || /use[A-Z]/.test(name)) consider(name, init.getText());
    }
  }
  return summaries;
}

const LINK_TAG = /Link$/;
const INPUT_TAG = /^(?:Input|Textarea|Checkbox|Switch|Radio|Toggle|DatePicker|Combobox)$/;
const SELECT_TAG = /^(?:Select|SelectItem|SelectTrigger|Tab|TabsTrigger|MenuItem|DropdownMenuItem)$/;
const ACTION_ATTR = /^(?:onClick|onChange|onValueChange|onSubmit|onCheckedChange|onSelect)$/;
const INTERACTIVE_INTRINSIC = new Set(["button", "a", "input", "select", "textarea"]);

function jsxAttr(attrs: JsxAttribute[], name: string): JsxAttribute | undefined {
  return attrs.find((attribute) => attribute.getNameNode().getText() === name);
}

const literal = (node: Node | undefined): string | undefined => {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isJsxExpression(node)) return literal(node.getExpression());
  return undefined;
};

/** `onClick={handleClick}` -> "handleClick"; `onClick={() => handleClick(x)}` -> "handleClick" (its first call). */
function handlerName(init: Node | undefined): string | undefined {
  const expr = Node.isJsxExpression(init) ? init.getExpression() : init;
  if (!expr) return undefined;
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName(); // this.handleClick
  const call = expr.getDescendantsOfKind(SyntaxKind.CallExpression)[0];
  const callee = call?.getExpression();
  if (!callee) return undefined;
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
}

/** Visible text of an element: its own JSX text plus literal string expressions, skipping nested tags. */
function elementText(element: JsxElement | JsxSelfClosingElement): string {
  if (Node.isJsxSelfClosingElement(element)) return "";
  const parts: string[] = [];
  for (const child of element.getJsxChildren()) {
    if (Node.isJsxText(child)) parts.push(child.getText());
    else if (Node.isJsxExpression(child)) { const value = literal(child.getExpression()); if (value) parts.push(value); }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** AST walk for rendered controls: any tag (intrinsic or component), not just raw HTML, so a UI library's controls are seen too. */
function scanControls(root: Node): UiElementSummary[] {
  const elements: UiElementSummary[] = [];
  const nodes = [...root.getDescendantsOfKind(SyntaxKind.JsxElement), ...root.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)];
  for (const node of nodes) {
    const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
    const tag = opening.getTagNameNode().getText();
    const attrs = opening.getAttributes().filter(Node.isJsxAttribute);
    const actionAttr = attrs.find((attribute) => ACTION_ATTR.test(attribute.getNameNode().getText()));
    const hrefOrTo = jsxAttr(attrs, "href") ?? jsxAttr(attrs, "to");
    const intrinsic = /^[a-z]/.test(tag);
    const interactive = intrinsic ? INTERACTIVE_INTRINSIC.has(tag) : LINK_TAG.test(tag) || INPUT_TAG.test(tag) || SELECT_TAG.test(tag) || /Button$/.test(tag) || Boolean(actionAttr) || Boolean(hrefOrTo);
    if (!interactive) continue;
    const label = literal(jsxAttr(attrs, "aria-label")?.getInitializer()) || literal(jsxAttr(attrs, "label")?.getInitializer())
      || literal(jsxAttr(attrs, "placeholder")?.getInitializer()) || literal(jsxAttr(attrs, "title")?.getInitializer())
      || literal(jsxAttr(attrs, "name")?.getInitializer()) || elementText(node) || literal(hrefOrTo?.getInitializer());
    if (!label) continue; // no literal label: skip rather than guess
    const kind: UiElementSummary["kind"] = tag === "a" || LINK_TAG.test(tag) || Boolean(hrefOrTo) ? "link"
      : tag === "input" || INPUT_TAG.test(tag) ? "input" : tag === "select" || SELECT_TAG.test(tag) ? "select"
      : tag === "textarea" ? "textarea" : "button";
    elements.push({
      kind, label: label.slice(0, 50),
      ...(actionAttr ? { onClickHandler: handlerName(actionAttr.getInitializer()) } : {}),
      ...(jsxAttr(attrs, "name") ? { name: literal(jsxAttr(attrs, "name")?.getInitializer()) } : {})
    });
    if (elements.length >= 40) break;
  }
  return elements;
}

/** Summarize one source file: rendered elements + handler behavior per component. `realFile` is the repo path to store (ts-morph's in-memory path may be flattened for its virtual file system). */
export function summarizeSourceFile(source: SourceFile, realFile: string = source.getFilePath()): ComponentCodeSummary[] {
  const results: ComponentCodeSummary[] = [];

  const record = (node: Node, name: string, kind: "function" | "const" | "class", bodyText: string) => {
    const elements = scanControls(node);
    if (!elements.length) return;
    const existing = results.find((entry) => entry.component === name && entry.file === realFile);
    if (existing) existing.renderedElements.push(...elements);
    else results.push({ component: name, file: realFile, kind, renderedElements: elements, handlers: [], apiCalls: extractApiCalls(bodyText).slice(0, 6), navigations: extractNavigations(bodyText), stateVariables: [], loc: bodyText.split("\n").length });
  };

  for (const functionDecl of source.getFunctions()) {
    const name = functionDecl.getName();
    if (!name || !/^[A-Z]/.test(name)) continue;
    const body = functionDecl.getText();
    record(functionDecl, name, "function", body);
    const resultsEntry = results.find((entry) => entry.component === name);
    if (resultsEntry) resultsEntry.handlers.push(...handlerSummaries(source).filter((summary) => body.includes(summary.handler)));
  }

  for (const statement of source.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      const name = declaration.getName();
      if (!/^[A-Z]/.test(name)) continue;
      const init = declaration.getInitializer();
      if (!init || init.getKind() !== SyntaxKind.ArrowFunction) continue;
      const body = init.getText();
      record(init, name, "const", body);
      const resultsEntry = results.find((entry) => entry.component === name);
      if (resultsEntry) {
        resultsEntry.handlers.push(...handlerSummaries(source).filter((summary) => body.includes(`const ${summary.handler}`) || body.includes(summary.handler)));
        resultsEntry.stateVariables = [...extractStateUpdates(body)].slice(0, 8);
        resultsEntry.loc = body.split("\n").length;
      }
    }
  }

  for (const classDecl of source.getClasses()) {
    const name = classDecl.getName();
    if (!name || !/^[A-Z]/.test(name)) continue;
    const methods: MethodDeclaration[] = classDecl.getMethods();
    for (const method of methods) {
      if (!/render|return/.test(method.getName() ?? "")) continue;
      record(method, name, "class", method.getText());
    }
  }

  return results;
}

/** Analyze a batch of files and return merged per-component summaries. */
export function summarizeCodebase(files: Map<string, string>): ComponentCodeSummary[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true, compilerOptions: { jsx: 2, allowJs: true, target: 99, module: 99, moduleResolution: 100, esModuleInterop: true, skipLibCheck: true, strict: false } });
  const merged: ComponentCodeSummary[] = [];
  const index = new Map<string, ComponentCodeSummary>();
  for (const [file, content] of files) {
    try {
      const source = project.createSourceFile(file.replace(/[\\/]/g, "_"), content, { overwrite: true });
      for (const summary of summarizeSourceFile(source, file)) {
        const key = `${summary.file}::${summary.component}`;
        const existing = index.get(key);
        if (existing) {
          existing.renderedElements.push(...summary.renderedElements);
          existing.handlers.push(...summary.handlers);
        } else {
          index.set(key, summary);
          merged.push(summary);
        }
      }
    } catch {
      // one malformed file must not abort analysis
    }
  }
  return merged.sort((a, b) => b.renderedElements.length + b.handlers.length - (a.renderedElements.length + a.handlers.length));
}
