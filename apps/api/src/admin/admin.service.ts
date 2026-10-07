import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { recordAudit } from "../common/audit";
import { SupportQueriesService } from "../support-queries/support-queries.service";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService, private readonly supportQueries: SupportQueriesService) {}

  supportQueryList() {
    return this.supportQueries.list();
  }

  async updateSupportQueryStatus(id: string, status: string) {
    const query = await this.supportQueries.updateStatus(id, status);
    await recordAudit(this.prisma, { action: "admin.support_query_status_changed", targetType: "SupportQuery", targetId: id, metadata: { status }, scope: "PLATFORM" });
    return query;
  }

  async overview() {
    const [organizations, users, projects, tests, plans, monthStart] = await Promise.all([
      this.prisma.organization.count(),
      this.prisma.user.count({ where: { isSuperadmin: false } }),
      this.prisma.project.count(),
      this.prisma.testCase.count(),
      this.prisma.executionPlan.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } }),
      Promise.resolve(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
    ]);
    const usage = await this.prisma.aiUsageRecord.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { inputTokens: true, outputTokens: true } });
    const billingAttention = await this.prisma.subscription.groupBy({ by: ["status"], _count: { status: true }, where: { status: { in: ["PAST_DUE", "BILLING_LOCKED", "PAYMENT_WARNING"] } } });
    return {
      organizations,
      users,
      projects,
      testCases: tests,
      activeExecutions: plans.length,
      aiTokensThisMonth: (usage._sum.inputTokens ?? 0) + (usage._sum.outputTokens ?? 0),
      billingAttention: billingAttention.map((entry) => ({ status: entry.status, count: entry._count.status }))
    };
  }

  async organizations() {
    const organizations = await this.prisma.organization.findMany({
      include: {
        memberships: { include: { user: { select: { email: true } } } },
        subscription: { include: { plan: true } },
        _count: { select: { projects: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    return organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      industry: organization.industry,
      createdAt: organization.createdAt,
      members: organization.memberships.length,
      projects: organization._count.projects,
      subscriptionStatus: organization.subscription?.status ?? "NONE",
      plan: organization.subscription?.plan?.name ?? null
    }));
  }

  async updateSubscriptionStatus(organizationId: string, status: string) {
    const allowed = ["TRIALING", "ACTIVE", "PAYMENT_WARNING", "PAST_DUE", "BILLING_LOCKED", "CANCELED", "EXPIRED"];
    if (!allowed.includes(status)) throw new NotFoundException("Unknown subscription status");
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription) throw new NotFoundException("Organization has no subscription record");
    const updated = await this.prisma.subscription.update({ where: { id: subscription.id }, data: { status: status as never } });
    await recordAudit(this.prisma, { action: "admin.subscription_status_changed", organizationId, targetType: "Subscription", targetId: subscription.id, metadata: { status }, scope: "PLATFORM" });
    return updated;
  }

  async plans() {
    return this.prisma.pricingPlan.findMany({ orderBy: { monthlyPriceUsd: "asc" }, include: { _count: { select: { subscriptions: true } } } });
  }

  async auditTrail(take = 100) {
    return this.prisma.auditEvent.findMany({ where: { scope: "PLATFORM" }, orderBy: { createdAt: "desc" }, take });
  }

  async workers() {
    const [queued, running] = await Promise.all([
      this.prisma.executionPlan.count({ where: { status: "QUEUED" } }),
      this.prisma.executionPlan.count({ where: { status: "RUNNING" } })
    ]);
    const usage24h = await this.prisma.aiUsageRecord.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } });
    return { queuedExecutions: queued, runningExecutions: running, aiCalls24h: usage24h, configuredWorkerConcurrency: Number(process.env.PLAYWRIGHT_WORKER_CONCURRENCY ?? 5) };
  }
}
