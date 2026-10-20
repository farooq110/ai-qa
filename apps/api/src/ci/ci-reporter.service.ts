import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";
import { PrismaService } from "../database/prisma.service";
import { CI_REPORTS_QUEUE, redisConnection } from "../common/queue";
import { CiService } from "./ci.service";
import { postReport, type ReportState } from "./provider-api";

const webUrl = () => (process.env.WEB_APP_URL ?? "http://localhost:3004").replace(/\/$/, "");
const runStatus: Record<ReportState, string> = { queued: "QUEUED", running: "RUNNING", passed: "PASSED", failed: "FAILED", canceled: "CANCELED", skipped: "SKIPPED" };

/**
 * Consumes `ci-reports` jobs (from the API on queue/skip/supersede and from the worker on start/finish)
 * and mirrors the run's *current* database state onto the commit. Reading current state — not the job's
 * payload — makes out-of-order or retried jobs harmless.
 */
@Injectable()
export class CiReporterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CiReporterService.name);
  private worker: Worker | null = null;

  constructor(private readonly prisma: PrismaService, private readonly ci: CiService) {}

  onModuleInit() {
    // ponytail: concurrency 1 keeps two jobs from creating duplicate GitHub check runs for one run; shard by run id if report volume grows.
    this.worker = new Worker(CI_REPORTS_QUEUE, (job) => this.report(job.data as { ciRunId?: string; planId?: string }), { connection: redisConnection(), concurrency: 1 });
    this.worker.on("failed", (job, error) => this.logger.warn(`CI report ${job?.id} failed: ${error.message}`));
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  async report(target: { ciRunId?: string; planId?: string }) {
    const run = await this.prisma.ciRun.findFirst({
      where: target.ciRunId ? { id: target.ciRunId } : { executionPlanId: target.planId ?? "-" },
      include: { project: true, executionPlan: { select: { id: true, status: true, items: { select: { status: true } } } } }
    });
    if (!run) return;
    const { state, description } = describe(run);
    if (run.status !== runStatus[state]) await this.prisma.ciRun.update({ where: { id: run.id }, data: { status: runStatus[state] } });

    let access;
    try {
      access = await this.ci.access(run.project);
    } catch (error) {
      // Connection removed or app uninstalled: nothing can be posted, and retrying will not change that.
      if (error instanceof NotFoundException) return;
      throw error;
    }
    const checkId = await postReport(access, {
      state, description, commitSha: run.commitSha, checkId: run.externalCheckId, externalId: run.id,
      name: `Proofline · ${run.project.name}`, key: `proofline-${run.projectId}`,
      detailsUrl: run.executionPlan ? `${webUrl()}/executions?plan=${run.executionPlan.id}&project=${run.projectId}` : `${webUrl()}/ci-cd?project=${run.projectId}`
    });
    if (checkId && checkId !== run.externalCheckId) await this.prisma.ciRun.update({ where: { id: run.id }, data: { externalCheckId: checkId } });
  }
}

function describe(run: { status: string; reason: string | null; executionPlan: { status: string; items: Array<{ status: string }> } | null }): { state: ReportState; description: string } {
  if (run.status === "SKIPPED") return { state: "skipped", description: `Skipped: ${run.reason ?? "not run"}` };
  if (run.status === "CANCELED") return { state: "canceled", description: run.reason ?? "Canceled" };
  const plan = run.executionPlan;
  if (!plan) return { state: "queued", description: "Queued" };
  const total = plan.items.length;
  const failed = plan.items.filter((item) => item.status === "FAILED").length;
  const done = plan.items.filter((item) => !["QUEUED", "RUNNING"].includes(item.status)).length;
  switch (plan.status) {
    case "QUEUED": return { state: "queued", description: `${total} tests queued, waiting for a test slot` };
    case "RUNNING": return { state: "running", description: `Running ${done}/${total} tests${failed ? `, ${failed} failed so far` : ""}` };
    case "PASSED": return { state: "passed", description: `All ${total} tests passed` };
    case "FAILED": return { state: "failed", description: `${failed} of ${total} tests failed` };
    case "BLOCKED": return { state: "skipped", description: "Skipped: billing is locked" };
    default: return { state: "canceled", description: "Canceled" };
  }
}
