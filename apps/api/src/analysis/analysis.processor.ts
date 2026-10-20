import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";
import { PrismaService } from "../database/prisma.service";
import { ANALYSIS_QUEUE, redisConnection } from "../common/queue";
import { AnalysisService } from "./analysis.service";

/** Runs queued analyses inside the API process (it already owns Playwright and repository access). One at a time. */
@Injectable()
export class AnalysisProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalysisProcessor.name);
  private worker?: Worker;

  constructor(private readonly analysis: AnalysisService, private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // A run still RUNNING at startup died with the previous process.
    await this.prisma.analysisRun.updateMany({ where: { status: "RUNNING" }, data: { status: "FAILED", errorMessage: "Analysis was interrupted by a server restart. Run it again.", completedAt: new Date() } });
    this.worker = new Worker(ANALYSIS_QUEUE, async (job) => this.analysis.execute(job.data.analysisId as string), { connection: redisConnection(), concurrency: 1 });
    this.worker.on("failed", (job, error) => this.logger.warn(`Analysis ${job?.data?.analysisId} failed: ${error.message}`));
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
