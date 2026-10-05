/**
 * Analysis v3 — deep code context via AST parsing (ts-morph).
 * Extracts behavioral summaries for reachable components: rendered buttons/inputs,
 * click/change handlers, and what those handlers DO (API calls, navigations,
 * state mutations). Stored as compact summaries — never raw source code.
 */
import { Project, SyntaxKind, type SourceFile, type ClassDeclaration, type FunctionDeclaration, type VariableDeclaration, type MethodDeclaration } from "ts-morph";

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

function extractApiCalls(text: string): string[] {
  const calls = new Set<string>();
  for (const match of text.matchAll(/["'`](\/[a-zA-Z0-9\-_/${}.]+)["'`]/g)) calls.add(match[1]);
  for (const match of text.matchAll(/(?:get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) calls.add(match[1]);
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

/** Summarize one source file: rendered elements + handler behavior per component. */
export function summarizeSourceFile(source: SourceFile): ComponentCodeSummary[] {
  const results: ComponentCodeSummary[] = [];

  const scanJsx = (jsxText: string, ownerComponent: string, ownerFile: string, kind: "function" | "const" | "class") => {
    const elements: UiElementSummary[] = [];
    for (const match of jsxText.matchAll(/<button\b[^>]*(?:onClick=\{(\w+)\})?[^>]*>([\s\S]*?)<\/button>/g)) {
      const label = match[2].replace(/\{[^}]*\}/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
      elements.push({ kind: "button", label: label || "(dynamic)", onClickHandler: match[1] });
    }
    for (const match of jsxText.matchAll(/<Link\b[^>]*to=["']([^"']+)["'][^>]*>([\s\S]*?)<\/Link>/g)) {
      const label = match[2].replace(/\{[^}]*\}/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
      elements.push({ kind: "link", label: label || "(dynamic)", name: match[1] });
    }
    for (const match of jsxText.matchAll(/<(input|textarea|select)\b[^>]*>/g)) {
      const tag = match[1];
      const attr = match[0];
      const name = attr.match(/name=["']([^"']+)["']/)?.[1];
      const placeholder = attr.match(/placeholder=["']([^"']+)["']/)?.[1];
      elements.push({ kind: tag as "input" | "select" | "textarea", label: placeholder ?? name ?? tag, name });
    }
    if (!elements.length) return;
    const existing = results.find((entry) => entry.component === ownerComponent && entry.file === ownerFile);
    if (existing) existing.renderedElements.push(...elements);
    else results.push({ component: ownerComponent, file: ownerFile, kind, renderedElements: elements, handlers: [], apiCalls: extractApiCalls(jsxText).slice(0, 6), navigations: extractNavigations(jsxText), stateVariables: [], loc: jsxText.split("\n").length });
  };

  for (const functionDecl of source.getFunctions()) {
    const name = functionDecl.getName();
    if (!name || !/^[A-Z]/.test(name)) continue;
    const body = functionDecl.getText();
    scanJsx(body, name, source.getFilePath(), "function");
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
      scanJsx(body, name, source.getFilePath(), "const");
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
    scanJsx(classDecl.getText(), name, source.getFilePath(), "class");
    const methods: MethodDeclaration[] = classDecl.getMethods();
    for (const method of methods) {
      const body = method.getText();
      const entry = results.find((entry2) => entry2.component === name);
      if (entry && /render|return/.test(method.getName() ?? "")) {
        const elements: UiElementSummary[] = [];
        for (const match of body.matchAll(/<button\b[^>]*(?:onClick=\{(?:this\.)?(\w+)\})?[^>]*>([\s\S]*?)<\/button>/g)) {
          elements.push({ kind: "button", label: match[2].replace(/\{[^}]*\}/g, " ").replace(/<[^>]*>/g, " ").trim().slice(0, 50) || "(dynamic)", onClickHandler: match[1] });
        }
        if (elements.length) entry.renderedElements.push(...elements);
      }
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
      for (const summary of summarizeSourceFile(source)) {
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
