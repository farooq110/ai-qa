/**
 * Dry-run verification: every DRAFT test case from a generation run is actually executed against
 * the live environment before a human ever sees it. A test that passes is then mutated (its key
 * action removed) - if it still passes, the assertion proved nothing and the test is held out
 * instead of silently reaching PENDING_REVIEW. Consumed from the "verifications" queue; round 1
 * runs right after generation, round 2 after a repair pass rewrites the survivors/failures.
 */
import { Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { TestDefinition } from "@ai-qa/test-dsl";
import { firstPage, openRunSession, runRecovering, runTestCase, substituteVariables } from "./worker";
import { ASSERT_LIKE, removeKeyAction } from "./step-helpers";
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 30_000;

const prisma = new PrismaClient();
// Produced into here, consumed by the API's GenerationProcessor - no cross-package import, same
// pattern worker.ts already uses for "ci-reports".
let generationsQueue: Queue | null = null;
function repairQueue(connection: unknown): Queue {
  generationsQueue ??= new Queue("generations", { connection: connection as never });
  return generationsQueue;
}

const ROLE_BY_MATCH: Record<string, string> = { "button role · exact": "button", "link role · exact": "link", "accessible name": "textbox", "option role": "option" };

type RunResult = Awaited<ReturnType<typeof runTestCase>>;
const attemptOf = (result: RunResult) => ({ status: result.status, error: result.error, failedStep: result.steps.at(-1)?.index ?? null, network: result.observations?.network ?? [], ariaAtFailure: result.observations?.ariaAtFailure });

export async function processVerification(runId: string, round: 1 | 2, connection: unknown): Promise<void> {
  try {
    await verifyRun(runId, round, connection);
  } catch (error) {
    // Never leave a run RUNNING behind a crashed job: it would hold the project's Generate lock.
    await prisma.generationRun.updateMany({ where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", completedAt: new Date(), errorMessage: `Verification crashed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) } });
    throw error;
  }
}

async function verifyRun(runId: string, round: 1 | 2, connection: unknown): Promise<void> {
  const run = await prisma.generationRun.findUniqueOrThrow({ where: { id: runId }, include: { project: true } });
  if (run.status === "FAILED" || run.status === "COMPLETED") return; // a redelivered job for a run that already ended
  const { projectId } = run;
  const environment = await prisma.environmentProfile.findFirst({ where: { projectId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  if (!environment?.url) { await prisma.generationRun.update({ where: { id: runId }, data: { status: "FAILED", completedAt: new Date(), errorMessage: "No environment configured to verify against" } }); return; }

  const drafts = await prisma.testCase.findMany({ where: { projectId, generationRunId: runId, status: "DRAFT" }, select: { id: true, title: true, definition: true } });
  if (!drafts.length) { await prisma.generationRun.update({ where: { id: runId }, data: { status: "COMPLETED", completedAt: new Date() } }); return; }

  const session = await openRunSession(projectId, environment.url);
  const { keeper, limiter, credentials, fixtureVars } = session;
  // Without a session every test fails on the login screen, and repair would rewrite real asserts
  // into whatever the login page shows - fail the run instead of judging tests against it.
  if (session.loginStatus === "failed") {
    await session.close();
    await prisma.testCase.updateMany({ where: { projectId, generationRunId: runId, status: "DRAFT" }, data: { status: "NEEDS_REVIEW", verification: { round, outcome: "session-lost", reason: "login to the environment failed, so this test was never verified" } as never } });
    await prisma.generationRun.update({ where: { id: runId }, data: { status: "FAILED", completedAt: new Date(), errorMessage: "Verification could not log in to the environment - check the login credentials, URL and trigger in Settings" } });
    return;
  }

  /**
   * One judged run: waits out the app's rate-limit window, retries a rate-limited failure, and recovers
   * a session that died mid-run. Every run (the test itself and its mutation) goes through here, so a
   * session dying during the mutation can never read as "the mutation failed", i.e. a false pass.
   */
  const judge = async (testId: string, def: TestDefinition) => {
    const runnable = substituteVariables(def, credentials);
    const attempts: Array<ReturnType<typeof attemptOf>> = [];
    const once = async () => {
      await limiter.waitUntilReady();
      const result = await runTestCase(session.context, runnable, runId, testId, environment.url!, credentials, fixtureVars, false, { strict: true, observe: true });
      attempts.push(attemptOf(result));
      return result;
    };
    const probe = firstPage(def);
    let { result, sessionLost } = await runRecovering(keeper, once, probe);
    for (let retries = 0; !sessionLost && result.status === "FAILED" && result.observations?.rateLimited && retries < MAX_RATE_LIMIT_RETRIES; retries++) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
      ({ result, sessionLost } = await runRecovering(keeper, once, probe));
    }
    return { result, sessionLost, attempts };
  };

  // Every outcome but "verified" leaves round-1 failures as DRAFT for repair (persisting why, which
  // repair's prompt reads); round 2, session loss and rate limiting are final and hold the test out.
  const holdOut = async (testId: string, verification: Record<string, unknown>, final: boolean) => {
    await prisma.testCase.update({ where: { id: testId }, data: { ...(final ? { status: "NEEDS_REVIEW" as const } : {}), verification: { round, ...verification } as never } });
    if (final) heldOut += 1;
  };

  let verified = 0, heldOut = 0;
  for (const test of drafts) {
    const def = test.definition as unknown as TestDefinition;
    if (!def?.steps?.length) { await holdOut(test.id, { outcome: "failed", reason: "no executable steps" }, true); continue; }

    const { result: first, sessionLost, attempts } = await judge(test.id, def);
    // Never judged (the session is gone): never hand it to repair, which would "fix" asserts against the login page.
    if (sessionLost) { await holdOut(test.id, { outcome: "session-lost", reason: first.error, attempts }, true); continue; }
    if (first.status === "FAILED" && first.observations?.rateLimited) { await holdOut(test.id, { outcome: "rate-limited", reason: "the app rate-limited verification after retries", attempts }, true); continue; }
    if (first.status === "FAILED") { await holdOut(test.id, { outcome: "failed", reason: first.error, attempts }, round === 2); continue; }

    // Passed: hold it to the mutation check before trusting it.
    const mutated = removeKeyAction(def);
    let mutation: { removed: number; status: string; error?: string } = { removed: 0, status: "n/a" };
    if (mutated) {
      const { result: mut, sessionLost: mutationSessionLost } = await judge(test.id, mutated);
      if (mutationSessionLost) { await holdOut(test.id, { outcome: "session-lost", reason: `mutation check: ${mut.error}`, attempts }, true); continue; }
      const removed = def.steps.length - mutated.steps.length;
      mutation = mut.status === "PASSED" ? { removed, status: "survived" } : { removed, status: ASSERT_LIKE.has(mut.steps.at(-1)?.action ?? "") ? "killed" : "inconclusive", error: mut.error };
    }
    if (mutation.status === "survived") { await holdOut(test.id, { outcome: "mutation-survived", reason: "the assertion still passes with the key action removed", attempts, mutation }, round === 2); continue; }

    // Verified. Record which role/name each step actually resolved to, so a future run can skip the fuzzy chain entirely.
    const withRoles: TestDefinition = {
      ...def,
      steps: def.steps.map((step, index) => {
        const role = first.steps[index]?.matchedBy ? ROLE_BY_MATCH[first.steps[index].matchedBy!] : undefined;
        return role ? { ...step, role } : step;
      })
    };
    const confidence = mutation.status === "killed" && round === 1 ? 0.95 : mutation.status === "killed" ? 0.85 : 0.7; // n/a (nothing to mutate) or inconclusive
    await prisma.testCase.update({ where: { id: test.id }, data: { status: "PENDING_REVIEW", confidence, definition: withRoles as never, verification: { round, outcome: round === 2 ? "repaired" : "verified", reason: null, attempts, mutation } as never } });
    await prisma.testCaseVersion.upsert({
      where: { testCaseId_version: { testCaseId: test.id, version: 2 } },
      create: { testCaseId: test.id, version: 2, title: test.title, definition: withRoles as never, note: "Verified locators recorded by dry-run verification" },
      update: { definition: withRoles as never }
    });
    verified += 1;
  }

  await session.close();

  const stillDraft = await prisma.testCase.count({ where: { projectId, generationRunId: runId, status: "DRAFT" } });
  const current = await prisma.generationRun.findUnique({ where: { id: runId } });
  if (!current || current.status === "FAILED") return; // failed meanwhile (e.g. the API marked it): do not resurrect it
  const reportSoFar = (current.report as { wave?: string; verified?: number; heldOut?: number } | null) ?? {};
  // Wave A (the setup-chain happy paths) hands off to wave B once it settles, instead of completing.
  const startWaveB = (!stillDraft || round === 2) && reportSoFar.wave === "A";
  const continues = startWaveB || (stillDraft > 0 && round === 1);
  const report = { ...reportSoFar, stage: startWaveB ? "generating-wave-b" : continues ? "repairing" : "completed", verified: (reportSoFar.verified ?? 0) + verified, heldOut: (reportSoFar.heldOut ?? 0) + heldOut };
  await prisma.generationRun.update({ where: { id: runId }, data: { status: continues ? "RUNNING" : "COMPLETED", completedAt: continues ? null : new Date(), report: report as never } });

  if (stillDraft && round === 1) await repairQueue(connection).add("repair", { runId }, { jobId: `repair-${runId}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 100 });
  else if (startWaveB) await repairQueue(connection).add("generate-spec-wave-b", { runId }, { jobId: `generation-spec-waveb-${runId}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 100 });
}
