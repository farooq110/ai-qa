/**
 * Self-check for flow-spec anchoring (Phase 4). Run:
 * pnpm exec tsc -p tsconfig.json --outDir .check-out && node .check-out/analysis/anchor.check.js
 * (delete .check-out afterwards). Fails loudly if quote verification, literal-in-quote checks, or
 * the line-number lookup regress.
 */
import { strict as assert } from "node:assert";
import { anchorFlowSpec, buildModules, joinCall, locateLiteral, quoteLine } from "./specs";
import type { FlowSpecData } from "@ai-qa/contracts";
import type { RouteInfo } from "./analyzer";
import type { EndpointRow } from "./endpoints";

const sliceSources = new Map([
  ["api/src/modules/orders/orders.routes.ts", [
    "1: import { Router } from 'express';",
    "2: const router = Router();",
    "3: router.post('/:id/approve', authenticate, requirePermission(Permission.APPROVE_ORDER), ordersController.approve);"
  ].join("\n")]
]);

function run() {
  // --- quote present -> line number computed from its own "N: " prefix ---
  {
    const raw: Partial<FlowSpecData> = {
      actions: [{
        id: "a1", name: "Approve order", kind: "mutation",
        trigger: { route: "/orders/:id", label: "approve", control: "button", container: "OrderDetail" },
        preconditions: [], permission: { value: "APPROVE_ORDER", enforcedBy: "server" }, form: [],
        calls: [{ method: "POST", path: "/orders/:id/approve", endpointId: null }],
        backendRules: [{ id: "r1", condition: "status is pending", message: "Only pending orders can be approved", reproducibleViaUi: true }],
        effects: [],
        src: [{ file: "api/src/modules/orders/orders.routes.ts", quote: "3: router.post('/:id/approve', authenticate, requirePermission(Permission.APPROVE_ORDER), ordersController.approve);" }]
      }]
    };
    const { spec, stats } = anchorFlowSpec(raw, sliceSources);
    assert.equal(stats.facts, 1, "anchored action kept");
    assert.equal(stats.dropped.length, 0);
    assert.equal(quoteLine(spec.actions[0].src[0].quote), 3, "line number read from the quote's own prefix");
    assert.equal(spec.actions[0].permission?.value, "APPROVE_ORDER", "permission literal found inside the quote is kept");
  }

  // --- quote missing from the slice entirely -> the whole action is dropped ---
  {
    const raw: Partial<FlowSpecData> = {
      actions: [{
        id: "a2", name: "Delete order", kind: "mutation",
        trigger: { route: "/orders/:id", label: "Delete", control: "button", container: "OrderDetail" },
        preconditions: [], permission: null, form: [], calls: [], backendRules: [], effects: [],
        src: [{ file: "api/src/modules/orders/orders.routes.ts", quote: "4: router.delete('/:id', ordersController.remove);" }]
      }]
    };
    const { stats } = anchorFlowSpec(raw, sliceSources);
    assert.equal(stats.facts, 0);
    assert.equal(stats.dropped.length, 1);
    assert.match(stats.dropped[0], /no anchored source quote/);
  }

  // --- quote is real, but a literal the fact claims (a permission name) is not inside it -> that one field is dropped, not the whole action ---
  {
    const raw: Partial<FlowSpecData> = {
      actions: [{
        id: "a3", name: "Approve order", kind: "mutation",
        trigger: { route: "/orders/:id", label: "approve", control: "button", container: "OrderDetail" },
        preconditions: [], permission: { value: "SOME_OTHER_PERMISSION", enforcedBy: "server" }, form: [],
        calls: [{ method: "POST", path: "/orders/:id/approve", endpointId: null }],
        backendRules: [], effects: [],
        src: [{ file: "api/src/modules/orders/orders.routes.ts", quote: "3: router.post('/:id/approve', authenticate, requirePermission(Permission.APPROVE_ORDER), ordersController.approve);" }]
      }]
    };
    const { spec, stats } = anchorFlowSpec(raw, sliceSources);
    assert.equal(stats.facts, 1, "the action itself survives");
    assert.equal(spec.actions[0].permission, null, "a permission value not inside any quote is dropped, not trusted");
  }

  // --- a template message's literal prefix (before a dynamic value) still counts as anchored ---
  {
    const prefixSources = new Map([["api/src/modules/orders/orders.service.ts", "1: throw new Error(`Only pending orders can be approved, got ${status}`);"]]);
    const raw: Partial<FlowSpecData> = {
      actions: [{
        id: "a4", name: "Approve order", kind: "mutation",
        trigger: { route: "/orders/:id", label: "approve", control: "button", container: "OrderDetail" },
        preconditions: [], permission: null, form: [],
        calls: [{ method: "POST", path: "/orders/:id/approve", endpointId: null }],
        backendRules: [{ id: "r1", condition: "status is pending", message: "Only pending orders can be approved", reproducibleViaUi: true }],
        effects: [],
        src: [{ file: "api/src/modules/orders/orders.service.ts", quote: "1: throw new Error(`Only pending orders can be approved, got ${status}`);" }]
      }]
    };
    const { spec } = anchorFlowSpec(raw, prefixSources);
    assert.equal(spec.actions[0].backendRules.length, 1, "the rule message's literal prefix is found inside the template-literal quote");
  }

  // --- a precondition's status literal not inside any quote is dropped (but the action survives if it still has a call/control) ---
  {
    const raw: Partial<FlowSpecData> = {
      actions: [{
        id: "a5", name: "Approve order", kind: "mutation",
        trigger: { route: "/orders/:id", label: "approve", control: "button", container: "OrderDetail" },
        preconditions: [
          { kind: "status", entity: "Order", values: ["pending"], description: "no description anchored either", enforcedBy: "server" }
        ],
        permission: null, form: [],
        calls: [{ method: "POST", path: "/orders/:id/approve", endpointId: null }],
        backendRules: [], effects: [],
        src: [{ file: "api/src/modules/orders/orders.routes.ts", quote: "3: router.post('/:id/approve', authenticate, requirePermission(Permission.APPROVE_ORDER), ordersController.approve);" }]
      }]
    };
    const { spec, stats } = anchorFlowSpec(raw, sliceSources);
    assert.equal(stats.facts, 1, "the action survives");
    assert.equal(spec.actions[0].preconditions.length, 0, "a precondition whose status value is not inside any quote is dropped, not trusted");
  }

  // --- buildModules: a catch-all bucket ("settings") spanning several page directories splits by directory; a single-directory module ("orders") does not ---
  {
    const routes: RouteInfo[] = [
      { path: "/orders", page: "Orders", feature: "Orders", file: "web/src/pages/orders/Orders.tsx" },
      { path: "/orders/:id", page: "OrderDetail", feature: "Order Detail", file: "web/src/pages/orders/OrderDetail.tsx" },
      { path: "/settings/territories", page: "Territories", feature: "Territories", file: "web/src/pages/settings/territories/Territories.tsx" },
      { path: "/settings/roles", page: "Roles", feature: "Roles", file: "web/src/pages/settings/roles/Roles.tsx" }
    ];
    const endpoints: EndpointRow[] = [
      { id: "ep1", method: "GET", fullPath: "/api/territories", norm: "/api/territories", file: "api/src/modules/territories/territories.routes.ts", line: 1, handler: "territoriesController.list", middleware: [] },
      { id: "ep2", method: "GET", fullPath: "/api/roles", norm: "/api/roles", file: "api/src/modules/roles/roles.routes.ts", line: 1, handler: "rolesController.list", middleware: [] },
      { id: "ep3", method: "POST", fullPath: "/api/orders/:id/approve", norm: "/api/orders/:/approve", file: "api/src/modules/orders/orders.routes.ts", line: 1, handler: "ordersController.approve", middleware: [] },
      { id: "ep4", method: "GET", fullPath: "/api/deliveries/:id/orders", norm: "/api/deliveries/:/orders", file: "api/src/modules/deliveries/deliveries.routes.ts", line: 1, handler: "deliveriesController.orders", middleware: [] }
    ];
    const groups = buildModules(routes, endpoints);
    assert.ok(groups.some((group) => group.key === "orders" && group.entryFiles.length === 2), "single-directory module is not split");
    const territories = groups.find((group) => group.key === "settings/territories");
    const roles = groups.find((group) => group.key === "settings/roles");
    assert.ok(territories && roles, "a multi-directory catch-all module splits by page directory");
    assert.deepEqual(territories!.entryFiles, ["web/src/pages/settings/territories/Territories.tsx"]);
    assert.equal(territories!.endpoints.length, 1, "backend endpoint joins its sub-module by shared path segment, not key equality");
    assert.equal(territories!.endpoints[0].id, "ep1");
    assert.equal(roles!.endpoints[0].id, "ep2");
    const orders = groups.find((group) => group.key === "orders");
    assert.deepEqual(orders!.endpoints.map((endpoint) => endpoint.id), ["ep3"], "a sub-resource mention (/deliveries/:/orders) does not pull another module's backend in");
  }

  // --- literal recovery: a real label the model cited only via a backend line is located in the slice; an invented one is not ---
  {
    const slice = new Map([
      ["web/OrderDetail.tsx", "1: <Button onClick={approve}>\n2:   Approve\n3: </Button>\n4: toast.success('Order approved')"],
      ["api/orders.service.ts", "1: if (order.status !== 'PENDING') throw new AppError('Only pending orders can be approved', 422);"]
    ]);
    assert.deepEqual(locateLiteral("Approve", slice), { file: "web/OrderDetail.tsx", quote: "2:   Approve" }, "JSX text alone on its line is found");
    assert.equal(locateLiteral("Order approved", slice)?.file, "web/OrderDetail.tsx", "a string literal is found");
    const twoFiles = new Map([["web/A.tsx", "1: <Button>Delete</Button>"], ["web/B.tsx", "7: <Button>Delete</Button>"]]);
    assert.equal(locateLiteral("Delete", twoFiles, ["web/B.tsx"])?.file, "web/B.tsx", "the action's own cited file wins over slice order");
    assert.equal(locateLiteral("Approve Order Now", slice), null, "an invented label is not found");
    assert.equal(locateLiteral("approved", slice), null, "a fragment of a longer literal is not a whole literal");
    const { spec } = anchorFlowSpec({ actions: [{
      id: "approve", name: "Approve", kind: "button", trigger: { route: "/orders/:id", label: "Approve", control: "button", container: "Order" },
      preconditions: [], permission: null, form: [], calls: [{ method: "POST", path: "/orders/:id/approve", endpointId: null }],
      backendRules: [{ id: "r1", condition: "not pending", message: "Only pending orders can be approved", reproducibleViaUi: true }, { id: "r2", condition: "x", message: "Invented message", reproducibleViaUi: true }],
      effects: [], src: [{ file: "api/orders.service.ts", quote: "1: if (order.status !== 'PENDING') throw new AppError('Only pending orders can be approved', 422);" }]
    }] } as never, slice);
    assert.equal(spec.actions.length, 1, "action survives once its label is located");
    assert.deepEqual(spec.actions[0].backendRules.map((rule) => rule.id), ["r1"], "invented rule message still dropped");
  }

  // --- joinCall: same path, different methods - the call's own method decides ---
  {
    const rows: EndpointRow[] = [
      { id: "get", method: "GET", fullPath: "/api/categories", norm: "/api/categories", file: "r.ts", line: 1, handler: "list", middleware: [] },
      { id: "post", method: "POST", fullPath: "/api/categories", norm: "/api/categories", file: "r.ts", line: 2, handler: "create", middleware: [] }
    ];
    assert.equal(joinCall({ method: "post", path: "/categories" }, rows)?.id, "post");
    assert.equal(joinCall({ method: "GET", path: "/categories" }, rows)?.id, "get");
    assert.equal(joinCall({ method: "PATCH", path: "/categories" }, rows)?.id, "get", "no same-method row falls back to path-only");
  }

  // --- submit label and static options: kept only when the code contains them ---
  {
    const dialog = new Map([["web/AddCategory.tsx", [
      "1: <Button>Add Category</Button>",
      "2: const TYPES = ['Retail', 'Wholesale'];",
      "3: <Button type=\"submit\">Save Category</Button>"
    ].join("\n")]]);
    const field = (options: string[]) => ({ name: "type", label: "Type", control: "select", options, rules: [] });
    const { spec } = anchorFlowSpec({ actions: [
      { id: "add", name: "Add", kind: "modal", trigger: { route: "/categories", label: "Add Category", control: "button", container: "" }, submit: { label: "Save Category" },
        preconditions: [], permission: null, form: [field(["Retail", "Wholesale", "Invented"])], calls: [], backendRules: [], effects: [], src: [{ file: "web/AddCategory.tsx", quote: "1: <Button>Add Category</Button>" }] },
      { id: "add2", name: "Add", kind: "modal", trigger: { route: "/categories", label: "Add Category", control: "button", container: "" }, submit: { label: "Submit Now" },
        preconditions: [], permission: null, form: [], calls: [], backendRules: [], effects: [], src: [{ file: "web/AddCategory.tsx", quote: "1: <Button>Add Category</Button>" }] }
    ] }, dialog);
    assert.equal(spec.actions[0].submit?.label, "Save Category", "submit label recovered from the slice");
    assert.deepEqual(spec.actions[0].form[0].options, ["Retail", "Wholesale"], "invented option dropped");
    assert.equal(spec.actions[1].submit, null, "unanchored submit label dropped");
  }

  console.log("anchor.check.ts: all assertions passed");
}

run();
