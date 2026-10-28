export type TestAction = "navigate" | "click" | "fill" | "upload" | "select" | "assert" | "waitFor" | "screenshot" | "wait" | "assertColor" | "assertData" | "assertResponse" | "capture";

export interface StepRegion { x: number; y: number; w: number; h: number }

export interface TestStep {
  action: TestAction;
  target: string;
  value?: string;
  condition?: "visible" | "hidden" | "equals" | "contains" | "urlMatches" | "visual";
  /** Percent region (0-100) of the target canvas for assertColor. */
  region?: StepRegion;
  /** Per-channel tolerance for assertColor canvas sampling (default 35 — lighting headroom). */
  tolerance?: number;
  /** Visible text of one record (a table row, card or list item): the click lands on `target` inside the row showing it, not on the first match on the page. */
  within?: string;
  /** ARIA role recorded during verification: when set, the runner looks up this step's target by role+name only, never the fuzzy stages. */
  role?: string;
  /** Marks the step the test exists to prove: the dry run's mutation check removes exactly these steps and the test must then fail. */
  key?: boolean;
}

export interface TestDefinition {
  /** Browser session the test needs. Omitted: inferred (auth routes and {{username}}/{{password}} steps run anonymous). */
  session?: "anonymous" | "authenticated";
  title: string;
  capability: string;
  category: "HAPPY_PATH" | "NEGATIVE" | "BOUNDARY" | "VALIDATION" | "PERMISSION" | "ERROR" | "STATE" | "INTEGRATION";
  preconditions: string[];
  steps: TestStep[];
  expectedResult: string;
  tags: string[];
}

export function validateTestDefinition(value: unknown): asserts value is TestDefinition {
  if (!value || typeof value !== "object") throw new Error("Test definition must be an object");
  const test = value as Partial<TestDefinition>;
  if (!test.title || !test.capability || !test.expectedResult) throw new Error("Test definition requires title, capability, and expectedResult");
  if (!Array.isArray(test.steps) || test.steps.length === 0) throw new Error("Test definition requires at least one step");
  for (const step of test.steps) {
    if (!step?.action || !step.target) throw new Error("Every test step requires action and target");
  }
}
// Segments that are public pages wherever they appear in the path.
// An optional "<who>-" prefix covers per-audience login pages: "customer-login", "admin-sign-in".
const STRONG_AUTH_SEGMENT = /^(?:[a-z0-9]+-)?(?:log-?in|sign-?in|sign-?on|sign-?up|forgot-?password|reset-?password|password-?reset|verify-?email|confirm-?email|accept-?invite)$/i;
// Ambiguous words: public as the FIRST segment (/invite/:token, /auth/callback) but often admin pages deeper (/team/invite, /settings/sso).
const WEAK_AUTH_SEGMENT = /^(?:register|verify|activate|invite|auth|sso)$/i;

/** Pages a logged-in user is sent away from: /login, /forgot-password, /reset-password/:token, /auth/callback ... */
export function isAuthRoute(urlOrPath: string): boolean {
  const segments = urlOrPath.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0].split("/").filter(Boolean);
  return segments.some((segment) => STRONG_AUTH_SEGMENT.test(segment)) || (segments.length > 0 && WEAK_AUTH_SEGMENT.test(segments[0]));
}

/** Test must start from a clean, logged-out browser: opens an auth route or signs in with the saved credentials. */
export function needsAnonymousSession(definition: Pick<TestDefinition, "session" | "steps">): boolean {
  if (definition.session) return definition.session === "anonymous";
  const first = definition.steps.find((step) => step.action === "navigate")?.target ?? "";
  const usesCredentials = definition.steps.some((step) => /\{\{\s*(username|password)\s*\}\}/i.test(`${step.target} ${step.value ?? ""}`));
  return isAuthRoute(first) || usesCredentials;
}

export * from "./api-response";
export * from "./text-diff";
export * from "./host-limiter";
export * from "./session";
export * from "./fixtures";
