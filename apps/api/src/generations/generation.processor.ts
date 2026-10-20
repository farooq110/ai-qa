import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";
import { PrismaService } from "../database/prisma.service";
import { GENERATIONS_QUEUE, redisConnection } from "../common/queue";
import { GenerationsService } from "./generations.service";

/** Runs queued generation + repair jobs inside the API process (it already owns grounding, billing and provider config). */
@Injectable()
export class GenerationProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GenerationProcessor.name);
  private worker?: Worker;

  constructor(private readonly generations: GenerationsService, private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // A run whose API-side stage (drafting) was cut by the restart died with the previous process. Later
    // stages survive it: verification runs in apps/workers, and repair / wave-B jobs are redelivered by
    // BullMQ once their lock expires - failing those here would kill healthy runs on every API restart.
    const survives = new Set(["verifying", "repairing", "generating-wave-b"]);
    const running = await this.prisma.generationRun.findMany({ where: { status: "RUNNING" }, select: { id: true, report: true } });
    const dead = running.filter((run) => !survives.has(String((run.report as { stage?: string } | null)?.stage)));
    if (dead.length) await this.prisma.generationRun.updateMany({ where: { id: { in: dead.map((run) => run.id) } }, data: { status: "FAILED", errorMessage: "Generation was interrupted by a server restart. Generate again.", completedAt: new Date() } });
    this.worker = new Worker(
      GENERATIONS_QUEUE,
      async (job) => {
        if (job.name === "generate") return this.generations.runGeneration(job.data.runId as string);
        if (job.name === "repair") return this.generations.runRepair(job.data.runId as string);
        if (job.name === "generate-spec") return this.generations.runSpecGeneration(job.data.runId as string);
        if (job.name === "generate-spec-wave-b") return this.generations.runSpecWaveB(job.data.runId as string);
      },
      { connection: redisConnection(), concurrency: 2 }
    );
    this.worker.on("failed", (job, error) => this.logger.warn(`Generation job ${job?.name} ${job?.data?.runId} failed: ${error.message}`));
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
