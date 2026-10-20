/**
 * Planner (Phase 5a): deterministic, over the typed FlowSpec - no LLM call. Turns each module's
 * anchored actions into concrete test scenarios (happy path, validation/boundary, backend-rule
 * negatives, state preconditions, permission checks), finds a setup chain for actions that need
 * another action's effect first (e.g. ship needs create -> approve -> process), dedupes against
 * scenarios that already exist, and stops at a token budget - everything past the cut is reported
 * as skipped, not silently dropped.
 */
import type { FlowSpecAction, FlowSpecData } from "@ai-qa/contracts";
import { isAuthRoute } from "@ai-qa/test-dsl";

export type ScenarioCategory = "HAPPY_PATH" | "VALIDATION" | "BOUNDARY" | "NEGATIVE" | "STATE" | "PERMISSION";

export interface SetupRecipe {
  strategy: "chain" | "existing" | "none";
  /** Present only for strategy "chain": the actions to run, in order, before this scenario's own action. */
  chain?: FlowSpecAction[];
}

export interface PlannedScenario {
  scenarioKey: string;
  moduleKey: string;
  actionId: string;
  action: FlowSpecAction;
  category: ScenarioCategory;
  /** The client rule, backend rule, or precondition this scenario targets; absent for HAPPY_PATH. */
  variantId?: string;
  description: string;
  setup: SetupRecipe;
  estimatedTokens: number;
}

export interface PlannerSkip { scenarioKey: string; reason: string }
export interface PlannerResult { scenarios: PlannedScenario[]; skipped: PlannerSkip[] }

export interface ModuleSpec { moduleKey: string; spec: FlowSpecData }

export interface PlannerOptions {
  /** Default 600_000 (plan's default). Scenarios past this cut are reported skipped, not generated. */
  budgetTokens?: number;
  /** scenarioKey values already held by a non-archived TestCase - re-planning never duplicates these. */
  existingScenarioKeys?: Set<string>;
  /**
   * Permission values the current crawl user is known to hold (already normalized or not - this
   * module normalizes both sides). `null` means "we don't know", which is different from "holds
   * none": an unknown permission set skips the PERMISSION category entirely rather than assuming
   * either outcome.
   */
  knownPermissions?: Set<string> | null;
  /** Caps VALIDATION+BOUNDARY scenarios combined, across the whole run. Plan default: 6. */
  /** Per action. */
  maxValidationBoundary?: number;
}

const DEFAULT_BUDGET_TOKENS = 600_000;
const DEFAULT_MAX_VALIDATION_BOUNDARY = 6;
// ~1.5k tokens to generate one scenario, plus a 30% chance of needing a ~6k-token repair pass.
const SCENARIO_TOKEN_COST = 1_500 + 0.3 * 6_000;

/** Lowercase, alphanumeric-only comparison: a spec's anchored literal is the enum key ("Permission.APPROVE_ORDER" -> "approveorder"), the crawl's runtime value is often the enum's own value ("approve_order" -> "approveorder"). */
function normalizePermission(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Breadth-first search over the module's transition effects: finds a sequence of actions, starting
 * from one with no precondition on this entity, that ends with the entity in one of `target`'s
 * required status values. Returns null (not an empty array) when no such chain exists.
 */
export function findSetupChain(actions: FlowSpecAction[], target: FlowSpecAction): FlowSpecAction[] | null {
  const precondition = target.preconditions.find((entry) => entry.entity && entry.values.length);
  if (!precondition) return null;
  const entity = precondition.entity;
  const wanted = new Set(precondition.values);

  interface Node { action: FlowSpecAction; status: string; chain: FlowSpecAction[] }
  let frontier: Node[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (action.preconditions.some((entry) => entry.entity === entity)) continue; // this entity already needs a prior state - not a starting point
    for (const effect of action.effects) {
      if (effect.kind === "transition" && effect.entity === entity && effect.to) {
        frontier.push({ action, status: effect.to, chain: [action] });
        seen.add(action.id);
      }
    }
  }

  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    for (const node of frontier) if (wanted.has(node.status)) return node.chain;
    const next: Node[] = [];
    for (const node of frontier) {
      for (const action of actions) {
        if (seen.has(action.id)) continue;
        if (!action.preconditions.some((entry) => entry.entity === entity && entry.values.includes(node.status))) continue;
        for (const effect of action.effects) {
          if (effect.kind === "transition" && effect.entity === entity && effect.to) {
            seen.add(action.id);
            next.push({ action, status: effect.to, chain: [...node.chain, action] });
          }
        }
      }
    }
    frontier = next;
  }
  return null;
}

function setupFor(moduleActions: FlowSpecAction[], action: FlowSpecAction): SetupRecipe {
  if (!action.preconditions.some((entry) => entry.entity && entry.values.length)) return { strategy: "none" };
  const chain = findSetupChain(moduleActions, action);
  return chain ? { strategy: "chain", chain } : { strategy: "existing" };
}

/** Deterministic scenario planning over already-anchored specs. Never calls the model. */
export function isNavigationOnly(action: FlowSpecAction): boolean {
  return !action.form.length
    && !action.calls.some((call) => call.method.toUpperCase() !== "GET")
    && action.effects.every((effect) => effect.kind === "navigate");
}

export function planScenarios(modules: ModuleSpec[], options: PlannerOptions = {}): PlannerResult {
  const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const existingKeys = options.existingScenarioKeys ?? new Set<string>();
  const knownPermissions = options.knownPermissions === undefined ? null : options.knownPermissions;
  const maxValidationBoundary = options.maxValidationBoundary ?? DEFAULT_MAX_VALIDATION_BOUNDARY;

  const byCategory: Record<ScenarioCategory, PlannedScenario[]> = { HAPPY_PATH: [], VALIDATION: [], BOUNDARY: [], NEGATIVE: [], STATE: [], PERMISSION: [] };
  const skipped: PlannerSkip[] = [];
  const seenKeys = new Set(existingKeys);

  const plan = (scenario: Omit<PlannedScenario, "estimatedTokens">) => {
    if (seenKeys.has(scenario.scenarioKey)) return;
    seenKeys.add(scenario.scenarioKey);
    byCategory[scenario.category].push({ ...scenario, estimatedTokens: SCENARIO_TOKEN_COST });
  };
  const skip = (scenarioKey: string, reason: string) => {
    if (seenKeys.has(scenarioKey)) return;
    seenKeys.add(scenarioKey);
    skipped.push({ scenarioKey, reason });
  };

  for (const { moduleKey, spec } of modules) {
    const actions = spec.actions;
    for (const action of actions) {
      const base = `${moduleKey}:${action.id}`;

      // Verification runs on an already-authenticated session with the environment's one login:
      // driving the login form again can only fail-lock that account ("Too many login attempts")
      // or assert static sign-in copy - never something this run can safely verify.
      if (isAuthRoute(action.trigger.route)) { skip(`${base}:HAPPY_PATH`, "auth flow (session is pre-authenticated)"); continue; }

      // PERMISSION gates every other category for this action: a known-missing permission means
      // only the "trigger is hidden" scenario is meaningful; every other scenario would exercise an
      // action the current user cannot even reach.
      if (action.permission && knownPermissions) {
        const held = [...knownPermissions].some((value) => normalizePermission(value) === normalizePermission(action.permission!.value));
        if (!held) {
          plan({ scenarioKey: `${base}:PERMISSION:${action.permission.value}`, moduleKey, actionId: action.id, action, category: "PERMISSION", variantId: action.permission.value, description: `${action.name}: trigger is hidden without permission ${action.permission.value}`, setup: setupFor(actions, action) });
          for (const category of ["HAPPY_PATH", "VALIDATION", "BOUNDARY", "NEGATIVE", "STATE"] as const) skip(`${base}:${category}`, "needs another role");
          continue;
        }
      }

      // An action that changes nothing (no form, no write call, no effect beyond navigating) can only
      // yield "page shows X" / "link goes to Y" tests - the low-value kind this planner exists to replace.
      if (isNavigationOnly(action)) { skip(`${base}:HAPPY_PATH`, "navigation-only"); continue; }

      plan({ scenarioKey: `${base}:HAPPY_PATH`, moduleKey, actionId: action.id, action, category: "HAPPY_PATH", description: `${action.name}: happy path`, setup: setupFor(actions, action) });

      const seenMessages = new Set<string>();
      for (const field of action.form) {
        for (const rule of field.rules) {
          // The same message cited from client and server layers (or twice by the model) is one scenario.
          if (!rule.message || seenMessages.has(`${field.name}|${rule.message}`)) continue;
          seenMessages.add(`${field.name}|${rule.message}`);
          const category: ScenarioCategory = rule.kind === "min" || rule.kind === "max" ? "BOUNDARY" : "VALIDATION";
          plan({ scenarioKey: `${base}:${category}:${rule.id}`, moduleKey, actionId: action.id, action, category, variantId: rule.id, description: `${action.name}: ${field.label} ${rule.kind} - "${rule.message}"`, setup: setupFor(actions, action) });
        }
      }

      for (const rule of action.backendRules) {
        if (!rule.reproducibleViaUi || !rule.message || seenMessages.has(`backend|${rule.message}`)) continue;
        seenMessages.add(`backend|${rule.message}`);
        plan({ scenarioKey: `${base}:NEGATIVE:${rule.id}`, moduleKey, actionId: action.id, action, category: "NEGATIVE", variantId: rule.id, description: `${action.name}: backend rule - "${rule.message}"`, setup: setupFor(actions, action) });
      }

      for (const precondition of action.preconditions) {
        if (!precondition.entity || !precondition.values.length) continue;
        // A permission name reported as an entity "state" is the permission check again, not a state.
        if (action.permission && precondition.values.some((value) => normalizePermission(value) === normalizePermission(action.permission!.value))) continue;
        const variantId = `${precondition.kind}-${precondition.entity}`;
        plan({ scenarioKey: `${base}:STATE:${variantId}`, moduleKey, actionId: action.id, action, category: "STATE", variantId, description: `${action.name}: trigger hidden unless ${precondition.entity} is ${precondition.values.join("/")}`, setup: setupFor(actions, action) });
      }
    }
  }

  // Cap VALIDATION+BOUNDARY combined per action (one form's rules), before ordering/budgeting: a
  // global cap let the first few actions' rules crowd out every other form in the app.
  const validationBoundary = [...byCategory.VALIDATION, ...byCategory.BOUNDARY];
  const perAction = new Map<string, number>();
  const keptValidationBoundary: PlannedScenario[] = [];
  for (const scenario of validationBoundary) {
    const actionKey = `${scenario.moduleKey}:${scenario.actionId}`;
    const count = perAction.get(actionKey) ?? 0;
    perAction.set(actionKey, count + 1);
    // Not routed through skip() for the same reason as the budget cutoff below: these keys are
    // already in seenKeys from their own plan() call.
    if (count < maxValidationBoundary) keptValidationBoundary.push(scenario);
    else skipped.push({ scenarioKey: scenario.scenarioKey, reason: "validation/boundary cap reached" });
  }
  byCategory.VALIDATION = keptValidationBoundary.filter((scenario) => scenario.category === "VALIDATION");
  byCategory.BOUNDARY = keptValidationBoundary.filter((scenario) => scenario.category === "BOUNDARY");

  // Happy paths round-robin across modules (one per module per round), then STATE, NEGATIVE, VALIDATION, BOUNDARY, PERMISSION.
  const happyByModule = new Map<string, PlannedScenario[]>();
  for (const scenario of byCategory.HAPPY_PATH) happyByModule.set(scenario.moduleKey, [...(happyByModule.get(scenario.moduleKey) ?? []), scenario]);
  const happyRoundRobin: PlannedScenario[] = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const list of happyByModule.values()) {
      const next = list.shift();
      if (next) { happyRoundRobin.push(next); remaining = true; }
    }
  }

  const ordered = [...happyRoundRobin, ...byCategory.STATE, ...byCategory.NEGATIVE, ...byCategory.VALIDATION, ...byCategory.BOUNDARY, ...byCategory.PERMISSION];
  // Not routed through skip(): every item in `ordered` was already added to seenKeys by plan()
  // itself, so skip()'s own dedup check would (correctly, for its purpose) treat these as
  // duplicates and silently drop the budget reason. Nothing here can collide with an existing key.
  let spent = 0;
  const scenarios: PlannedScenario[] = [];
  for (const scenario of ordered) {
    if (spent + scenario.estimatedTokens > budgetTokens) { skipped.push({ scenarioKey: scenario.scenarioKey, reason: "budget" }); continue; }
    spent += scenario.estimatedTokens;
    scenarios.push(scenario);
  }

  return { scenarios, skipped };
}
