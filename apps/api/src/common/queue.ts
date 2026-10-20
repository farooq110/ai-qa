import { Queue } from "bullmq";
import IORedis from "ioredis";

let connectionInstance: IORedis | null = null;
const queues = new Map<string, Queue>();

export function redisConnection(): IORedis {
  connectionInstance ??= new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", { maxRetriesPerRequest: null });
  return connectionInstance;
}

function queue(name: string): Queue {
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection: redisConnection() }));
  return queues.get(name)!;
}

export const executionQueue = () => queue("executions");

export async function enqueueExecution(planId: string) {
  await executionQueue().add("execute-plan", { planId }, { jobId: `plan-${planId}`, removeOnComplete: 200, removeOnFail: 200 });
}

/** Posts a CI run's current state back to its provider (GitHub check / GitLab + Bitbucket commit status). */
export const CI_REPORTS_QUEUE = "ci-reports";

export async function enqueueCiReport(target: { ciRunId: string } | { planId: string }) {
  await queue(CI_REPORTS_QUEUE).add("report", target, { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 500, removeOnFail: 500 });
}

/** Repository analysis (code read + live crawl) runs in the background; the UI polls the run. */
export const ANALYSIS_QUEUE = "analysis";

export async function enqueueAnalysis(analysisId: string) {
  await queue(ANALYSIS_QUEUE).add("analyze", { analysisId }, { jobId: `analysis-${analysisId}`, removeOnComplete: 100, removeOnFail: 100 });
}

/** Candidate generation (LLM drafting + grounding) runs in the background; the UI polls the run. Consumed by the API itself. */
export const GENERATIONS_QUEUE = "generations";

export async function enqueueGeneration(runId: string) {
  await queue(GENERATIONS_QUEUE).add("generate", { runId }, { jobId: `generation-${runId}`, removeOnComplete: 100, removeOnFail: 100 });
}

export async function enqueueRepair(runId: string) {
  await queue(GENERATIONS_QUEUE).add("repair", { runId }, { jobId: `repair-${runId}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 100 });
}

/** Phase 5: spec-grounded generation, planned from FlowSpecs instead of the legacy crawl-only path. */
export async function enqueueSpecGeneration(runId: string) {
  await queue(GENERATIONS_QUEUE).add("generate-spec", { runId }, { jobId: `generation-spec-${runId}`, removeOnComplete: 100, removeOnFail: 100 });
}

/** Wave B starts once wave A's setup-chain happy paths have verified (or failed, in which case their scenarios fall back to the "existing" strategy). */
export async function enqueueSpecWaveB(runId: string) {
  await queue(GENERATIONS_QUEUE).add("generate-spec-wave-b", { runId }, { jobId: `generation-spec-waveb-${runId}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 100 });
}

/** Dry-run verification (run the candidate, mutate, judge) happens on the real app; consumed by apps/workers. */
export const VERIFICATIONS_QUEUE = "verifications";

export async function enqueueVerification(runId: string, round: 1 | 2) {
  await queue(VERIFICATIONS_QUEUE).add("verify", { runId, round }, { jobId: `verify-${runId}-${round}`, removeOnComplete: 100, removeOnFail: 100 });
}
