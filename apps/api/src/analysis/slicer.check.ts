/**
 * Self-check for the generic import-graph extensions (Phase 2b). Run:
 * pnpm exec tsc -p tsconfig.json --outDir .check-out && node .check-out/analysis/slicer.check.js
 * (delete .check-out afterwards). Fails loudly if barrels, lazy imports, require, .js->.ts
 * remapping, extends-chained tsconfigs, or sliceModule's budget/skip logic regress.
 */
import { strict as assert } from "node:assert";
import { aliasRules, buildImportGraph, fanIn, reachableFromRoutes, resolveImport, sliceModule } from "./analyzer";

async function run() {
  // --- barrel re-exports: "export * from" and "export {a} from" both create edges + resolvability ---
  const barrelSources = new Map([
    ["src/features/orders/index.ts", 'export * from "./OrderList";\nexport { ApproveOrderDialog } from "./ApproveOrderDialog";'],
    ["src/features/orders/OrderList.tsx", "export function OrderList() { return null; }"],
    ["src/features/orders/ApproveOrderDialog.tsx", "export function ApproveOrderDialog() { return null; }"],
    ["src/pages/Orders.tsx", 'import { OrderList, ApproveOrderDialog } from "../features/orders";\nexport function Orders() { return null; }']
  ]);
  const barrelGraph = buildImportGraph(barrelSources);
  assert.ok(barrelGraph.exportsByFile.get("src/features/orders/index.ts")!.has("ApproveOrderDialog"), "export {x} from is resolvable through the barrel");
  const barrelReachable = reachableFromRoutes([{ path: "/orders", page: "Orders", feature: "Orders", file: "src/pages/Orders.tsx" }], barrelSources, barrelGraph);
  assert.ok(barrelReachable.has("src/features/orders/index.ts"));
  assert.ok(barrelReachable.has("src/features/orders/OrderList.tsx"), "export * from reaches the re-exported file");
  assert.ok(barrelReachable.has("src/features/orders/ApproveOrderDialog.tsx"));

  // --- dynamic import() (every lazy-loaded route) and require() both create reachability edges ---
  const lazySources = new Map([
    ["src/routes/index.tsx", 'const Orders = React.lazy(() => import("../pages/Orders"));\nconst legacy = require("../legacy-shim");'],
    ["src/pages/Orders.tsx", "export function Orders() { return null; }"],
    ["src/legacy-shim.js", "module.exports = {};"]
  ]);
  const lazyGraph = buildImportGraph(lazySources);
  const lazyReachable = reachableFromRoutes([{ path: "/x", page: "x", feature: "x", file: "src/routes/index.tsx" }], lazySources, lazyGraph);
  assert.ok(lazyReachable.has("src/pages/Orders.tsx"), "dynamic import() is a reachability edge");
  assert.ok(lazyReachable.has("src/legacy-shim.js"), "require() is a reachability edge");

  // --- .js/.jsx specifier resolves against a .ts/.tsx file on disk (Vite/ESM "import './x.js'" convention) ---
  const jsExtSources = new Map([
    ["src/api/orders.ts", "export const ordersApi = {};"],
    ["src/pages/Orders.tsx", 'import { ordersApi } from "../api/orders.js";']
  ]);
  const resolved = resolveImport("../api/orders.js", "src/pages/Orders.tsx", new Set(jsExtSources.keys()), []);
  assert.equal(resolved, "src/api/orders.ts");

  // --- query-string specifier ("?raw" etc.) is stripped before resolution ---
  const queryResolved = resolveImport("./icon.svg?raw", "src/pages/Orders.tsx", new Set(["src/pages/icon.svg"]), []);
  assert.equal(queryResolved, "src/pages/icon.svg");

  // --- tsconfig extends chain: child has no baseUrl/paths of its own, parent does ---
  const configs = new Map([
    ["tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })],
    ["web/tsconfig.json", JSON.stringify({ extends: "../tsconfig.json", compilerOptions: {} })]
  ]);
  const rules = aliasRules(configs);
  const childRule = rules.find((rule) => rule.dir === "web");
  assert.ok(childRule, "child tsconfig inherits paths through a relative extends");
  assert.equal(childRule!.target, "web/src/");

  // --- vite.config's resolve.alias (no tsconfig at all - common for plain-JS Vite/Vue apps) ---
  const viteConfigs = new Map([
    ["vite.config.js", 'import { fileURLToPath, URL } from "node:url";\nexport default { resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } } };']
  ]);
  const viteRules = aliasRules(viteConfigs);
  const viteRule = viteRules.find((rule) => rule.prefix === "@");
  assert.ok(viteRule, "vite.config alias is read without any tsconfig present");
  assert.equal(viteRule!.target, "src");
  const viteResolved = resolveImport("@/views/Home", "src/router/index.ts", new Set(["src/views/Home.vue"]), viteRules);
  assert.equal(viteResolved, "src/views/Home.vue", "a bare alias resolves to the real .vue file, not the literal import text");

  // --- sliceModule: budget cut-off and shared-file skip ---
  const moduleSources = new Map([
    ["src/pages/Orders.tsx", "x".repeat(100)],
    ["src/hooks/useOrderForm.ts", "y".repeat(100)],
    ["src/api/orders.api.ts", "z".repeat(100)],
    ["src/components/ui/button.tsx", "w".repeat(100)]
  ]);
  const moduleGraphSources = new Map([
    ["src/pages/Orders.tsx", 'import { useOrderForm } from "../hooks/useOrderForm";\nimport { ordersApi } from "../api/orders.api";\nimport { Button } from "../components/ui/button";'],
    ["src/hooks/useOrderForm.ts", "export function useOrderForm() {}"],
    ["src/api/orders.api.ts", "export const ordersApi = {};"],
    ["src/components/ui/button.tsx", "export function Button() { return null; }"]
  ]);
  const moduleGraph = buildImportGraph(moduleGraphSources);
  const slice = sliceModule(["src/pages/Orders.tsx"], moduleSources, moduleGraph, { budgetTokens: 1000, shared: new Set(["src/components/ui/button.tsx"]) });
  assert.ok(slice.includes("src/hooks/useOrderForm.ts"));
  assert.ok(slice.includes("src/api/orders.api.ts"));
  assert.ok(!slice.includes("src/components/ui/button.tsx"), "a file flagged shared is excluded from the slice");

  const tinyBudgetSlice = sliceModule(["src/pages/Orders.tsx"], moduleSources, moduleGraph, { budgetTokens: 1 });
  assert.deepEqual(tinyBudgetSlice, ["src/pages/Orders.tsx"], "the entry file is always included even under budget");

  // --- fanIn: a file reachable from every entry has high fan-in; a module-only file has fan-in 1 ---
  const fanSources = new Map([
    ["src/pages/Orders.tsx", 'import { Button } from "../components/ui/button";\nimport { useOrderForm } from "../hooks/useOrderForm";'],
    ["src/pages/Customers.tsx", 'import { Button } from "../components/ui/button";'],
    ["src/components/ui/button.tsx", "export function Button() { return null; }"],
    ["src/hooks/useOrderForm.ts", "export function useOrderForm() {}"]
  ]);
  const fanGraph = buildImportGraph(fanSources);
  const counts = fanIn(fanGraph, [
    { file: "src/pages/Orders.tsx", sources: fanSources },
    { file: "src/pages/Customers.tsx", sources: fanSources }
  ]);
  assert.equal(counts.get("src/components/ui/button.tsx"), 2);
  assert.equal(counts.get("src/hooks/useOrderForm.ts"), 1);

  console.log("slicer.check.ts: all assertions passed");
}

run().catch((error) => { console.error(error); process.exit(1); });
