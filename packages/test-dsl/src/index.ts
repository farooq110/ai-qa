export type TestAction = "navigate" | "click" | "fill" | "upload" | "select" | "assert" | "waitFor" | "screenshot";

export interface TestStep {
  action: TestAction;
  target: string;
  value?: string;
  condition?: "visible" | "hidden" | "equals" | "contains" | "urlMatches" | "visual";
}

export interface TestDefinition {
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