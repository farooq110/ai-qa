import type { Page } from "playwright";
import type { SessionKeeper, TestDefinition } from "@ai-qa/test-dsl";

export const INTERACTIVE = new Set(["click", "fill", "select", "upload"]);
export const ASSERT_LIKE = new Set(["assert", "waitFor", "assertResponse"]);

/** The mutation check's cut: the step(s) marked `key: true`, else the last interactive step. Null when there is nothing to mutate. */
export function removeKeyAction(def: TestDefinition): TestDefinition | null {
  const keyed = def.steps.filter((step) => step.key === true);
  if (keyed.length) return { ...def, steps: def.steps.filter((step) => !keyed.includes(step)) };
  for (let i = def.steps.length - 1; i >= 0; i--) {
    if (INTERACTIVE.has(def.steps[i].action)) return { ...def, steps: def.steps.filter((_, index) => index !== i) };
  }
  return null;
}

/**
 * "hidden" means the user cannot see it: removed from the DOM (React unmounts filtered-out rows) or
 * present but hidden by CSS. Matches the FULL text only - a substring match makes "Me" collide with
 * "Customer" and the assertion can never pass. Polls because a filter's re-render is asynchronous.
 */
export async function assertNotVisible(page: Page, target: string, timeoutMs: number): Promise<void> {
  const visible = page.getByText(target, { exact: true }).filter({ visible: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await visible.count();
    if (count === 0) return;
    if (Date.now() >= deadline) throw new Error(`Expected "${target}" to be gone, but ${count} visible element${count === 1 ? " is" : "s are"} still showing it`);
    await page.waitForTimeout(150);
  }
}

// Thrown by executeStep's navigate when the app sends a logged-in test to its login screen.
const SESSION_LOST = /showed a login screen/;

/** The page a test opens first: where "is the session still alive?" is asked when a 401 is the only evidence. */
export function firstPage(definition: TestDefinition): string | undefined {
  const target = definition.steps.find((step) => step.action === "navigate")?.target;
  return target && !target.includes("{{") ? target : undefined; // unresolved {{param}}: ask on the site root instead
}

/**
 * Run a test; when it failed the way a dead session fails (a login screen, or the app answering 401),
 * let the keeper confirm and recover the session, then run it once more. A 401 with the session still
 * alive is the test's own result (a permission check), not retried.
 */
export async function runRecovering<T extends { status: "PASSED" | "FAILED"; error?: string; unauthorized?: boolean }>(
  keeper: Pick<SessionKeeper, "recover">, run: () => Promise<T>, probeUrl?: string
): Promise<{ result: T; previous?: T; sessionLost: boolean }> {
  const first = await run();
  const loginScreen = SESSION_LOST.test(first.error ?? "");
  if (first.status === "PASSED" || !(loginScreen || first.unauthorized)) return { result: first, sessionLost: false };
  const recovered = await keeper.recover({ loginScreen, probeUrl });
  if (recovered === "alive") return { result: first, sessionLost: false };
  if (recovered === "lost") return { result: first, sessionLost: true };
  const second = await run();
  return { result: second, previous: first, sessionLost: second.status === "FAILED" && SESSION_LOST.test(second.error ?? "") };
}
