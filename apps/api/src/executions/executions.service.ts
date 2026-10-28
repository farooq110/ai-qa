import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { recordAudit } from "../common/audit";
import { assertBillingActive, subscriptionContext } from "../common/billing-context";
import { enqueueCiReport, enqueueExecution } from "../common/queue";
import { PermissionsService } from "../rbac/permissions.service";
import { PERMISSIONS } from "@ai-qa/domain";

interface CreateExecutionInput {
  testCaseIds?: string[];
  branch?: string;
  commitSha?: string;
  environmentUrl?: string;
  environmentId?: string;
  trigger?: "DASHBOARD" | "CI" | "RERUN";
}

@Injectable()
export class ExecutionsService {
  constructor(private readonly prisma: PrismaService, private readonly permissions: PermissionsService) {}

  async create(user: AuthenticatedUser, projectId: string, input: CreateExecutionInput) {
    await this.permissions.assert(user, PERMISSIONS.EXECUTIONS_RUN);
    const project = await this.assertProject(user, projectId);
    const context = await subscriptionContext(this.prisma, user.organizationId);
    assertBillingActive(context, "Test execution");

    const environment = await this.resolveEnvironment(projectId, input);
    const selectedIds = [...new Set(input.testCaseIds ?? [])];
    if (!selectedIds.length) throw new BadRequestException("At least one approved test case is required");
    const tests = await this.prisma.testCase.findMany({ where: { projectId, id: { in: selectedIds } } });
    if (tests.length !== selectedIds.length) throw new BadRequestException("One or more selected tests do not belong to this project");
    if (tests.some((testCase) => testCase.status !== "APPROVED")) throw new BadRequestException("Only approved test cases can be executed");

    await this.assertConcurrencyAvailable(user.organizationId, context.executionSlotLimit);

    const plan = await this.prisma.executionPlan.create({
      data: {
        organizationId: user.organizationId,
        projectId,
        branch: input.branch ?? project.defaultBranch,
        commitSha: input.commitSha,
        environmentUrl: environment.url,
        trigger: input.trigger ?? "DASHBOARD",
        items: { create: selectedIds.map((testCaseId) => ({ testCaseId })) }
      },
      include: { items: { omit: { stepLog: true }, include: { testCase: { select: { id: true, title: true } } } }, project: { select: { id: true, name: true } } }
    });
    await enqueueExecution(plan.id);
    await recordAudit(this.prisma, {
      organizationId: user.organizationId, actorId: user.userId, action: "execution.started",
      targetType: "ExecutionPlan", targetId: plan.id, metadata: { tests: selectedIds.length, branch: plan.branch, trigger: plan.trigger }
    });
    return plan;
  }

  async runAllApproved(user: AuthenticatedUser, projectId: string, input: { branch?: string; environmentId?: string; environmentUrl?: string }) {
    const approved = await this.prisma.testCase.findMany({ where: { projectId, status: "APPROVED" }, select: { id: true } });
    if (!approved.length) throw new BadRequestException("No approved test cases exist in this project yet");
    return this.create(user, projectId, { ...input, testCaseIds: approved.map((test) => test.id), trigger: "DASHBOARD" });
  }

  async rerunFailed(user: AuthenticatedUser, projectId: string, planId: string) {
    const previous = await this.prisma.executionPlan.findFirst({
      where: { id: planId, projectId, organizationId: user.organizationId },
      include: { items: true }
    });
    if (!previous) throw new NotFoundException("Execution plan not found");
    const failedIds = previous.items.filter((item) => item.status === "FAILED" || item.status === "BLOCKED").map((item) => item.testCaseId);
    if (!failedIds.length) throw new BadRequestException("No failed tests to rerun in this plan");
    return this.create(user, projectId, { testCaseIds: failedIds, branch: previous.branch, commitSha: previous.commitSha ?? undefined, environmentUrl: previous.environmentUrl, trigger: "RERUN" });
  }

  async list(user: AuthenticatedUser, projectId: string) {
    await this.assertProject(user, projectId);
    const plans = await this.prisma.executionPlan.findMany({
      where: { projectId, organizationId: user.organizationId },
      include: { items: { omit: { stepLog: true }, include: { testCase: { select: { id: true, title: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return plans.map((plan) => this.summarize(plan));
  }

  async detail(user: AuthenticatedUser, projectId: string, planId: string) {
    await this.assertProject(user, projectId);
    const plan = await this.prisma.executionPlan.findFirst({
      where: { id: planId, projectId, organizationId: user.organizationId },
      include: {
        items: { include: { testCase: { select: { id: true, title: true, capability: true, category: true } } } },
        artifacts: true
      }
    });
    if (!plan) throw new NotFoundException("Execution plan not found");
    return { ...this.summarize(plan), items: plan.items, artifacts: plan.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, testCaseId: artifact.testCaseId, name: artifact.path.split(/[\\/]/).pop() ?? "", url: `/v1/artifacts/${artifact.id}` })) };
  }

  async cancel(user: AuthenticatedUser, projectId: string, planId: string) {
    await this.assertProject(user, projectId);
    const plan = await this.prisma.executionPlan.findFirst({ where: { id: planId, projectId, organizationId: user.organizationId } });
    if (!plan) throw new NotFoundException("Execution plan not found");
    if (plan.status !== "QUEUED" && plan.status !== "RUNNING") throw new BadRequestException("Only queued or running executions can be canceled");
    const updated = await this.prisma.executionPlan.update({ where: { id: planId }, data: { status: "CANCELED", completedAt: new Date() } });
    if (plan.trigger === "CI") await enqueueCiReport({ planId });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "execution.canceled", targetType: "ExecutionPlan", targetId: planId });
    return updated;
  }

  /** Org-wide execution history for the Executions page, optionally narrowed to one project. */
  async listAcrossProjects(user: AuthenticatedUser, filters: { projectId?: string }) {
    const plans = await this.prisma.executionPlan.findMany({
      where: { organizationId: user.organizationId, ...(filters.projectId ? { projectId: filters.projectId } : {}) },
      include: { items: { omit: { stepLog: true }, include: { testCase: { select: { id: true, title: true } } } }, project: { select: { id: true, name: true, defaultBranch: true } } },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return plans.map((plan) => ({ ...this.summarize(plan), project: plan.project }));
  }

  private summarize(plan: { id: string; status: string; trigger: string; branch: string; commitSha: string | null; environmentUrl: string; createdAt: Date; startedAt: Date | null; completedAt: Date | null; items: Array<{ status: string }> }) {
    const counts = { total: plan.items.length, passed: 0, failed: 0, running: 0, queued: 0, blocked: 0, skipped: 0 };
    for (const item of plan.items) {
      if (item.status === "PASSED") counts.passed += 1;
      else if (item.status === "FAILED") counts.failed += 1;
      else if (item.status === "RUNNING") counts.running += 1;
      else if (item.status === "QUEUED") counts.queued += 1;
      else if (item.status === "BLOCKED") counts.blocked += 1;
      else counts.skipped += 1;
    }
    return { ...plan, counts };
  }

  private async resolveEnvironment(projectId: string, input: CreateExecutionInput) {
    if (input.environmentId) {
      const environment = await this.prisma.environmentProfile.findFirst({ where: { id: input.environmentId, projectId } });
      if (!environment) throw new NotFoundException("Selected environment does not exist on this project");
      return environment;
    }
    if (input.environmentUrl?.trim()) return { id: null, name: "custom", url: input.environmentUrl.trim() };
    const fallback = await this.prisma.environmentProfile.findFirst({ where: { projectId, isDefault: true } }) ?? await this.prisma.environmentProfile.findFirst({ where: { projectId } });
    if (!fallback) throw new BadRequestException("No environment is configured for this project. Add one in Settings or pass an explicit environmentUrl.");
    return fallback;
  }

  private async assertConcurrencyAvailable(organizationId: string, slotLimit: number) {
    const active = await this.prisma.executionPlan.count({ where: { organizationId, status: { in: ["QUEUED", "RUNNING"] } } });
    if (active >= slotLimit) throw new ForbiddenException(`The plan allows ${slotLimit} concurrent execution runs and ${active} are already queued or running`);
  }

  private async assertProject(user: AuthenticatedUser, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    return project;
  }
}
