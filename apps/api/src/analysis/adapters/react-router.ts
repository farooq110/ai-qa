/**
 * React Router adapter: reads route objects and <Route> elements with the TypeScript AST, so it
 * handles nesting (`children`, nested <Route>), index routes, relative paths, wrapper elements and
 * `lazy(() => import(...))` pages without depending on how the config is formatted.
 */
import { Node, Project, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from "ts-morph";
import { resolveImport, type AliasRule } from "../analyzer";
import type { RouteHint } from "./types";

const ROUTER_SIGNAL = /createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements|useRoutes|<Route\b|RouteObject/;
const WRAPPER = /^(?:Suspense|Fragment|ErrorBoundary|Layout|[A-Za-z]*(?:Route|Guard|Provider|Layout|Boundary|Wrapper|Shell))$/;

const literal = (node: Node | undefined): string | undefined => {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isJsxExpression(node)) return literal(node.getExpression());
  return undefined;
};

/** Innermost JSX tag of an element expression that is not a layout/guard wrapper. */
function pageComponent(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  const tags: string[] = [];
  const consider = (element: Node) => {
    const tag = Node.isJsxElement(element) ? element.getOpeningElement().getTagNameNode().getText()
      : Node.isJsxSelfClosingElement(element) ? element.getTagNameNode().getText() : undefined;
    if (tag && /^[A-Z]/.test(tag)) tags.push(tag);
  };
  if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node)) consider(node);
  node.getDescendants().forEach(consider);
  return tags.reverse().find((tag) => !WRAPPER.test(tag)) ?? tags[tags.length - 1];
}

function importedFile(source: SourceFile, name: string, file: string, all: Set<string>, aliases: AliasRule[]): string | undefined {
  for (const declaration of source.getImportDeclarations()) {
    const matches = declaration.getDefaultImport()?.getText() === name || declaration.getNamedImports().some((entry) => (entry.getAliasNode()?.getText() ?? entry.getName()) === name);
    if (matches) return resolveImport(declaration.getModuleSpecifierValue(), file, all, aliases) ?? undefined;
  }
  // const Page = lazy(() => import("./pages/Page"))
  const variable = source.getVariableDeclaration(name);
  const call = variable?.getInitializer()?.getDescendantsOfKind(SyntaxKind.CallExpression).find((entry) => entry.getExpression().getKind() === SyntaxKind.ImportKeyword);
  const specifier = literal(call?.getArguments()[0]);
  return specifier ? resolveImport(specifier, file, all, aliases) ?? undefined : undefined;
}

const joinPath = (parent: string, child: string | undefined) => {
  if (child === undefined || child === "") return parent;
  if (child.startsWith("/")) return child;
  return `${parent === "/" ? "" : parent}/${child}`;
};

export function reactRouterRoutes(sources: Map<string, string>, aliases: AliasRule[] = []): RouteHint[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true, compilerOptions: { jsx: 2, allowJs: true, target: 99, module: 99, strict: false } });
  const all = new Set(sources.keys());
  const hints = new Map<string, RouteHint>();

  for (const [file, content] of sources) {
    if (!ROUTER_SIGNAL.test(content) || !/\.[jt]sx?$/.test(file)) continue;
    let source: SourceFile;
    try { source = project.createSourceFile(file.replace(/[\\/]/g, "_"), content, { overwrite: true }); } catch { continue; }

    const emit = (pattern: string, component: string | undefined, lazyFile?: string) => {
      const clean = ("/" + pattern).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
      if (hints.has(clean)) return;
      const pageFile = lazyFile ?? (component ? importedFile(source, component, file, all, aliases) : undefined);
      hints.set(clean, { pattern: clean, framework: "react-router", ...(pageFile ? { file: pageFile } : {}) });
    };

    // Object-style routes: { path, index, children, element | Component | lazy }
    const isRouteObject = (node: Node): node is ObjectLiteralExpression =>
      Node.isObjectLiteralExpression(node) && node.getProperties().some((property) => ["path", "index", "children", "element", "Component", "lazy"].includes((property as { getName?: () => string }).getName?.() ?? ""))
      && (node.getProperty("path") !== undefined || node.getProperty("index") !== undefined || node.getProperty("children") !== undefined);
    const pathOf = (object: ObjectLiteralExpression): string => {
      let path = "";
      let current: Node | undefined = object;
      const chain: ObjectLiteralExpression[] = [];
      while (current) {
        if (Node.isObjectLiteralExpression(current) && isRouteObject(current)) chain.unshift(current);
        current = current.getParent();
      }
      for (const entry of chain) path = joinPath(path || "/", literal((entry.getProperty("path") as { getInitializer?: () => Node } | undefined)?.getInitializer?.()));
      return path || "/";
    };
    for (const object of source.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      if (!isRouteObject(object)) continue;
      const hasPage = object.getProperty("element") || object.getProperty("Component") || object.getProperty("lazy") || object.getProperty("index");
      if (!hasPage && object.getProperty("path") === undefined) continue;
      const element = (object.getProperty("element") as { getInitializer?: () => Node } | undefined)?.getInitializer?.();
      const componentProp = (object.getProperty("Component") as { getInitializer?: () => Node } | undefined)?.getInitializer?.();
      const lazyCall = (object.getProperty("lazy") as { getInitializer?: () => Node } | undefined)?.getInitializer?.()
        ?.getDescendantsOfKind(SyntaxKind.CallExpression).find((entry) => entry.getExpression().getKind() === SyntaxKind.ImportKeyword);
      const lazySpecifier = literal(lazyCall?.getArguments()[0]);
      const lazyFile = lazySpecifier ? resolveImport(lazySpecifier, file, all, aliases) ?? undefined : undefined;
      // A route with children is a layout: its path only prefixes the children (its index child is the page).
      if (object.getProperty("children") && !object.getProperty("index")) continue;
      emit(pathOf(object), pageComponent(element) ?? componentProp?.getText(), lazyFile);
    }

    // JSX-style routes: <Route path="x" element={<Page/>}> with nested <Route>
    for (const element of [...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement), ...source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)]) {
      if (element.getTagNameNode().getText() !== "Route") continue;
      const attribute = (name: string) => element.getAttributes().find((entry) => Node.isJsxAttribute(entry) && entry.getNameNode().getText() === name) as import("ts-morph").JsxAttribute | undefined;
      const own = literal(attribute("path")?.getInitializer());
      const index = attribute("index") !== undefined;
      let path = "";
      const ancestors = [element.getParent(), ...element.getAncestors()].filter((node): node is Node => Boolean(node));
      const routeTags = [...ancestors.filter((node) => Node.isJsxElement(node) && node.getOpeningElement().getTagNameNode().getText() === "Route")] as import("ts-morph").JsxElement[];
      for (const ancestor of routeTags.reverse()) {
        if (ancestor.getOpeningElement() === element) continue;
        const value = literal((ancestor.getOpeningElement().getAttributes().find((entry) => Node.isJsxAttribute(entry) && entry.getNameNode().getText() === "path") as import("ts-morph").JsxAttribute | undefined)?.getInitializer());
        path = joinPath(path || "/", value);
      }
      path = joinPath(path || "/", own);
      const elementProp = attribute("element")?.getInitializer();
      const componentAttr = attribute("Component")?.getInitializer();
      const hasChildren = Node.isJsxOpeningElement(element) && Node.isJsxElement(element.getParent()) && (element.getParent() as import("ts-morph").JsxElement).getJsxChildren().some((child) => Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child));
      if (hasChildren && !index) continue; // layout route: its path only prefixes the children
      const component = pageComponent(elementProp) ?? (componentAttr ? componentAttr.getText().replace(/[{}]/g, "") : undefined);
      if (own === undefined && !index) continue;
      emit(path, component);
    }
  }
  return [...hints.values()];
}
