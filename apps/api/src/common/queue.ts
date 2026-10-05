import { Queue } from "bullmq";
import IORedis from "ioredis";

let executionQueueInstance: Queue | null = null;

export function executionQueue(): Queue {
  if (!executionQueueInstance) {
    const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", { maxRetriesPerRequest: null });
    executionQueueInstance = new Queue("executions", { connection });
  }
  return executionQueueInstance;
}

export async function enqueueExecution(planId: string) {
  await executionQueue().add("execute-plan", { planId }, { jobId: `plan-${planId}`, removeOnComplete: 200, removeOnFail: 200 });
}
