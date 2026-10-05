import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { subscriptionContext } from "../common/billing-context";

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async projectOverview(user: AuthenticatedUser, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const [context, tests, lastAnalysis, executions, generationRuns] = await Promise.all([
      subscriptionContext(this.prisma, user.organizationId),
      this.prisma.testCase.groupBy({ by: ["status"], _count: { status: true }, where: { projectId } }),
      this.prisma.analysisRun.findFirst({ where: { projectId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } }),
      this.prisma.executionPlan.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 5, include: { items: { select: { status: true } } } }),
      this.prisma.generationRun.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" } })
    ]);

    const statusCounts: Record<string, number> = {};
    for (const entry of tests) statusCounts[entry.status] = entry._count.status;
    const approved = statusCounts["APPROVED"] ?? 0;
    const pendingReview = statusCounts["PENDING_REVIEW"] ?? 0;
    const total = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);

    const lastRun = executions[0];
    const passed = lastRun?.items.filter((item) => item.status === "PASSED").length ?? 0;

    return {
      project: { id: project.id, name: project.name, repositoryUrl: project.repositoryUrl, defaultBranch: project.defaultBranch },
      analysis: lastAnalysis ? { id: lastAnalysis.id, branch: lastAnalysis.branch, commitSha: lastAnalysis.commitSha, completedAt: lastAnalysis.completedAt } : null,
      generation: generationRuns ? { id: generationRuns.id, mode: generationRuns.mode, status: generationRuns.status, createdAt: generationRuns.createdAt, created: generationRuns.created } : null,
      tests: { total, approved, pendingReview, needsReview: statusCounts["NEEDS_REVIEW"] ?? 0, rejected: statusCounts["REJECTED"] ?? 0, archived: statusCounts["ARCHIVED"] ?? 0 },
      lastExecution: lastRun ? { id: lastRun.id, status: lastRun.status, trigger: lastRun.trigger, branch: lastRun.branch, commitSha: lastRun.commitSha, total: lastRun.items.length, passed, createdAt: lastRun.createdAt } : null,
      executions: executions.map((plan) => ({ id: plan.id, status: plan.status, trigger: plan.trigger, branch: plan.branch, total: plan.items.length, passed: plan.items.filter((item) => item.status === "PASSED").length, failed: plan.items.filter((item) => item.status === "FAILED").length, createdAt: plan.createdAt })),
      billing: { planName: context.planName, status: context.status, usage: context.usage, tokenQuotaMonthly: context.tokenQuotaMonthly, remainingTokens: context.remainingTokens, warningThresholdPct: context.warningThresholdPct, executionSlotLimit: context.executionSlotLimit, billingLocked: context.billingLocked, currentPeriodEnd: context.currentPeriodEnd }
    };
  }
}
