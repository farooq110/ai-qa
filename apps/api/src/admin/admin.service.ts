import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import Stripe = require("stripe");
import { PrismaService } from "../database/prisma.service";
import { recordAudit } from "../common/audit";
import { SupportQueriesService } from "../support-queries/support-queries.service";

@Injectable()
export class AdminService {
  private readonly stripe: Stripe | null;

  constructor(private readonly prisma: PrismaService, private readonly supportQueries: SupportQueriesService) {
    this.stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  }

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
      this.prisma.testCase.count({ where: { status: { not: "DRAFT" } } }),
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

  /**
   * Superadmin edits plan pricing/entitlements. Stripe is the billing source of
   * truth (a boot sync mirrors the Stripe catalog over the DB), so edits are
   * write-through: product metadata carries the entitlements and price changes
   * rotate to a NEW Stripe price (prices are immutable; existing subscriptions
   * keep their original price until they renew).
   */
  async updatePlan(planId: string, input: Record<string, unknown>) {
    const numeric = ["monthlyPriceUsd", "tokenQuotaMonthly", "warningThresholdPct", "executionSlotLimit", "retentionDays", "projectLimit", "trialDays"] as const;
    const data: Record<string, string | number | boolean> = {};
    if (typeof input.name === "string" && input.name.trim()) data.name = input.name.trim();
    if (typeof input.isActive === "boolean") data.isActive = input.isActive;
    for (const field of numeric) {
      if (input[field] !== undefined && input[field] !== null && input[field] !== "") {
        const value = Number(input[field]);
        if (!Number.isFinite(value) || value < 0) throw new BadRequestException(`${field} must be a non-negative number`);
        data[field] = Math.round(value);
      }
    }
    if (Object.keys(data).length === 0) throw new BadRequestException("No editable fields provided");
    const plan = await this.prisma.pricingPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException("Plan not found");

    if (plan.stripeProductId && this.stripe) {
      await this.stripe.products.update(plan.stripeProductId, {
        name: `Proofline ${String(data.name ?? plan.name)}`,
        metadata: {
          plan_key: plan.key,
          token_quota_monthly: String(data.tokenQuotaMonthly ?? plan.tokenQuotaMonthly),
          execution_slot_limit: String(data.executionSlotLimit ?? plan.executionSlotLimit),
          retention_days: String(data.retentionDays ?? plan.retentionDays)
        }
      });
      const newPrice = Number(data.monthlyPriceUsd ?? plan.monthlyPriceUsd);
      if (newPrice !== plan.monthlyPriceUsd) {
        const active = await this.stripe.prices.list({ product: plan.stripeProductId, active: true, limit: 100 });
        const oldMonthly = active.data.find((price) => price.metadata?.billing_interval === "monthly");
        const created = await this.stripe.prices.create({
          product: plan.stripeProductId,
          unit_amount: newPrice * 100,
          currency: "usd",
          recurring: { interval: "month" },
          metadata: { plan_key: plan.key, billing_interval: "monthly" },
          lookup_key: `${plan.key}-monthly-${newPrice}usd`,
          transfer_lookup_key: true
        });
        // Switch the product default_price to the new price so Stripe allows archiving the old one
        await this.stripe.products.update(plan.stripeProductId, { default_price: created.id });
        const oldMonthlyPrices = active.data.filter((price) => price.metadata?.billing_interval === "monthly" && price.id !== created.id);
        for (const old of oldMonthlyPrices) {
          try { await this.stripe.prices.update(old.id, { active: false }); } catch {}
        }
        await this.prisma.planPrice.updateMany({ where: { planId: plan.id, interval: "MONTHLY" }, data: { isActive: false } });
        await this.prisma.planPrice.upsert({
          where: { stripePriceId: created.id },
          create: { stripePriceId: created.id, planId: plan.id, interval: "MONTHLY", lookupKey: created.lookup_key ?? `${plan.key}-monthly-${newPrice}usd`, unitAmountCents: newPrice * 100, currency: "usd", isActive: true },
          update: { isActive: true, unitAmountCents: newPrice * 100 }
        });
      }
    }

    const updated = await this.prisma.pricingPlan.update({ where: { id: planId }, data });
    await recordAudit(this.prisma, { action: "admin.pricing_plan_updated", targetType: "PricingPlan", targetId: planId, metadata: data, scope: "PLATFORM" });
    return updated;
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
