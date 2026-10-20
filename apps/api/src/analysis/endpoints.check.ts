/**
 * Self-check for backend endpoint discovery (Phase 3). Run:
 * pnpm exec tsc -p tsconfig.json --outDir .check-out && node .check-out/analysis/endpoints.check.js
 * (delete .check-out afterwards). Uses a canned LLM output shaped like the real ERP's
 * app.ts / routes/index.ts / orders.routes.ts, so composeEndpoints is checked without a live
 * model call. Fails loudly if mount-prefix concatenation, handler-file resolution (including the
 * "const x = new Controller()" instance pattern), quote verification, or the join helpers regress.
 */
import { strict as assert } from "node:assert";
import { joinEndpoint, normalizeEndpointPath } from "@ai-qa/test-dsl";
import { buildImportGraph } from "./analyzer";
import { candidateFiles, composeEndpoints, quoteInsideCallWithPath } from "./endpoints";

const sources = new Map([
  ["api/src/app.ts", "import routes from './routes';\napp.use(`/api`, routes);"],
  ["api/src/routes/index.ts", "import ordersRoutes from '../modules/orders/orders.routes';\nrouter.use('/orders', ordersRoutes);"],
  ["api/src/modules/orders/orders.routes.ts", [
    "import { OrdersController } from './orders.controller';",
    "const ordersController = new OrdersController();",
    "router.get('/counts', authenticate, requirePermission(Permission.READ_ORDER), ordersController.getCounts);",
    "router.post('/:id/approve', authenticate, requirePermission(Permission.APPROVE_ORDER), validate({ body: approveOrderDto }), ordersController.approve);"
  ].join("\n")],
  ["api/src/modules/orders/orders.controller.ts", "export class OrdersController { approve() {} getCounts() {} }"]
]);
const graph = buildImportGraph(sources);

const llmOutput = {
  files: {
    "api/src/app.ts": { mounts: [{ prefix: "/api", target: "routes", quote: "app.use(`/api`, routes);" }], endpoints: [] },
    "api/src/routes/index.ts": { mounts: [{ prefix: "/orders", target: "ordersRoutes", quote: "router.use('/orders', ordersRoutes);" }], endpoints: [] },
    "api/src/modules/orders/orders.routes.ts": {
      mounts: [],
      endpoints: [
        { method: "get", path: "/counts", handler: "ordersController.getCounts", middleware: ["authenticate", "requirePermission(Permission.READ_ORDER)"], quote: "router.get('/counts', authenticate, requirePermission(Permission.READ_ORDER), ordersController.getCounts);" },
        { method: "post", path: "/:id/approve", handler: "ordersController.approve", middleware: ["authenticate", "requirePermission(Permission.APPROVE_ORDER)"], quote: "router.post('/:id/approve', authenticate, requirePermission(Permission.APPROVE_ORDER), validate({ body: approveOrderDto }), ordersController.approve);" },
        // Hallucinated: no such line in the file's source -> must be dropped.
        { method: "delete", path: "/:id", handler: "ordersController.remove", middleware: [], quote: "router.delete('/:id', ordersController.remove);" }
      ]
    }
  }
};

function run() {
  const rows = composeEndpoints(llmOutput, sources, graph);
  assert.equal(rows.length, 2, "the unanchored (hallucinated) endpoint must be dropped");

  const approve = rows.find((row) => row.handler === "ordersController.approve");
  assert.ok(approve, "approve endpoint composed");
  assert.equal(approve!.fullPath, "/api/orders/:id/approve", "mount prefixes concatenate app.ts -> routes/index.ts -> orders.routes.ts");
  assert.equal(approve!.method, "POST");
  assert.deepEqual(approve!.middleware, ["authenticate", "requirePermission(Permission.APPROVE_ORDER)"]);
  assert.equal(approve!.handlerFile, "api/src/modules/orders/orders.controller.ts", "handler resolves through the 'const x = new Controller()' instance pattern, not a direct import");

  const counts = rows.find((row) => row.handler === "ordersController.getCounts");
  assert.equal(counts!.fullPath, "/api/orders/counts");
  assert.equal(counts!.norm, "/api/orders/counts");

  // join: a frontend literal joins to the composed row by structural suffix match.
  const joined = joinEndpoint("/orders/${id}/approve", rows);
  assert.equal(joined?.handler, "ordersController.approve", "frontend literal joins to the composed row");

  // must NOT join a literal sibling route ("/orders/counts" as a frontend call) to the dynamic :id/approve row.
  const notJoined = joinEndpoint("/orders/counts/extra", [approve!]);
  assert.equal(notJoined, null, "a literal segment must not match a dynamic row segment");

  assert.equal(normalizeEndpointPath("https://api.example.com/orders/${id}/approve?x=1"), "/orders/:/approve");

  // A multi-line route call quoted by its handler/closing line still anchors to the path literal it encloses.
  const multiLine = "router.get(\n  '/export',\n  authenticate,\n  ordersController.exportXlsx\n);\nrouter.post('/:id/approve', ctrl.approve);";
  assert.ok(quoteInsideCallWithPath(multiLine, "5: );", "/export"), "closing line of the call anchors its own path");
  assert.ok(quoteInsideCallWithPath(multiLine, "4:   ordersController.exportXlsx", "/export"), "handler line anchors its own path");
  assert.ok(!quoteInsideCallWithPath(multiLine, "5: );", "/imaginary"), "a path not declared in that call is still rejected");
  assert.ok(!quoteInsideCallWithPath(multiLine, "6: );", "/export"), "a line number that does not hold the quoted text is rejected");
  assert.ok(!quoteInsideCallWithPath(multiLine, "6: router.post('/:id/approve', ctrl.approve);", "/export"), "a line outside the call is rejected");

  assert.equal(candidateFiles(new Map([["api/tests/integration/a.test.ts", "request(app).get('/api/x');"], ["api/src/x.spec.ts", "router.get('/x')"]])).size, 0, "test files are not route declarations");

  console.log(`endpoints.check.ts: ${rows.length} rows composed, 1 hallucinated endpoint dropped, all assertions passed`);
}

run();
