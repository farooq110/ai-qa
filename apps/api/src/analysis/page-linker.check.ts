/** Offline check: crawled pages are linked to their source file by text, whatever the router looks like. */
import assert from "node:assert/strict";
import { aliasRules, buildImportGraph } from "./analyzer";
import { linkPagesToCode } from "./page-linker";
import type { DiscoveredPage } from "./live-discovery";

const page = (route: string, texts: string[]): DiscoveredPage => ({
  url: `https://x.test${route}`, route, title: "App", navItems: [], buttons: [], inputs: [], headings: [], clickables: [], selects: [], labelPairs: [], pageText: "", texts
});

// A router nobody wrote a reader for: pages sit behind a lazy barrel, a hub imports them all, and the
// list page keeps its column captions in a child file.
const sources = new Map([
  ["src/pages/Employees/index.tsx", 'import { columns } from "./columns"; export default function Employees(){ return <h1>Staff directory</h1>; }'],
  ["src/pages/Employees/columns.tsx", 'export const columns = [{ header: "Employee Name" }, { header: "Designation" }, { header: "Salary Type" }];'],
  ["src/pages/Stocks/index.tsx", 'export default function Stocks(){ return <div><h1>Stock room</h1><label>Item Name</label><label>Reorder Level</label></div>; }'],
  ["src/pages/Income/index.tsx", 'export default function Income(){ return <div><h1>Income report</h1><p>Monthly Revenue</p><p>Net Profit</p></div>; }'],
  ["src/pages/Orders/index.tsx", 'export default function Orders(){ return <div><h1>Order board</h1><p>Delivery Date</p><p>Customer Name</p></div>; }'],
  ["src/routes/lazy.ts", 'export const A = lazy(() => import("../pages/Employees")); export const B = lazy(() => import("../pages/Stocks")); export const C = lazy(() => import("../pages/Income")); export const D = lazy(() => import("../pages/Orders"));'],
  ["src/api/server.ts", 'export const note = "Employee Name Designation Salary Type";']
]);
const graph = buildImportGraph(sources, aliasRules(new Map()));
const result = linkPagesToCode([
  page("/employee", ["Staff directory", "Employee Name", "Designation", "Salary Type", "Rows per page"]),
  page("/stocks", ["Stock room", "Item Name", "Reorder Level"]),
  page("/income", ["Income report", "Monthly Revenue", "Net Profit"]),
  page("/orders", ["Order board", "Delivery Date", "Customer Name"]),
  page("/ghost", ["Nothing like this in the code", "Not written anywhere"])
], [], sources, graph, new Map([["src/api/server.ts", "backend"]]));

const linked = new Map(result.links.map((link) => [link.pattern, link.file]));
assert.equal(linked.get("/employee"), "src/pages/Employees/index.tsx", "the page's own file, not its columns child, not the lazy hub, not the backend file");
assert.equal(linked.get("/stocks"), "src/pages/Stocks/index.tsx");
assert.equal(linked.get("/income"), "src/pages/Income/index.tsx");
assert.ok(!linked.has("/ghost"), "text found nowhere links nothing");
assert.deepEqual(result.coverage, { pages: 5, linked: 4, byText: 4, unlinked: ["/ghost"] });
assert.ok(result.routes.some((route) => route.path === "/employee" && route.file === "src/pages/Employees/index.tsx"), "linked pages become routes");

// pages a route reader already linked are left alone
const kept = linkPagesToCode([page("/stocks", ["Stock room", "Item Name", "Reorder Level"])], [{ path: "/stocks", page: "S", feature: "Stocks", file: "src/pages/Orders/index.tsx" }], sources, graph);
assert.equal(kept.links.length, 0);
assert.equal(kept.routes[0].file, "src/pages/Orders/index.tsx");

console.log("page-linker.check: ok");
