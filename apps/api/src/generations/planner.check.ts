/**
 * Self-check for the Phase 5 planner. Run:
 * pnpm exec tsc -p tsconfig.json --outDir .check-out && node .check-out/generations/planner.check.js
 * (delete .check-out afterwards). Uses a fixture Orders spec (not a live one - Orders currently has
 * 0 anchored actions on the real app, see the Phase 4 follow-up). Fails loudly if category counts,
 * the create->approve->process setup chain, budget ordering, dedupe, or the permission gate regress.
 */
import { strict as assert } from "node:assert";
import type { FlowSpecAction, FlowSpecData } from "@ai-qa/contracts";
import { findSetupChain, isNavigationOnly, isRowScoped, planScenarios, type ModuleSpec } from "./planner";
import { alignFormSteps, alignToAction, openFormFirst, touchesTrigger } from "./spec-generator";

const SRC = [{ file: "fixture.ts", quote: "1: fixture" }];

function action(partial: Partial<FlowSpecAction> & { id: string; name: string }): FlowSpecAction {
  return {
    kind: "mutation", trigger: { route: "/orders/:id", label: partial.name, control: "button", container: "OrderDetail" },
    preconditions: [], permission: null, form: [], calls: [], backendRules: [], effects: [], src: SRC,
    ...partial
  };
}

const createOrder = action({
  id: "create-order", name: "Create order", permission: { value: "CREATE_ORDER", enforcedBy: "server" },
  form: [{ name: "customerId", label: "Customer", control: "select", rules: [{ id: "required-customer", kind: "required", value: null, message: "Customer is required", layer: "client" }] }],
  effects: [{ kind: "transition", entity: "Order", from: [], to: "pending", text: null, route: null }]
});
const approveOrder = action({
  id: "approve-order", name: "Approve order", permission: { value: "APPROVE_ORDER", enforcedBy: "server" },
  preconditions: [{ kind: "status", entity: "Order", values: ["pending"], description: "Only pending orders can be approved", enforcedBy: "server" }],
  backendRules: [{ id: "only-pending", condition: "status is pending", message: "Only pending orders can be approved", reproducibleViaUi: true }],
  effects: [{ kind: "transition", entity: "Order", from: ["pending"], to: "approved", text: null, route: null }]
});
const processOrder = action({
  id: "process-order", name: "Process order", permission: { value: "PROCESS_ORDER", enforcedBy: "server" },
  preconditions: [{ kind: "status", entity: "Order", values: ["approved"], description: "Only approved orders can be processed", enforcedBy: "server" }],
  effects: [{ kind: "transition", entity: "Order", from: ["approved"], to: "processing", text: null, route: null }]
});
const shipOrder = action({
  id: "ship-order", name: "Ship order", permission: { value: "SHIP_ORDER", enforcedBy: "server" },
  preconditions: [{ kind: "status", entity: "Order", values: ["processing"], description: "Only processing orders can ship", enforcedBy: "server" }],
  effects: [{ kind: "transition", entity: "Order", from: ["processing"], to: "shipped", text: null, route: null }]
});
const cancelOrder = action({
  id: "cancel-order", name: "Cancel order", permission: { value: "CANCEL_ORDER", enforcedBy: "server" },
  preconditions: [{ kind: "status", entity: "Order", values: ["pending"], description: "Only pending orders can be cancelled", enforcedBy: "server" }]
});

const ordersSpec: FlowSpecData = {
  module: { key: "orders", name: "Orders", summary: "" }, routes: [], navigation: [],
  entities: [{ name: "Order", statuses: [] }],
  actions: [createOrder, approveOrder, processOrder, shipOrder, cancelOrder]
};
const modules: ModuleSpec[] = [{ moduleKey: "orders", spec: ordersSpec }];
// Held by the fixture "current user": everything except CANCEL_ORDER, so cancel-order exercises the missing-permission gate.
const knownPermissions = new Set(["create_order", "approve_order", "process_order", "ship_order"]);

function run() {
  // --- setup chain: ship needs create -> approve -> process (in that order) ---
  const chain = findSetupChain([createOrder, approveOrder, processOrder, shipOrder, cancelOrder], shipOrder);
  assert.ok(chain, "a chain exists for ship");
  assert.deepEqual(chain!.map((a) => a.id), ["create-order", "approve-order", "process-order"]);

  // --- exact counts per category ---
  const { scenarios, skipped } = planScenarios(modules, { knownPermissions });
  const byCategory = (category: string) => scenarios.filter((s) => s.category === category);
  assert.equal(byCategory("HAPPY_PATH").length, 4, "create/approve/process/ship - cancel is permission-gated");
  assert.equal(byCategory("VALIDATION").length, 1, "create's one required-field rule");
  assert.equal(byCategory("BOUNDARY").length, 0);
  assert.equal(byCategory("NEGATIVE").length, 1, "approve's one backend rule");
  assert.equal(byCategory("STATE").length, 3, "approve/process/ship preconditions - cancel's is gated");
  assert.equal(byCategory("PERMISSION").length, 1, "cancel's missing-permission scenario");

  // --- ship's own scenario carries the chain as its setup ---
  const shipHappy = scenarios.find((s) => s.scenarioKey === "orders:ship-order:HAPPY_PATH");
  assert.ok(shipHappy);
  assert.equal(shipHappy!.setup.strategy, "chain");
  assert.deepEqual(shipHappy!.setup.chain!.map((a) => a.id), ["create-order", "approve-order", "process-order"]);

  // --- missing permission: one PERMISSION scenario, every other category skipped with a reason ---
  const cancelPermission = scenarios.find((s) => s.scenarioKey === "orders:cancel-order:PERMISSION:CANCEL_ORDER");
  assert.ok(cancelPermission, "the hidden-trigger scenario is still generated");
  const cancelSkips = skipped.filter((s) => s.scenarioKey.startsWith("orders:cancel-order:") && s.scenarioKey !== cancelPermission!.scenarioKey);
  assert.ok(cancelSkips.length >= 1 && cancelSkips.every((s) => s.reason === "needs another role"));
  assert.ok(!scenarios.some((s) => s.actionId === "cancel-order" && s.category !== "PERMISSION"), "no other category was generated for a permission-gated action");

  // --- dedupe: an existing scenarioKey disappears entirely (neither planned nor reported skipped) ---
  const existingScenarioKeys = new Set(["orders:create-order:HAPPY_PATH"]);
  const deduped = planScenarios(modules, { knownPermissions, existingScenarioKeys });
  assert.ok(!deduped.scenarios.some((s) => s.scenarioKey === "orders:create-order:HAPPY_PATH"));
  assert.ok(!deduped.skipped.some((s) => s.scenarioKey === "orders:create-order:HAPPY_PATH"));

  // --- budget: happy paths (round-robin, single module here) come first; everything past the cut is skipped "budget" ---
  const oneScenarioBudget = Math.ceil(1_500 + 0.3 * 6_000) + 10; // room for exactly one scenario
  const tight = planScenarios(modules, { knownPermissions, budgetTokens: oneScenarioBudget });
  assert.equal(tight.scenarios.length, 1);
  assert.equal(tight.scenarios[0].category, "HAPPY_PATH", "happy paths are ordered first");
  assert.ok(tight.skipped.some((s) => s.reason === "budget"));

  // Navigation-only actions plan nothing; duplicate rule messages on one field plan once.
  {
    const goBack = action({ id: "go-back", name: "Go Back", effects: [{ kind: "navigate", entity: null, from: [], to: null, text: null, route: "/" }] });
    const exportCsv = action({ id: "export", name: "Export", calls: [{ method: "GET", path: "/orders/export", endpointId: null }] });
    const save = action({ id: "save", name: "Save", calls: [{ method: "POST", path: "/x", endpointId: null }], form: [{ name: "name", label: "Name", control: "input", rules: [
      { id: "r1", kind: "required", value: null, message: "Name is required", layer: "client" },
      { id: "r2", kind: "required", value: null, message: "Name is required", layer: "server" }
    ] }] });
    assert.ok(isNavigationOnly(goBack) && isNavigationOnly(exportCsv) && !isNavigationOnly(save));
    const result = planScenarios([{ moduleKey: "m", spec: { module: { key: "m", name: "M", summary: "" }, routes: [], navigation: [], entities: [], actions: [goBack, exportCsv, save] } }]);
    assert.deepEqual(result.scenarios.map((scenario) => scenario.scenarioKey).sort(), ["m:save:HAPPY_PATH", "m:save:VALIDATION:r1"]);
    assert.ok(result.skipped.some((entry) => entry.scenarioKey === "m:go-back:HAPPY_PATH" && entry.reason === "navigation-only"));
  }

  // VALIDATION cap is per action: two forms each keep their own rules.
  {
    const rules = (prefix: string) => [0, 1, 2].map((i) => ({ id: `${prefix}${i}`, kind: "required", value: null, message: `${prefix} field ${i} is required`, layer: "client" as const }));
    const formAction = (id: string) => action({ id, name: id, calls: [{ method: "POST", path: `/${id}`, endpointId: null }], form: [{ name: "f", label: "F", control: "input", rules: rules(id) }] });
    const result = planScenarios([{ moduleKey: "m", spec: { module: { key: "m", name: "M", summary: "" }, routes: [], navigation: [], entities: [], actions: [formAction("a"), formAction("b")] } }], { maxValidationBoundary: 2 });
    const validation = result.scenarios.filter((scenario) => scenario.category === "VALIDATION");
    assert.deepEqual(validation.map((scenario) => scenario.actionId).sort(), ["a", "a", "b", "b"]);
  }

  const modal = { trigger: { label: "Adjust Stock", route: "/inventory", control: "button", container: "" }, form: [{ name: "quantity", label: "Quantity *", control: "number", rules: [] }] } as unknown as FlowSpecAction;
  const opened = openFormFirst([{ action: "fill", target: "Quantity *", value: "0" }, { action: "assert", target: "Quantity must be greater than zero" }], modal);
  assert.deepEqual(opened.map((step) => step.target), ["Adjust Stock", "Quantity *", "Quantity must be greater than zero"], "trigger click inserted before the first modal field");
  const already = [{ action: "click", target: "Adjust Stock" }, { action: "fill", target: "quantity", value: "1" }];
  assert.equal(openFormFirst(already, modal), already, "already-opened form is left alone");

  const withSelect = { ...modal, form: [{ name: "productId", label: "Product *", control: "select", options: [], rules: [] }, { name: "reason", label: "Reason *", control: "select", options: ["Restock"], rules: [] }, { name: "quantity", label: "Quantity *", control: "number", rules: [] }] } as unknown as FlowSpecAction;
  const aligned = alignFormSteps([{ action: "select", target: "Product *", value: "Product A" }, { action: "select", target: "reason", value: "restock" }, { action: "fill", target: "quantity", value: "5" }], withSelect);
  assert.deepEqual(aligned, [{ action: "select", target: "Product *", value: "{{any}}" }, { action: "select", target: "Reason *", value: "Restock" }, { action: "fill", target: "Quantity *", value: "5" }], "invented option -> {{any}}, code names -> labels");

  const form = { ...modal, submit: { label: "Apply Adjustment" } } as unknown as FlowSpecAction;
  const noSubmit = alignToAction([{ action: "click", target: "Adjust Stock", key: true }, { action: "fill", target: "quantity", value: "0" }, { action: "assert", target: "Quantity must be greater than zero" }], form);
  assert.deepEqual(noSubmit.map((step) => `${step.target}${step.key ? "*" : ""}`), ["Adjust Stock", "Quantity *", "Apply Adjustment*", "Quantity must be greater than zero"], "missing submit inserted; only it is key");
  const sameLabel = { ...modal, trigger: { ...modal.trigger, label: "Generate" }, submit: { label: "Generate" } } as unknown as FlowSpecAction;
  const twice = alignToAction([{ action: "click", target: "Generate", key: true }, { action: "click", target: "Generate", key: true }, { action: "assert", target: "Done" }], sameLabel);
  assert.deepEqual(twice.map((step) => Boolean(step.key)), [false, true, false], "second click of a shared label is the submit");
  assert.equal(alignFormSteps([{ action: "fill", target: "quantity", value: "{{any}}" }], modal)[0].action, "select", "{{any}} on a fill becomes a select");

  const confirm = { trigger: { label: "Delete", route: "/categories", control: "button", container: "" }, submit: { label: "Delete" }, form: [] } as unknown as FlowSpecAction;
  assert.deepEqual(alignToAction([{ action: "click", target: "Delete" }, { action: "assert", target: "Category deleted" }], confirm).map((step) => `${step.target}${step.key ? "*" : ""}`), ["Delete", "Delete*", "Category deleted"], "confirm click inserted for a form-less confirmation");
  const editForm = { ...form, form: [{ name: "name", label: "Category Name *", control: "text", rules: [{ id: "required", kind: "required", value: null, message: "Category name is required", layer: "client" }] }] } as unknown as FlowSpecAction;
  const cleared = alignToAction([{ action: "click", target: "Adjust Stock" }, { action: "click", target: "Apply Adjustment" }, { action: "assert", target: "Category name is required" }], editForm, "required");
  assert.deepEqual(cleared.map((step) => `${step.action}:${step.target}`), ["click:Adjust Stock", "fill:Category Name *", "click:Apply Adjustment", "assert:Category name is required"], "required field cleared before submit");
  assert.equal(touchesTrigger([{ action: "click", target: "Expenses" }, { action: "assert", target: "Expense voided" }], confirm), false, "a test that never touches its trigger is caught");

  // row actions: a record is created first, then the row is picked out by its unique name
  const addStaff = action({ id: "add-staff", name: "Add Employee", kind: "form", trigger: { route: "/employee", label: "Add Employee", control: "button", container: "Page" }, submit: { label: "Save" },
    form: [{ name: "name", label: "Employee Name", control: "text", rules: [] }, { name: "email", label: "Email", control: "text", rules: [] }], effects: [] });
  const deleteStaff = action({ id: "delete-staff", name: "Delete Employee", kind: "confirmation", trigger: { route: "/employee", label: "Delete", control: "button", container: "Employee Page" }, submit: { label: "Delete" }, calls: [{ method: "DELETE", path: "/api/employees/:id", endpointId: null }] });
  const toolbar = action({ id: "export", name: "Export", kind: "button", rowScoped: false, trigger: { route: "/employee", label: "Delete all", control: "button", container: "Toolbar" } });
  assert.equal(isRowScoped(deleteStaff), true, "a Delete control on a list page is a row action");
  assert.equal(isRowScoped(toolbar), false, "the model's rowScoped=false wins over the label");
  assert.equal(isRowScoped(addStaff), false);
  const rowPlan = planScenarios([{ moduleKey: "employee", spec: { module: { key: "employee", name: "Employee", summary: "" }, routes: [], entities: [], navigation: [], actions: [addStaff, deleteStaff] } }]);
  const rowDelete = rowPlan.scenarios.find((scenario) => scenario.actionId === "delete-staff");
  assert.deepEqual(rowDelete?.setup.chain?.map((link) => link.id), ["add-staff"], "the delete's setup is creating the record it deletes");
  const created = alignToAction([{ action: "navigate", target: "/employee" }, { action: "click", target: "Add Employee" }, { action: "fill", target: "Employee Name", value: "John Doe" }, { action: "fill", target: "Email", value: "john@example.com" }, { action: "click", target: "Save" }], addStaff);
  assert.equal(created.find((step) => step.target === "Employee Name")?.value, "John Doe {{uniq}}", "a create happy path gets a findable name");
  assert.equal(created.find((step) => step.target === "Email")?.value, "john@example.com", "emails are left alone");
  const deleted = alignToAction([...created.filter((step) => step.action !== "navigate"), { action: "click", target: "Delete" }, { action: "click", target: "Delete" }, { action: "assert", target: "Removed" }], deleteStaff);
  const deleteClicks = deleted.filter((step) => step.target === "Delete");
  assert.equal(deleteClicks[0].within, "John Doe {{uniq}}", "the row trigger is scoped to the record the test created");
  assert.equal(deleteClicks[1].within, undefined, "the confirm click is not row-scoped");

  // required fields the draft skipped are filled before the submit, except the one under test
  const orderForm = action({ id: "create-order-2", name: "Create Order", kind: "form", trigger: { route: "/order", label: "Create Order", control: "button", container: "" }, submit: { label: "Save Order" },
    form: [{ name: "customer", label: "Customer Name", control: "text", rules: [{ id: "required", kind: "required", value: null, message: "Customer is required", layer: "client" }] },
      { name: "qty", label: "Quantity", control: "number", rules: [{ id: "qty-required", kind: "required", value: null, message: "Quantity cannot be 0", layer: "client" }] },
      { name: "contact", label: "Contact Number", control: "text", rules: [{ id: "contact-required", kind: "required", value: null, message: "Contact is required", layer: "client" }, { id: "contact-min", kind: "minLength", value: "11", message: "Bad number", layer: "client" }] }] });
  const filled = alignToAction([{ action: "click", target: "Create Order" }, { action: "fill", target: "Customer Name", value: "Ann" }, { action: "click", target: "Save Order" }, { action: "assert", target: "Order Created!" }], orderForm);
  assert.deepEqual(filled.filter((step) => step.action === "fill").map((step) => `${step.target}=${step.value}`), ["Customer Name=Ann {{uniq}}", "Quantity=1", "Contact Number=03001234567"]);
  const underTest = alignToAction([{ action: "click", target: "Create Order" }, { action: "fill", target: "Customer Name", value: "Ann" }, { action: "click", target: "Save Order" }, { action: "assert", target: "Quantity cannot be 0" }], orderForm, "qty-required");
  assert.equal(underTest.find((step) => step.target === "Quantity")?.value, "", "the field under test stays empty");

  console.log("planner.check.ts: all assertions passed");
}

run();
