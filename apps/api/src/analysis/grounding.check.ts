/**
 * Self-check for the grounding rules. Run: pnpm exec tsc -p tsconfig.json --outDir .check-out && node .check-out/analysis/grounding.check.js
 * (delete .check-out afterwards). Fails loudly if param detection, URL building or the gate regress.
 */
import { strict as assert } from "node:assert";
import { aliasRules, buildImportGraph, extractRouteParams, importNeighborhood, nextRoutePath, resolveImport, type RouteInfo } from "./analyzer";
import { dedupeSharedControls, routeWithValues, type DiscoveredPage } from "./live-discovery";
import { diffTextSnapshots, evaluateResponseRule, findList, isAuthRoute, isNoiseText, matchesApiCall, needsAnonymousSession, parseResponseRule } from "@ai-qa/test-dsl";
import { summarizeResponse } from "./response-shape";
import { GenerationsService, testBudget } from "../generations/generations.service";
import { clusterPath, DENY_CLICK } from "./crawler";
import { fileBasedRoutes } from "./adapters/file-based";
import { reactRouterRoutes } from "./adapters/react-router";
import { codeRouteHints } from "./adapters";
import { summarizeCodebase } from "./code-context";

async function run() {
  // param detection: path param from the route, query params from the page code
  const sources = new Map([
    ["src/pages/Customiser.tsx", 'import { useSearchParams } from "react-router-dom";\nexport function Customiser(){ const [sp] = useSearchParams(); const code = sp.get("modelCode"); const id = sp.get("projectId"); return null; }'],
    ["src/pages/Home.tsx", "export function Home(){ const m = new Map(); m.get(\"x\"); return null; }"]
  ]);
  const routes: RouteInfo[] = [
    { path: "/customiser", page: "Customiser", feature: "Customiser" },
    { path: "/shop/:id", page: "Home", feature: "Shop" },
    { path: "/", page: "Home", feature: "Home" }
  ];
  const withParams = extractRouteParams(routes, sources, buildImportGraph(sources));
  assert.deepEqual(withParams[0].params, [{ name: "modelCode", in: "query" }, { name: "projectId", in: "query" }]);
  assert.deepEqual(withParams[1].params, [{ name: "id", in: "path" }]);
  assert.equal(withParams[2].params, undefined, "Map.get in a file without a search-params API is not a parameter");

  assert.equal(routeWithValues("/shop/:id", { id: "7", color: "red" }), "/shop/7?color=red");

  // grounding gate (private methods, reached through any)
  const service = new GenerationsService(null as never, null as never) as any;
  assert.equal(service.placeholderUrl("/customiser", ["modelCode", "projectId"]), "/customiser?modelCode={{modelCode}}&projectId={{projectId}}");
  assert.equal(service.placeholderUrl("/shop/:id", ["id"]), "/shop/{{id}}");
  const page = { url: "", route: "/summary", title: "Summary", navItems: [], buttons: ["Download PDF"], inputs: [], headings: ["Order summary"], clickables: ["Download PDF"], selects: [], labelPairs: [], pageText: "Order summary Total 10" };
  const model = { routes: [{ path: "/summary", page: "Summary", feature: "Summary" }], codeContext: [] };
  const targets = [{ capability: "Summary", route: "/summary", url: "/summary", page, code: [] }];
  const draft = (steps: Array<{ action: string; target: string }>) => ({ title: "t", capability: "Summary", category: "HAPPY_PATH", priority: "HIGH", route: "/summary", confidence: 0.1, preconditions: [], steps, expectedResult: "ok" });
  const good = service.groundDraft(draft([{ action: "click", target: "Download PDF" }, { action: "assert", target: "Download started" }]), targets, model);
  assert.equal(typeof good, "object", "real button + outcome message after an action is accepted");
  assert.equal(good.steps[0].action, "navigate");
  assert.equal(good.confidence, 0.7, "outcome text not on the page lowers confidence");
  const invented = service.groundDraft(draft([{ action: "click", target: "Export to Excel" }]), targets, model);
  assert.equal(typeof invented, "string", "invented button is rejected");
  const spec = new Set(["category name is required", "download pdf"]);
  assert.match(service.groundDraft(draft([{ action: "assert", target: "Category name is required" }]), targets, model, spec), /never performs the action/, "spec outcome asserted before any interaction is rejected");
  assert.match(service.groundDraft(draft([{ action: "assert", target: "Download PDF" }]), targets, model, spec), /only checks the page as loaded/, "spec draft with no interaction is rejected");
  assert.equal(typeof service.groundDraft(draft([{ action: "click", target: "Download PDF" }, { action: "assert", target: "Category name is required" }]), targets, model, spec), "object", "spec outcome after the action is accepted");
  const early = service.groundDraft(draft([{ action: "assert", target: "Welcome back" }]), targets, model);
  assert.equal(typeof early, "string", "text asserted before any action must already be on the page");
  // session choice: auth pages and sign-in tests run logged out, everything else keeps the plan session
  assert.ok(isAuthRoute("/login") && isAuthRoute("/auth/forgot-password") && isAuthRoute("https://x.com/reset-password/abc?t=1"));
  assert.ok(!isAuthRoute("/settings/password") && !isAuthRoute("/orders") && !isAuthRoute("/authors"));
  assert.ok(!isAuthRoute("/team/invite") && !isAuthRoute("/settings/sso") && !isAuthRoute("/employees") && !isAuthRoute("/users/42/activate"), "admin pages stay authenticated");
  assert.ok(isAuthRoute("/invite/abc") && isAuthRoute("/auth/callback") && isAuthRoute("/accept-invite"));
  // a team-management form with literal username/password values is NOT a sign-in test
  assert.ok(!needsAnonymousSession({ steps: [{ action: "navigate", target: "/team" }, { action: "fill", target: "Username", value: "jdoe" }, { action: "fill", target: "Password", value: "S3cret!" }] }));
  assert.ok(needsAnonymousSession({ steps: [{ action: "navigate", target: "/reset-password/abc" }] }));
  assert.ok(needsAnonymousSession({ steps: [{ action: "navigate", target: "/" }, { action: "fill", target: "email", value: "{{username}}" }] }));
  assert.ok(!needsAnonymousSession({ steps: [{ action: "navigate", target: "/summary" }] }));
  assert.ok(!needsAnonymousSession({ session: "authenticated", steps: [{ action: "navigate", target: "/login" }] }));
  // crawler: URL clustering and click safety
  assert.deepEqual(clusterPath("/orders/123/items/9?tab=lines"), { pattern: "/orders/:id/items/:id2", values: { id: "123", id2: "9" }, query: { tab: "lines" } });
  assert.equal(clusterPath("/orders/new").pattern, "/orders/new", "words stay literal");
  assert.equal(clusterPath("/customers/0b1f6d5c-1111-4222-8333-444455556666").pattern, "/customers/:id");
  assert.ok(DENY_CLICK.test("Delete order") && DENY_CLICK.test("Log out") && !DENY_CLICK.test("Orders") && !DENY_CLICK.test("Purchase Orders"));

  // adapters: file-based frameworks
  const nuxt = fileBasedRoutes(["pages/index.vue", "pages/orders/[id].vue", "pages/orders/index.vue"], [{ dir: "", json: '"nuxt": "^3"' }]).map((hint) => hint.pattern).sort();
  assert.deepEqual(nuxt, ["/", "/orders", "/orders/:id"]);
  const kit = fileBasedRoutes(["src/routes/+page.svelte", "src/routes/(app)/reports/[slug]/+page.svelte"], [{ dir: "", json: '"@sveltejs/kit": "^2"' }]).map((hint) => hint.pattern).sort();
  assert.deepEqual(kit, ["/", "/reports/:slug"]);
  const remix = fileBasedRoutes(["app/routes/_index.tsx", "app/routes/orders.$id.tsx"], [{ dir: "", json: '"@remix-run/react": "^2"' }]).map((hint) => hint.pattern).sort();
  assert.deepEqual(remix, ["/", "/orders/:id"]);

  // adapters: React Router AST (lazy, nested children, index, wrapper element, JSX <Route>)
  const router = new Map([
    ["web/src/routes/index.tsx", `
      import { createBrowserRouter } from "react-router-dom";
      import { lazy } from "react";
      import MainLayout from "../layout/MainLayout";
      import Dashboard from "../pages/dashboard/Dashboard";
      const Orders = lazy(() => import("../pages/orders/Orders"));
      export const router = createBrowserRouter([
        { path: "/login", element: <Login /> },
        { path: "/", element: <ProtectedRoute><MainLayout /></ProtectedRoute>, children: [
          { index: true, element: <Dashboard /> },
          { path: "orders", element: <Suspense><Orders /></Suspense> },
          { path: "orders/:id", lazy: () => import("../pages/orders/OrderDetail") },
          { path: "hr", children: [{ path: "me", Component: MyHr }] }
        ] }
      ]);`],
    ["web/src/pages/orders/Orders.tsx", "export default function Orders(){ return null; }"],
    ["web/src/pages/orders/OrderDetail.tsx", "export default function OrderDetail(){ return null; }"],
    ["web/src/pages/dashboard/Dashboard.tsx", "export default function Dashboard(){ return null; }"],
    ["web/src/layout/MainLayout.tsx", "export default function MainLayout(){ return null; }"],
    ["web/src/App.tsx", `import { Routes, Route } from "react-router-dom"; export const A = () => <Routes><Route path="/reports" element={<Layout/>}><Route path="sales" element={<SalesReport/>}/></Route></Routes>;`]
  ]);
  const found = new Map(reactRouterRoutes(router).map((hint) => [hint.pattern, hint.file]));
  for (const pattern of ["/login", "/", "/orders", "/orders/:id", "/hr/me", "/reports/sales"]) assert.ok(found.has(pattern), `react-router adapter finds ${pattern} (got ${[...found.keys()].join(", ")})`);
  assert.equal(found.get("/orders"), "web/src/pages/orders/Orders.tsx", "lazy variable resolved to its page file");
  assert.equal(found.get("/orders/:id"), "web/src/pages/orders/OrderDetail.tsx", "lazy() import resolved to its page file");
  assert.equal(found.get("/"), "web/src/pages/dashboard/Dashboard.tsx", "index route resolves through the wrapper element");

  // assertResponse: list finding, call matching, rules
  assert.equal(findList({ data: { items: [{ id: 1 }] }, errors: [] })?.path, "data.items");
  assert.equal(findList({ errors: [], meta: {} }), null, "an empty non-list array is not the list");
  assert.ok(matchesApiCall("/api/orders", "GET", "https://x.com/api/orders?status=1") && matchesApiCall("GET /orders/:id", "GET", "/orders/42/"));
  assert.ok(!matchesApiCall("/orders", "POST", "/orders") && !matchesApiCall("/orders", "GET", "/orders/42"));
  const list = { data: [{ status: "Pending", territory: { name: "North" } }, { status: "pending ", territory: { name: "North" } }] };
  const rule = (text: string) => parseResponseRule(text)!;
  assert.ok(evaluateResponseRule(rule("all status == Pending"), list).ok, "case and spacing are ignored");
  assert.match(evaluateResponseRule(rule("all status == Approved"), list).message, /item 1 of 2/);
  assert.ok(!evaluateResponseRule(rule("all status == Pending"), { data: [] }).ok, "an empty list cannot prove a filter");
  assert.ok(evaluateResponseRule(rule("count == 2"), list).ok && !evaluateResponseRule(rule("count > 2"), list).ok);
  assert.ok(evaluateResponseRule(rule("shown territory.name"), list, "Rows: North").ok && !evaluateResponseRule(rule("shown territory.name"), list, "none").ok);
  assert.equal(parseResponseRule("do something"), null);

  // response shapes: enum values, redaction, flattening
  const shape = summarizeResponse({ data: [
    { id: 1, status: "Pending", email: "a@b.co", password: "x", apiToken: "y", territory: { name: "North" }, tags: ["a"] },
    { id: 2, status: "Approved", email: "c@d.co", password: "x", apiToken: "y", territory: { name: "South" }, tags: [] },
    { id: 3, status: "Pending", email: "e@f.co", password: "x", apiToken: "y", territory: { name: "North" }, tags: [] }
  ] })!;
  assert.equal(shape.listPath, "data");
  assert.deepEqual(shape.fields.find((field) => field.name === "status")?.values, ["Pending", "Approved"]);
  assert.ok(!shape.fields.some((field) => /password|token|tags/i.test(field.name)), "secrets and arrays are dropped");
  assert.ok(shape.fields.some((field) => field.name === "territory.name") && !shape.fields.find((field) => field.name === "email")?.values, "nested field flattened, emails are not enum values");
  assert.equal(shape.sample[0].email, "<email>");

  // assertResponse grounding: call and field must have been seen, enum values must be real
  const apiPage = { ...page, apiShapes: { "GET /api/orders": shape } };
  const apiTargets = [{ capability: "Summary", route: "/summary", url: "/summary", page: apiPage, code: [] }];
  const withApi = (value: string, call = "/api/orders") => draft([{ action: "select", target: "Download PDF" }, { action: "assertResponse", target: call, value } as never]);
  assert.equal(typeof service.groundDraft(withApi("all status == Pending"), apiTargets, model), "object", "observed call, field and value are accepted");
  // an unsupported assertResponse is dropped; with nothing else to assert the draft is rejected
  for (const bad of [withApi("all status == Shipped"), withApi("all colour == red"), withApi("all status == Pending", "/api/invoices"), withApi("check it")]) {
    assert.match(service.groundDraft(bad, apiTargets, model), /nothing left to assert/);
  }

  // observed control behaviors: the next assert is held to what a real exercised control changed,
  // not a static guess - the fix for asserting a label an action never touched.
  const behaviorPage = { ...page, selects: [{ name: "Status", options: ["Pending", "Approved"] }], controlBehaviors: [{
    control: { kind: "select", label: "Status" }, valueTried: "Pending", requestsFired: [],
    appeared: ["Pending"], disappeared: ["Approved", "Delivered"]
  }] };
  const behaviorTargets = [{ capability: "Summary", route: "/summary", url: "/summary", page: behaviorPage, code: [] }];
  const withSelect = (assertTarget: string, condition?: string) => draft([{ action: "select", target: "Status" }, { action: "assert", target: assertTarget, ...(condition ? { condition } : {}) } as never]);
  const hiddenOk = service.groundDraft(withSelect("Approved", "hidden"), behaviorTargets, model);
  assert.equal(typeof hiddenOk, "object", "a text the control really hid is a valid hidden assert");
  assert.ok(hiddenOk.steps.some((step: { target: string; condition?: string }) => step.target === "Pending" && step.condition === "visible"), "a hidden-only check gets the observed visible proof added after it");
  assert.match(service.groundDraft(withSelect("Approved"), behaviorTargets, model), /so it cannot be visible afterwards/, "a vanished text cannot be asserted visible");
  assert.match(service.groundDraft(withSelect("Pending", "hidden"), behaviorTargets, model), /so it cannot be hidden/, "a text the control showed cannot be asserted hidden");
  assert.equal(typeof service.groundDraft(draft([{ action: "select", target: "Status" }, { action: "assert", target: "Pending", condition: "visible" } as never, { action: "assert", target: "Approved", condition: "hidden" } as never]), behaviorTargets, model), "object", "both sides asserted: accepted as written");
  const keptPage = { ...behaviorPage, controlBehaviors: [{ control: { kind: "select", label: "Status" }, valueTried: "Pending", requestsFired: [], appeared: [], disappeared: ["Approved"] }] };
  assert.match(service.groundDraft(withSelect("Approved", "hidden"), [{ ...behaviorTargets[0], page: keptPage }], model), /nothing was observed to show the page still works/, "hidden-only with no observed proof is rejected");

  // noise and description asserts are rejected; text already on the page before an unobserved action proves nothing
  assert.match(service.groundDraft(draft([{ action: "click", target: "Download PDF" }, { action: "assert", target: "Pending1" } as never]), behaviorTargets, model), /count or run-together/);
  assert.match(service.groundDraft(draft([{ action: "click", target: "Download PDF" }, { action: "assert", target: "Group processing orders into trips and monitor every delivery today" } as never]), behaviorTargets, model), /descriptive sentence/);
  assert.match(service.groundDraft(draft([{ action: "click", target: "Download PDF" }, { action: "assert", target: "Summary" } as never]), [{ ...behaviorTargets[0], page: { ...page, headings: ["Summary"] } }], model), /already on the page before the action/);
  assert.match(service.groundDraft(withSelect("Download PDF"), behaviorTargets, model), /was unchanged when the crawler tried Status/, "a text present on the page but UNCHANGED by the matching control is rejected");

  // two controls in a row: the assert is held to the crawler's COMBO entry, not the second control's solo one.
  const comboPage = { ...page, selects: [{ name: "Status", options: ["Pending", "Approved"] }], inputs: ["Search"], controlBehaviors: [
    { control: { kind: "select", label: "Status" }, valueTried: "Approved", requestsFired: ["GET /api/orders"], appeared: ["Approved"], disappeared: [] },
    { control: { kind: "input", label: "Search" }, valueTried: "ORD-1", requestsFired: ["GET /api/orders"], appeared: ["Solo Only Row"], disappeared: [] },
    { control: { kind: "input", label: "Search" }, valueTried: "ORD-1", requestsFired: ["GET /api/orders"], appeared: ["Combined Row"], disappeared: [],
      after: { control: { kind: "select", label: "Status" }, valueTried: "Approved" } }
  ] };
  const comboTargets = [{ capability: "Summary", route: "/summary", url: "/summary", page: { ...comboPage, pageText: `${page.pageText} Solo Only Row Combined Row` }, code: [] }];
  const pair = (assertTarget: string) => draft([{ action: "select", target: "Status" }, { action: "fill", target: "Search", value: "ORD-1" } as never, { action: "assert", target: assertTarget } as never]);
  assert.equal(typeof service.groundDraft(pair("Combined Row"), comboTargets, model), "object", "a text the PAIR produced grounds");
  assert.match(service.groundDraft(pair("Solo Only Row"), comboTargets, model), /was unchanged when the crawler tried Search/, "a text only the solo run produced is rejected after a prior control");
  assert.equal(typeof service.groundDraft(draft([{ action: "fill", target: "Search", value: "ORD-1" } as never, { action: "assert", target: "Solo Only Row" } as never]), comboTargets, model), "object", "Search alone still grounds from its solo entry");

  // an assertResponse right after an exercised control must be a call THAT control fired
  const firedPage = { ...page, controlBehaviors: [
    { control: { kind: "input", label: "Search" }, valueTried: "ORD-1", requestsFired: ["GET /api/orders"], responseCall: "/api/orders", appeared: [], disappeared: ["Other Row"], kept: ["ORD-1 Row"], responseShape: shape },
    { control: { kind: "input", label: "Search" }, valueTried: "zzqx9", requestsFired: [], appeared: ["No matches for “zzqx9”."], disappeared: ["ORD-1 Row"] }
  ], apiShapes: { "GET /api/orders": shape, "GET /api/invoices": shape }, inputs: ["Search"] };
  const firedTargets = [{ capability: "Summary", route: "/summary", url: "/summary", page: { ...firedPage, pageText: `${page.pageText} ORD-1 Row Other Row` }, code: [] }];
  const afterSearch = (call: string, value = "ORD-1") => draft([{ action: "fill", target: "Search", value } as never, { action: "assertResponse", target: call, value: "count >= 1" } as never, { action: "assert", target: "ORD-1 Row", condition: "visible" } as never]);
  assert.equal(typeof service.groundDraft(afterSearch("/api/orders"), firedTargets, model), "object", "the call the control fired is accepted");
  const droppedCall = service.groundDraft(afterSearch("/api/invoices"), firedTargets, model);
  assert.ok(typeof droppedCall === "object" && !droppedCall.steps.some((step: { action: string }) => step.action === "assertResponse"), "a call the control did not fire is dropped, the rest of the test stays");
  assert.equal(typeof service.groundDraft(draft([{ action: "fill", target: "Search", value: "zzqx9" } as never, { action: "assert", target: "No matches for “zzqx9”." } as never]), firedTargets, model), "object", "the no-match entry is chosen by the typed value");

  // a bare control label appearing after typing is not a result
  const clearPage = { ...page, buttons: ["Clear", "Download PDF"], inputs: ["Search"], controlBehaviors: [{ control: { kind: "input", label: "Search" }, valueTried: "te", requestsFired: [], appeared: ["Clear", "No matches for “te”."], disappeared: [] }] };
  const clearTargets = [{ capability: "Summary", route: "/summary", url: "/summary", page: clearPage, code: [] }];
  const typed = (assertTarget: string) => draft([{ action: "fill", target: "Search", value: "te" } as never, { action: "assert", target: assertTarget } as never]);
  assert.match(service.groundDraft(typed("Clear"), clearTargets, model), /only checks a control label/, "Clear alone is rejected");
  assert.equal(typeof service.groundDraft(typed("No matches for “te”."), clearTargets, model), "object", "the empty-state message is a real result");

  // noise never counts as evidence; real IDs, words and spaced labels do
  for (const noisy of ["633", "Pending1", "All633", "Date & DayArea & Territory", "1,200.50", "45%"]) assert.ok(isNoiseText(noisy), `${noisy} is noise`);
  for (const real of ["ORD-2026-72B6-0732-NBT", "CUST-017", "Settings", "Room 12", "No matches for “te”.", "My HR"]) assert.ok(!isNoiseText(real), `${real} is real`);
  const noiseDiff = diffTextSnapshots({ texts: ["All633", "ORD-1", "Pending1"], url: "/x" }, { texts: ["All0", "No matches"], url: "/x" });
  assert.deepEqual(noiseDiff, { appeared: ["No matches"], disappeared: ["ORD-1"] }, "counters are dropped from the diff");

  // a control on (nearly) every page is app chrome: kept on the first page only; a page-specific one stays
  const mk = (route: string, inputs: string[]): DiscoveredPage => ({ route, requested: route, url: route, title: "", navItems: [], buttons: [], inputs, headings: [], pageText: "", clickables: [],
    controlBehaviors: inputs.map((label) => ({ control: { kind: "input" as const, label }, valueTried: "te", requestsFired: [], appeared: [], disappeared: [] })) } as unknown as DiscoveredPage);
  const shell = [mk("/", ["Search modules..."]), mk("/orders", ["Search modules...", "Search orders"]), mk("/customers", ["Search modules...", "Search customers"]), mk("/bills", ["Search modules...", "Search bills"])];
  dedupeSharedControls(shell);
  assert.deepEqual(shell.map((entry) => entry.inputs), [["Search modules..."], ["Search orders"], ["Search customers"], ["Search bills"]], "shared control stays on its first page only");
  assert.deepEqual(shell[1].controlBehaviors?.map((behavior) => behavior.control.label), ["Search orders"]);
  const few = [mk("/", ["Search"]), mk("/a", ["Search"]), mk("/b", ["Search"])];
  dedupeSharedControls(few);
  assert.deepEqual(few.map((entry) => entry.inputs), [["Search"], ["Search"], ["Search"]], "too few pages to call a control shared");

  // weighting: auth pages get one test, richer pages get more
  assert.equal(testBudget(page as never, true), 1);
  assert.ok(testBudget({ ...page, inputs: ["a", "b", "c", "d"], selects: [], clickables: [], buttons: [] } as never, false) >= testBudget(page as never, false));

  // module canonicalization
  assert.equal(service.moduleKey("Auth"), service.moduleKey("Authentication"));
  assert.ok(service.sameModule("Auth", "Authentication") && service.sameModule("Purchase Orders", "Purchase Order"));
  assert.ok(!service.sameModule("Inventory", "Invoices"), "unrelated modules stay apart");

  // --- analysis fixtures: alias resolution, Next slots, monorepo scoping, code-context attachment ---

  // Fixture 1: Vite + "@/" tsconfig alias, lazy @/pages routes, a shadcn-style component library,
  // an RTK Query `url:` call, and a noise `searchParams.get` call that must NOT be read as an endpoint.
  const viteConfigs = new Map([
    ["tsconfig.json", '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./src/*"]}}}'],
    ["package.json", '{"dependencies":{"react-router-dom":"^6"}}']
  ]);
  const viteAliases = aliasRules(viteConfigs);
  assert.equal(resolveImport("@/pages/AreaVisits", "src/routes/index.tsx", new Set(["src/pages/AreaVisits.tsx"]), viteAliases), "src/pages/AreaVisits.tsx", "tsconfig @/ alias resolves a lazy import");
  const viteSources = new Map([
    ["src/routes/index.tsx", 'import { lazy } from "react"; import { createBrowserRouter } from "react-router-dom"; const AreaVisits = lazy(() => import("@/pages/AreaVisits")); export const router = createBrowserRouter([{ path: "/area-visits", lazy: () => import("@/pages/AreaVisits") }]);'],
    ["src/pages/AreaVisits.tsx", `
      import { Button } from "@/components/ui/button";
      import { Select, SelectItem } from "@/components/ui/select";
      import { useGetAreaVisitsQuery } from "@/api/areaVisits.api";
      export default function AreaVisits() {
        const status = searchParams.get("status");
        fetch("/area-visits/export");
        const { data } = useGetAreaVisitsQuery({ status });
        return (<div>
          <Select aria-label="Status"><SelectItem>Pending</SelectItem></Select>
          <Button onClick={handleRefresh}>Refresh</Button>
        </div>);
      }`],
    ["src/api/areaVisits.api.ts", 'export const areaVisits = { getAreaVisits: { query: () => ({ url: "/area-visits", method: "GET" }) } };']
  ]);
  const viteGraph = buildImportGraph(viteSources, viteAliases);
  const viteHints = await codeRouteHints(viteSources, [...viteSources.keys()], null, viteConfigs, viteAliases);
  const areaVisitsHint = viteHints.find((hint) => hint.pattern === "/area-visits");
  assert.ok(areaVisitsHint?.file === "src/pages/AreaVisits.tsx", `alias-resolved lazy route has its real page file (got ${JSON.stringify(areaVisitsHint)})`);
  const neighborhood = importNeighborhood("src/pages/AreaVisits.tsx", viteSources, viteGraph);
  assert.ok(neighborhood.includes("src/api/areaVisits.api.ts"), "the page's own imports (its API module) are in its neighborhood");
  const viteContext = summarizeCodebase(new Map([...neighborhood].filter((file) => viteSources.has(file)).map((file) => [file, viteSources.get(file)!])));
  const areaVisitsCtx = viteContext.find((entry) => entry.file === "src/pages/AreaVisits.tsx");
  assert.ok(areaVisitsCtx, "code context is keyed by the real repo path, not a flattened ts-morph name");
  assert.ok(areaVisitsCtx!.renderedElements.some((element) => element.label === "Status"), "a component-library control (<Select aria-label>) is extracted, not just raw <select>");
  assert.ok(areaVisitsCtx!.renderedElements.some((element) => element.label === "Refresh" && element.onClickHandler === "handleRefresh"), "a component-library button's onClick handler is read");
  assert.ok(areaVisitsCtx!.apiCalls.includes("/area-visits/export"), "a fetch(...) call is read as an endpoint");
  assert.ok(!areaVisitsCtx!.apiCalls.includes("status"), "searchParams.get('status') is not read as an endpoint");
  // A `url:` property is read the same way; non-component files (no JSX) are not analyzed at all yet -
  // known gap, left for the data-layer adapters, not claimed fixed here.
  assert.ok(/url\s*:\s*["'`]\/area-visits["'`]/.test(viteSources.get("src/api/areaVisits.api.ts")!), "fixture sanity: the api module really has a url: call");

  // Fixture 2: relative imports, raw HTML (no aliases, no component library) - must behave exactly as before.
  const amsSources = new Map([["src/pages/Leaves.tsx", 'export function LeavesPage(){ return (<button onClick={approve}>Approve</button>); }']]);
  const amsContext = summarizeCodebase(amsSources);
  assert.ok(amsContext[0]?.renderedElements.some((element) => element.label === "Approve"), "raw HTML extraction is unaffected");

  // Fixture 3: monorepo - a Next app's parallel-route slot resolves to its parent URL, and a sibling
  // Vite app's `pages/` folder is never read as Next routes (the bug that produced ~150 junk routes).
  assert.equal(nextRoutePath("apps/shop/src/app/account/@dashboard/orders/page.tsx", "apps/shop"), "/account/orders", "a parallel slot adds no URL segment");
  const monoHints = await codeRouteHints(
    new Map([
      ["apps/shop/src/app/account/@dashboard/orders/page.tsx", "export default function Orders(){ return null; }"],
      ["apps/vite-app/src/pages/Orders.tsx", "export default function Orders(){ return null; }"]
    ]),
    ["apps/shop/src/app/account/@dashboard/orders/page.tsx", "apps/vite-app/src/pages/Orders.tsx"],
    null,
    new Map([["apps/shop/package.json", '{"dependencies":{"next":"^14"}}'], ["apps/vite-app/package.json", '{"dependencies":{"vite":"^5"}}']])
  );
  assert.ok(monoHints.some((hint) => hint.pattern === "/account/orders"), "the Next app's slot route is found");
  assert.ok(!monoHints.some((hint) => hint.pattern === "/Orders"), "the sibling Vite app's pages/ folder is not read as Next routes");

  console.log("grounding.check: ok");
}

if (require.main === module) void run().catch((error) => { console.error(error); process.exitCode = 1; });
