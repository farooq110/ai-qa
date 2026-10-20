/**
 * Reusable eval harness for the test-generation pipeline. Runs real TestCase rows against a
 * project's environment through the actual worker code path (openRunSession/runTestCase/executeStep -
 * never a reimplementation), and reports the metrics every later phase is judged against:
 * first-run pass rate, re-run stability, mutation-kill rate, loose-match rate, distinct-scenario
 * count, and token cost. Replaces eval-stage0.ts and eval-session-reuse.ts (deleted).
 *
 * Usage:
 *   pnpm exec tsx --env-file=../../.env src/eval.ts --project <id> \
 *     [--generation <generationRunId>] [--status PENDING_REVIEW,APPROVED] \
 *     [--repeat 2] [--shuffle] [--json out.json] [--audit labels.json]
 *
 * --generation filters by the GenerationRun's targetCommit against TestCase.generatedFromCommit -
 * TestCase has no generationRunId column yet (that lands in Phase 1); this is the honest proxy
 * available today, and should be swapped for a direct id match once that column exists.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import type { TestDefinition } from "@ai-qa/test-dsl";
import { openRunSession, substituteVariables, runTestCase } from "./worker";
import { ASSERT_LIKE, INTERACTIVE, removeKeyAction } from "./step-helpers";

interface Args {
  project: string;
  generation?: string;
  status: string[];
  repeat: number;
  shuffle: boolean;
  json?: string;
  audit?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const project = get("--project");
  if (!project) throw new Error("usage: eval.ts --project <id> [--generation <id>] [--status a,b] [--repeat N] [--shuffle] [--json out.json] [--audit labels.json]");
  return {
    project,
    generation: get("--generation"),
    status: (get("--status") ?? "PENDING_REVIEW,APPROVED").split(",").map((s) => s.trim()).filter(Boolean),
    repeat: Number(get("--repeat") ?? 1) || 1,
    shuffle: argv.includes("--shuffle"),
    json: get("--json"),
    audit: get("--audit")
  };
}

/** Removes the step under test: the one marked `key: true` (Phase 1c), else the last interactive step. Null when there is nothing to mutate. */
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Route + first interactive target + category stands in for a real scenarioKey (Phase 5) on legacy tests. */
function scenarioProxy(def: TestDefinition, route: string | null): string {
  const firstTarget = def.steps.find((step) => INTERACTIVE.has(step.action))?.target ?? "";
  return `${route ?? "?"}::${firstTarget}::${def.category}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const project = await prisma.project.findUniqueOrThrow({ where: { id: args.project } });
  const environment = await prisma.environmentProfile.findFirst({ where: { projectId: args.project }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  if (!environment?.url) throw new Error(`project ${args.project} has no environment with a URL`);

  const analysis = await prisma.analysisRun.findFirst({ where: { projectId: args.project, status: "COMPLETED" }, orderBy: { completedAt: "desc" } });

  let generatedFromCommit: string | undefined;
  if (args.generation) {
    const run = await prisma.generationRun.findUniqueOrThrow({ where: { id: args.generation } });
    generatedFromCommit = run.targetCommit;
  }

  const tests = await prisma.testCase.findMany({
    where: { projectId: args.project, status: { in: args.status as never }, ...(generatedFromCommit ? { generatedFromCommit } : {}) },
    select: { id: true, title: true, route: true, category: true, confidence: true, definition: true }
  });
  const runnableTests = tests.filter((test) => (test.definition as unknown as TestDefinition | null)?.steps?.length);
  console.log(`Project ${project.name} | env ${environment.url} | analysis ${analysis?.commitSha?.slice(0, 7) ?? "none"} | ${runnableTests.length} runnable test cases (of ${tests.length})`);

  const session = await openRunSession(args.project, environment.url);
  const { context, credentials, fixtureVars } = session;
  console.log(`Login: ${session.loginStatus}`);

  type Pass = Map<string, { status: "PASSED" | "FAILED"; error?: string; looseSteps: number; interactiveSteps: number }>;
  const passes: Pass[] = [];
  const startedAt = Date.now();

  for (let pass = 0; pass < args.repeat; pass++) {
    const order = args.shuffle ? shuffle(runnableTests) : runnableTests;
    const results: Pass = new Map();
    for (const test of order) {
      const def = test.definition as unknown as TestDefinition;
      const runnable = substituteVariables(def, credentials);
      const result = await runTestCase(context, runnable, "eval", test.id, environment.url, credentials, fixtureVars, false);
      const interactiveSteps = result.steps.filter((step) => INTERACTIVE.has(step.action));
      results.set(test.id, {
        status: result.status, error: result.error,
        interactiveSteps: interactiveSteps.length,
        looseSteps: interactiveSteps.filter((step) => step.loose).length
      });
    }
    passes.push(results);
    console.log(`Pass ${pass + 1}/${args.repeat}: ${[...results.values()].filter((r) => r.status === "PASSED").length}/${results.size} passed`);
  }

  const firstPass = passes[0];
  let mutTested = 0, mutKilled = 0, mutSurvived = 0, mutNotApplicable = 0, mutInconclusive = 0;
  const mutationDetails: Array<{ id: string; title: string; mutation: string }> = [];
  for (const test of runnableTests) {
    const first = firstPass.get(test.id);
    if (first?.status !== "PASSED") continue;
    const def = test.definition as unknown as TestDefinition;
    const mutated = removeKeyAction(def);
    if (!mutated) { mutNotApplicable += 1; continue; }
    const runnableMut = substituteVariables(mutated, credentials);
    const mut = await runTestCase(context, runnableMut, "eval", test.id, environment.url, credentials, fixtureVars, false);
    mutTested += 1;
    if (mut.status === "PASSED") { mutSurvived += 1; mutationDetails.push({ id: test.id, title: test.title, mutation: "survived" }); continue; }
    const failedAction = mut.steps.at(-1)?.action ?? "";
    if (ASSERT_LIKE.has(failedAction)) { mutKilled += 1; mutationDetails.push({ id: test.id, title: test.title, mutation: "killed" }); }
    else { mutInconclusive += 1; mutationDetails.push({ id: test.id, title: test.title, mutation: "inconclusive" }); }
  }

  await session.close();

  const firstPassedIds = new Set([...firstPass].filter(([, r]) => r.status === "PASSED").map(([id]) => id));
  const stableInEveryPass = [...firstPassedIds].filter((id) => passes.every((pass) => pass.get(id)?.status === "PASSED"));
  const stability = args.repeat > 1 && firstPassedIds.size ? stableInEveryPass.length / firstPassedIds.size : null;

  let looseSteps = 0, interactiveSteps = 0;
  for (const result of firstPass.values()) { looseSteps += result.looseSteps; interactiveSteps += result.interactiveSteps; }

  const scenarios = new Set(runnableTests.map((test) => scenarioProxy(test.definition as unknown as TestDefinition, test.route)));

  const usage = await prisma.aiUsageRecord.aggregate({
    where: args.generation ? { generationRunId: args.generation } : { projectId: args.project },
    _sum: { inputTokens: true, outputTokens: true }
  });

  let auditAgreement: number | null = null;
  if (args.audit) {
    const labels = JSON.parse(readFileSync(args.audit, "utf8")) as Record<string, "pass" | "fail">;
    const labelled = Object.entries(labels).filter(([id]) => firstPass.has(id));
    const agree = labelled.filter(([id, label]) => (firstPass.get(id)!.status === "PASSED") === (label === "pass"));
    auditAgreement = labelled.length ? agree.length / labelled.length : null;
  }

  const report = {
    project: { id: args.project, name: project.name },
    environment: environment.url,
    analysisCommit: analysis?.commitSha ?? null,
    generationRunId: args.generation ?? null,
    testCounts: { total: tests.length, runnable: runnableTests.length },
    firstRunPassRate: firstPassedIds.size / (runnableTests.length || 1),
    firstRunPassed: firstPassedIds.size,
    repeat: args.repeat,
    stability,
    mutation: { tested: mutTested, killed: mutKilled, survived: mutSurvived, inconclusive: mutInconclusive, notApplicable: mutNotApplicable, killRate: mutTested ? mutKilled / mutTested : null, details: mutationDetails },
    looseMatchRate: interactiveSteps ? looseSteps / interactiveSteps : null,
    distinctScenarios: scenarios.size,
    tokens: { input: usage._sum.inputTokens ?? 0, output: usage._sum.outputTokens ?? 0 },
    auditAgreement,
    wallTimeMs: Date.now() - startedAt
  };

  console.log("\n--- Eval report ---");
  console.log(JSON.stringify(report, null, 2));
  if (args.json) { writeFileSync(args.json, JSON.stringify(report, null, 2)); console.log(`\nWritten to ${args.json}`); }

  await prisma.$disconnect();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
