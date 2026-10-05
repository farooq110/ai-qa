import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import { recordAudit } from "../common/audit";
import { assertBillingActive, subscriptionContext } from "../common/billing-context";
import { enqueueExecution } from "../common/queue";
import type { AuthenticatedUser } from "../auth/auth.types";

const providerNames = ["GITHUB_ACTIONS", "GITLAB_CI", "BITBUCKET_PIPELINES"] as const;

@Injectable()
export class CiService {
  constructor(private readonly prisma: PrismaService) {}

  async createConnection(user: AuthenticatedUser, projectId: string, input: { provider: string; label?: string }) {
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot manage CI connections");
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const provider = this.assertProvider(input.provider);
    const token = `ci_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const connection = await this.prisma.ciConnection.create({
      data: { projectId, provider, label: input.label?.trim() || provider, tokenHash, tokenHint: token.slice(0, 9) }
    });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "ci.connection_created", targetType: "CiConnection", targetId: connection.id, metadata: { provider } });
    return { id: connection.id, provider: connection.provider, label: connection.label, token, tokenHint: connection.tokenHint, createdAt: connection.createdAt };
  }

  async listConnections(user: AuthenticatedUser, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    const connections = await this.prisma.ciConnection.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
    return connections.map((connection) => ({ id: connection.id, provider: connection.provider, label: connection.label, tokenHint: connection.tokenHint, lastUsedAt: connection.lastUsedAt, createdAt: connection.createdAt }));
  }

  async deleteConnection(user: AuthenticatedUser, projectId: string, connectionId: string) {
    if (user.role === "DEVELOPER") throw new ForbiddenException("This role cannot manage CI connections");
    const connection = await this.prisma.ciConnection.findFirst({ where: { id: connectionId, project: { organizationId: user.organizationId } } });
    if (!connection) throw new NotFoundException("CI connection not found");
    await this.prisma.ciConnection.delete({ where: { id: connectionId } });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "ci.connection_deleted", targetType: "CiConnection", targetId: connectionId });
    return { deleted: true };
  }

  async listRequests(user: AuthenticatedUser, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException("Project not found");
    return this.prisma.ciExecutionRequest.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 30 });
  }

  /**
   * CI push webhook: token-authenticated, pins the exact commit, runs all approved tests.
   * The commit SHA is authoritative; the branch name is historical metadata only.
   */
  async handlePush(input: { token?: string; provider?: string; repository?: string; branch?: string; commitSha?: string; pipelineId?: string }) {
    if (!input.token) throw new BadRequestException("A CI token is required");
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    const connection = await this.prisma.ciConnection.findUnique({ where: { tokenHash }, include: { project: { include: { organization: { include: { subscription: true } } } } } });
    if (!connection) throw new ForbiddenException("The CI token is invalid or revoked");

    if (!input.commitSha || !/^[0-9a-f]{7,40}$/i.test(input.commitSha)) throw new BadRequestException("commitSha is required and must be a git SHA");
    if (!input.branch) throw new BadRequestException("branch is required");

    const context = await subscriptionContext(this.prisma, connection.project.organizationId);
    assertBillingActive(context, "CI execution");
    if (connection.lastUsedAt === null || Date.now() - connection.lastUsedAt.getTime() > 60_000) {
      await this.prisma.ciConnection.update({ where: { id: connection.id }, data: { lastUsedAt: new Date() } });
    }

    const approved = await this.prisma.testCase.findMany({ where: { projectId: connection.projectId, status: "APPROVED" }, select: { id: true } });
    const request = await this.prisma.ciExecutionRequest.create({
      data: { projectId: connection.projectId, provider: connection.provider, branch: input.branch, commitSha: input.commitSha, pipelineId: input.pipelineId, status: "ACCEPTED" }
    });
    if (!approved.length) {
      await this.prisma.ciExecutionRequest.update({ where: { id: request.id }, data: { status: "NO_APPROVED_TESTS" } });
      return { accepted: false, reason: "No approved test cases exist for this project", requestId: request.id };
    }

    const plan = await this.prisma.executionPlan.create({
      data: {
        organizationId: connection.project.organizationId,
        projectId: connection.projectId,
        branch: input.branch,
        commitSha: input.commitSha,
        environmentUrl: this.ciEnvironmentUrl(input.branch),
        trigger: "CI",
        items: { create: approved.map((test) => ({ testCaseId: test.id })) }
      }
    });
    await this.prisma.ciExecutionRequest.update({ where: { id: request.id }, data: { executionPlanId: plan.id, status: "QUEUED" } });
    await enqueueExecution(plan.id);
    await recordAudit(this.prisma, {
      organizationId: connection.project.organizationId, action: "ci.execution_queued", targetType: "ExecutionPlan", targetId: plan.id,
      metadata: { provider: connection.provider, branch: input.branch, commitSha: input.commitSha, tests: approved.length }
    });
    return { accepted: true, requestId: request.id, executionPlanId: plan.id, tests: approved.length, branch: input.branch, commitSha: input.commitSha };
  }

  private ciEnvironmentUrl(branch: string) {
    const configured = process.env.CI_ENVIRONMENT_URL_TEMPLATE;
    if (configured?.includes("{branch}")) return configured.replace("{branch}", encodeURIComponent(branch));
    return `https://ci-preview.local/${encodeURIComponent(branch)}`;
  }

  private assertProvider(provider: string) {
    const upper = provider.toUpperCase();
    if (!providerNames.includes(upper as (typeof providerNames)[number])) throw new BadRequestException("provider must be GITHUB_ACTIONS, GITLAB_CI, or BITBUCKET_PIPELINES");
    return upper as (typeof providerNames)[number];
  }
}
