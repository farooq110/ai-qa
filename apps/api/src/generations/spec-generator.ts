/**
 * Spec-grounded generation (Phase 5b): turns a planner scenario into an LLM prompt and parses the
 * response back into step lists the rest of the pipeline (sanitizeDraft/groundDraft/dry-run
 * verification) already knows how to handle. Pure/stateless - no DB, no provider call - so it's
 * unit-testable on its own; generations.service.ts owns the actual LLM call and persistence.
 */
import type { FlowSpecAction } from "@ai-qa/contracts";
import { isCreateAction, isRowScoped, type PlannedScenario } from "./planner";

type DraftStep = { action: string; target: string; value?: string; condition?: string; role?: string; key?: boolean; within?: string };
export interface SpecDraft { scenarioKey: string; title: string; capability: string; category: string; confidence: number; preconditions: string[]; steps: DraftStep[]; expectedResult: string }

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.:…]+$/, "").trim();

/**
 * Every literal already anchored on this action (a real quote backs it) is safe evidence that a
 * generated step naming it is grounded, even when the live crawl never saw it (a status badge that
 * only appears after a transition, a permission-gated label). Normalized the same way groundDraft's
 * own `found()` compares strings.
 */
export function buildSpecEvidence(action: FlowSpecAction): Set<string> {
  const evidence = new Set<string>();
  const add = (value: string | null | undefined) => { if (value) evidence.add(normalize(value)); };
  add(action.trigger.label);
  add(action.submit?.label);
  add(action.permission?.value);
  for (const field of action.form) {
    add(field.label);
    for (const option of field.options ?? []) add(option);
    for (const rule of field.rules) add(rule.message);
  }
  for (const rule of action.backendRules) add(rule.message);
  for (const effect of action.effects) { add(effect.text); add(effect.to); for (const value of effect.from) add(value); }
  return evidence;
}

/** Runner value: pick the first real option of a dropdown whose options load at runtime. */
export const ANY_OPTION = "{{any}}";

/**
 * Deterministic clean-up against the action's own form: a field named by its code name ("quantity")
 * becomes its visible label, and a select value that isn't one of the field's literal options (the
 * model inventing "Product A") becomes ANY_OPTION, so the runner picks a real one.
 */
export function alignFormSteps(steps: DraftStep[], action: FlowSpecAction): DraftStep[] {
  const byKey = new Map(action.form.flatMap((field) => [[normalize(field.label), field], [normalize(field.name), field]] as const));
  return steps.map((step) => {
    if (!["fill", "select"].includes(step.action)) return step;
    const field = byKey.get(normalize(step.target));
    if (!field) return step;
    const target = field.label;
    const options = field.options ?? [];
    const pick = step.action === "select" || step.value === ANY_OPTION || /select|combo|radio|dropdown/i.test(field.control);
    if (!pick) return { ...step, target };
    const known = options.find((option) => normalize(option) === normalize(step.value ?? ""));
    return { ...step, action: "select", target, value: known ?? ANY_OPTION };
  });
}

/**
 * A form behind a trigger (modal, drawer, inline form) does not exist until the trigger is clicked:
 * a step on one of its fields before that click can never run. Inserts the trigger click there.
 */
export function openFormFirst(steps: DraftStep[], action: FlowSpecAction): DraftStep[] {
  if (!action.form.length) return steps;
  const trigger = normalize(action.trigger.label);
  const fields = new Set(action.form.flatMap((field) => [normalize(field.label), normalize(field.name)]));
  for (const [index, step] of steps.entries()) {
    if (step.action === "click" && normalize(step.target) === trigger) return steps;
    if (["fill", "select", "upload"].includes(step.action) && fields.has(normalize(step.target))) {
      return [...steps.slice(0, index), { action: "click", target: action.trigger.label, key: true }, ...steps.slice(index)];
    }
  }
  return steps;
}

/**
 * The submit click is what a form scenario tests: when the action has one and the draft fills the form
 * but never clicks it (asserting a validation message straight after opening), insert it before the
 * first assert that follows the form. Then the submit click alone carries `key`, so the mutation check
 * removes exactly it - removing the trigger too only proves the dialog was needed, not the save.
 */
export function submitIsKey(steps: DraftStep[], action: FlowSpecAction): DraftStep[] {
  const submit = action.submit?.label;
  if (!submit) return steps;
  const label = normalize(submit);
  const trigger = normalize(action.trigger.label);
  const opened = steps.findIndex((step) => step.action === "click" && normalize(step.target) === trigger);
  if (opened < 0) return steps;
  let out = steps.map(({ key: _key, ...step }) => step as DraftStep);
  // Same label for trigger and submit ("Generate Schedule"): the submit is a later click than the opener.
  let at = out.findIndex((step, index) => index > opened && step.action === "click" && normalize(step.target) === label);
  if (at < 0) {
    const assertAt = out.findIndex((step, index) => index > opened && ["assert", "waitFor", "assertResponse"].includes(step.action));
    if (assertAt < 0) return steps;
    out = [...out.slice(0, assertAt), { action: "click", target: submit }, ...out.slice(assertAt)];
    at = assertAt;
  }
  out[at] = { ...out[at], key: true };
  return out;
}

/**
 * A "required" rule only fires when the field is empty - on an edit form the field arrives prefilled,
 * so the draft must clear it. Inserts `fill <field> ""` before the submit when no step touches the field.
 */
export function clearRequiredField(steps: DraftStep[], action: FlowSpecAction, variantId?: string): DraftStep[] {
  if (!variantId) return steps;
  const field = action.form.find((entry) => entry.rules.some((rule) => rule.id === variantId && rule.kind === "required"));
  if (!field || /select|combo|radio|dropdown|switch|check/i.test(field.control)) return steps;
  if (steps.some((step) => ["fill", "select"].includes(step.action) && normalize(step.target) === normalize(field.label))) return steps;
  const submitAt = steps.findIndex((step) => step.key === true);
  if (submitAt < 0) return steps;
  return [...steps.slice(0, submitAt), { action: "fill", target: field.label, value: "" }, ...steps.slice(submitAt)];
}

const NOT_A_NAME = /e-?mail|phone|mobile|tel\b|password|pass\b|date|time|amount|price|cost|qty|quantity|number|\bno\b|code|\bage\b|salary|zip|postal|url|website|percent|limit|stock|balance|discount|tax|\bid\b|cnic|nic\b/i;

/**
 * A record this test creates must be findable again: the row actions that follow (Edit, Delete) pick it
 * out of the list by its text. Gives a create happy path's first plain-text value a run-unique suffix when
 * nothing in it has one yet, so repeated runs never collide on a duplicate and the row is unambiguous.
 */
export function uniqueRecordName(steps: DraftStep[], action: FlowSpecAction, variantId?: string): DraftStep[] {
  if (variantId || !isCreateAction(action) || steps.some((step) => step.action === "fill" && step.value?.includes("{{uniq}}"))) return steps;
  const at = steps.findIndex((step) => step.action === "fill" && step.value && !NOT_A_NAME.test(step.target) && /[a-z]/i.test(step.value) && !/^[\w.+-]+@/.test(step.value));
  return at < 0 ? steps : steps.map((step, index) => (index === at ? { ...step, value: `${step.value} {{uniq}}` } : step));
}

/**
 * A row action (Edit, Delete on a list row) acts on one record, and the first click on a page lands on
 * the first row. The record this test just created (its name carries {{uniq}}) is the one to act on:
 * the trigger click, the first one after the create, gets `within` = that name.
 */
export function scopeToRow(steps: DraftStep[], action: FlowSpecAction): DraftStep[] {
  if (!isRowScoped(action)) return steps;
  const trigger = normalize(action.trigger.label);
  const named = (step: DraftStep, index: number) => step.action === "fill" && step.value?.includes("{{uniq}}") ? index : -1;
  const anchors = steps.map(named).filter((index) => index >= 0);
  const anchor = anchors.find((index) => !NOT_A_NAME.test(steps[index].target)) ?? anchors[0];
  if (anchor === undefined) return steps;
  const clickAt = steps.findIndex((step, index) => index > anchor && step.action === "click" && normalize(step.target) === trigger);
  if (clickAt < 0 || steps[clickAt].within) return steps;
  return steps.map((step, index) => (index === clickAt ? { ...step, within: steps[anchor].value } : step));
}

/** A valid value for a required field the draft skipped, from its control, name and own rules. */
function validValue(field: FlowSpecAction["form"][number]): DraftStep {
  const text = `${field.label} ${field.name}`;
  const length = Number(field.rules.find((rule) => /^(minLength|min_length|length)$/i.test(rule.kind))?.value) || 0;
  const minimum = Number(field.rules.find((rule) => rule.kind === "min")?.value);
  if (/select|combo|radio|dropdown|autocomplete/i.test(field.control)) return { action: "select", target: field.label, value: field.options?.[0] ?? ANY_OPTION };
  if (/date/i.test(field.control) || /\bdate\b/i.test(text)) return { action: "fill", target: field.label, value: new Date().toISOString().slice(0, 10) };
  if (/e-?mail/i.test(text)) return { action: "fill", target: field.label, value: "qa{{uniq}}@example.com" };
  if (/phone|contact|mobile|\btel\b|whatsapp/i.test(text)) return { action: "fill", target: field.label, value: "03001234567".padEnd(Math.max(11, length), "0").slice(0, Math.max(11, length)) };
  if (/number|numeric|amount|price|cost|quantity|\bqty\b|total|count|age|rate|salary/i.test(`${field.control} ${text}`)) return { action: "fill", target: field.label, value: String(Number.isFinite(minimum) && minimum > 1 ? minimum : 1) };
  return { action: "fill", target: field.label, value: `QA ${field.label.replace(/\s*\*\s*$/, "")} {{uniq}}`.padEnd(length, "x") };
}

/**
 * A required field the draft never fills stops the submit with "X is required" - the test then fails
 * for a reason that has nothing to do with what it checks. Fills each one (except the field under test)
 * with a valid value just before the submit click.
 */
export function fillRequiredFields(steps: DraftStep[], action: FlowSpecAction, variantId?: string): DraftStep[] {
  const submitAt = steps.findIndex((step) => step.key === true && step.action === "click");
  if (submitAt < 0 || !action.submit) return steps;
  const touched = new Set(steps.filter((step) => ["fill", "select", "upload"].includes(step.action)).map((step) => normalize(step.target)));
  const missing = action.form.filter((field) =>
    field.rules.some((rule) => rule.kind === "required")
    && !field.rules.some((rule) => rule.id === variantId)
    && !/file|upload|image|checkbox|switch|toggle/i.test(field.control)
    && !touched.has(normalize(field.label)) && !touched.has(normalize(field.name)));
  return missing.length ? [...steps.slice(0, submitAt), ...missing.map(validValue), ...steps.slice(submitAt)] : steps;
}

/** Every deterministic fix a spec draft gets against its own action, in order. */
export function alignToAction(steps: DraftStep[], action: FlowSpecAction, variantId?: string): DraftStep[] {
  const submitted = submitIsKey(openFormFirst(alignFormSteps(steps, action), action), action);
  return scopeToRow(uniqueRecordName(clearRequiredField(fillRequiredFields(submitted, action, variantId), action, variantId), action, variantId), action);
}

/** A spec test must touch its own trigger (click it, or assert it shown/hidden); one that doesn't is testing something else. */
export function touchesTrigger(steps: DraftStep[], action: FlowSpecAction): boolean {
  const trigger = normalize(action.trigger.label);
  return steps.some((step) => normalize(step.target) === trigger);
}

export interface ScenarioPromptInput {
  scenario: PlannedScenario;
  /** Real buttons/inputs/headings the crawl saw on this route, when available. */
  routeInventory?: { buttons: string[]; inputs: string[]; headings: string[]; navItems: string[] };
  /** page.ariaSnapshot({mode:"ai"}) for this route, when available - real, accessible target names. */
  aria?: string;
  /**
   * Verified steps from this scenario's setup chain's own HAPPY_PATH tests, concatenated in chain
   * order, with `key` already stripped (they are not what this scenario tests). Undefined for
   * strategy "none"; for strategy "existing" the prompt is told to pick a matching row instead.
   */
  recipeSteps?: DraftStep[];
}

export const SPEC_GENERATOR_SYSTEM_PROMPT = [
  "You write ONE Playwright-style test per scenario given, grounded ONLY in the action's own anchored facts (trigger, form, rules, effects) and the route's real inventory/ARIA snapshot when given.",
  "Return ONLY JSON: {\"drafts\":[{\"scenarioKey\",\"title\",\"capability\",\"category\",\"confidence\",\"preconditions\":[string],\"steps\":[{\"action\",\"target\",\"value?\",\"condition?\",\"role?\",\"key?\",\"within?\"}],\"expectedResult\"}]}.",
  "steps.action is one of: navigate, click, fill, select, upload, assert, waitFor, assertResponse. steps.condition (for assert/waitFor) is one of: visible, hidden, equals, contains, urlMatches. steps.target is ONLY the visible text/label itself, copied verbatim from the data given - never prefix it with its control kind (write \"Add Category\", never \"button: Add Category\" or \"input: Add Category\").",
  "Mark \"key\":true ONLY on the step(s) that perform THIS scenario's own trigger action (and, for a form scenario, its submit/confirm step) - never on a setup/recipe step prefixed to the test, and never on more than what the scenario is actually testing. The dry-run mutation check removes exactly the key steps and the test must then fail for a real reason.",
  "For a STATE or PERMISSION scenario (asserting a trigger is hidden): mark the step that navigates to/opens the specific record \"key\":true, and add a normal (non-hidden) assert that proves you are looking at the right record (its id, number, or a heading naming it) BEFORE the hidden assert. Without that identity assert, removing the key step leaves the hidden assert meaningless.",
  "When \"recipe\" steps are given in the input, they are ALREADY VERIFIED setup for a prior state (e.g. creating then approving a record) - include them verbatim, in order, as the first steps of your test, with no \"key\". After they run, continue with whatever's needed to reach the SPECIFIC record they produced (e.g. click it in a list, or read its id from the current URL) before this scenario's own action.",
  "The final assert must prove the action's own effect, not just that the page is still there: assert a value you typed appearing in a list/row, a success/error message the action's own data (effects or backendRules) names, or a count/state change - never the page's own heading or title, since that was already visible before the action and proves nothing happened.",
  "A form scenario's steps, in order: click the trigger, fill/select the fields, click action.submit.label (\"key\":true), then assert. Without the submit click nothing is saved. When action.submit is null the trigger click is the action itself. A select step is {action:\"select\", target: the field label, value: one of the field's options} - when the field has no options, use value \"{{any}}\" (the runner picks a real one). For a name/title a HAPPY_PATH creates, append {{uniq}} (e.g. \"QA Category {{uniq}}\") so repeated runs never collide on a duplicate name.",
  "A ROW action (action.rowScoped true: Edit, Delete, View on one record of a list) acts on ONE record. When a \"recipe\" is given it already created that record, and its name contains {{uniq}}: click the action's trigger with \"within\" set to that exact recipe text (e.g. \"QA Employee {{uniq}}\"), so the click lands on that record's row. With no recipe, set \"within\" to a record name read from the aria snapshot rows; when the list shows no rows return the insufficient-grounding fallback. Finish a delete with an assert of that same record text, condition \"hidden\" (the success message first, when the action gives one); finish an edit by asserting the new value visible.",
  "For any date value use the input's top-level 'today' as the reference (e.g. a future week start is after 'today'); never pick a date from another year. When a rule forbids a value (\"must be a Monday\"), the VALIDATION test types a value that BREAKS the rule (a Tuesday), not one that satisfies it. A VALIDATION or NEGATIVE test still fills EVERY other field of action.form with a valid value (as a happy path would) - only the field under test is empty/invalid - so its message is the only one that can fire and the browser's own required checks never block the submit.",
  "Never invent a label, message, or permission name beyond what the scenario's action data gives you. If the scenario cannot be written from what's given, return it with a single waitFor step on its trigger label and expectedResult \"insufficient grounding\" rather than guessing.",
  "Provide ONE draft for EVERY scenarioKey given, in the same order - never skip one, even a hard one; use the \"insufficient grounding\" fallback above instead of omitting it."
].join(" ");

/** One compact JSON object per scenario, batched into the prompt the model sees. */
export function scenarioPromptPayload(input: ScenarioPromptInput): Record<string, unknown> {
  const { scenario, routeInventory, aria, recipeSteps } = input;
  return {
    scenarioKey: scenario.scenarioKey,
    category: scenario.category,
    description: scenario.description,
    action: {
      name: scenario.action.name, kind: scenario.action.kind, trigger: scenario.action.trigger, submit: scenario.action.submit ?? null,
      preconditions: scenario.action.preconditions, permission: scenario.action.permission,
      form: scenario.action.form, backendRules: scenario.action.backendRules, effects: scenario.action.effects, rowScoped: isRowScoped(scenario.action)
    },
    ...(routeInventory ? { routeInventory } : {}),
    ...(aria ? { aria } : {}),
    ...(recipeSteps ? { recipe: recipeSteps } : { setupStrategy: scenario.setup.strategy })
  };
}
