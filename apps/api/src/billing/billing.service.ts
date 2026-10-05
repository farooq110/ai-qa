import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import { recordAudit } from "../common/audit";
import { subscriptionContext } from "../common/billing-context";

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(organizationId: string) {
    const context = await subscriptionContext(this.prisma, organizationId);
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
    const plans = await this.prisma.pricingPlan.findMany({ where: { isActive: true }, orderBy: { monthlyPriceUsd: "asc" } });
    return {
      subscription: subscription ? {
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        stripeCustomerId: subscription.stripeCustomerId,
        hasStripeSubscription: Boolean(subscription.stripeSubscriptionId)
      } : null,
      plan: subscription?.plan ? {
        key: subscription.plan.key,
        name: subscription.plan.name,
        monthlyPriceUsd: subscription.plan.monthlyPriceUsd,
        tokenQuotaMonthly: subscription.plan.tokenQuotaMonthly,
        warningThresholdPct: subscription.plan.warningThresholdPct,
        executionSlotLimit: subscription.plan.executionSlotLimit,
        retentionDays: subscription.plan.retentionDays
      } : null,
      usage: context.usage,
      remainingTokens: context.remainingTokens,
      tokenQuotaMonthly: context.tokenQuotaMonthly,
      warningThresholdPct: context.warningThresholdPct,
      executionSlotLimit: context.executionSlotLimit,
      availablePlans: plans.map((plan) => ({ key: plan.key, name: plan.name, monthlyPriceUsd: plan.monthlyPriceUsd, tokenQuotaMonthly: plan.tokenQuotaMonthly, executionSlotLimit: plan.executionSlotLimit }))
    };
  }

  async handleStripeWebhook(rawBody: string, signature: string | undefined) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new BadRequestException("Stripe webhook processing is not configured on this deployment");
    if (!signature?.includes("t=") || !signature.includes("v1=")) throw new BadRequestException("A valid Stripe-Signature header is required");

    const parts = Object.fromEntries(signature.split(",").map((part) => part.split("=") as [string, string]));
    const timestamp = parts["t"];
    const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const provided = parts["v1"];
    if (!timestamp || !provided || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
      throw new BadRequestException("Stripe webhook signature verification failed");
    }
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new BadRequestException("Stripe webhook timestamp is outside the replay window");

    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody) as StripeEvent;
    } catch {
      throw new BadRequestException("Webhook body must be valid JSON");
    }
    if (!event.id || !event.type) throw new BadRequestException("Webhook payload is missing event identity fields");

    const object = event.data?.object ?? {};
    const customerId = typeof object.customer === "string" ? object.customer : undefined;
    const subscriptionId = typeof object.id === "string" && object.object === "subscription" ? object.id : typeof object.subscription === "string" ? object.subscription : undefined;

    if (["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed", "invoice.paid"].includes(event.type)) {
      const where = customerId ? { stripeCustomerId: customerId } : undefined;
      const subscription = where ? await this.prisma.subscription.findUnique({ where, include: { organization: true } }) : null;
      if (!subscription) return { received: true, matched: false };

      const status = this.mapStripeStatus(event.type, object.status as string | undefined);
      const periodEnd = object.current_period_end ? new Date(Number(object.current_period_end) * 1000) : undefined;
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status, currentPeriodEnd: periodEnd ?? subscription.currentPeriodEnd, stripeSubscriptionId: subscriptionId ?? subscription.stripeSubscriptionId }
      });
      await recordAudit(this.prisma, {
        organizationId: subscription.organizationId,
        action: `billing.${event.type.replace(/\./g, "_")}`,
        targetType: "Subscription",
        targetId: subscription.id,
        metadata: { stripeEventId: event.id, status },
        scope: "PLATFORM"
      });
      return { received: true, matched: true, status };
    }
    return { received: true, matched: false };
  }

  private mapStripeStatus(eventType: string, stripeStatus?: string) {
    if (eventType === "customer.subscription.deleted") return "CANCELED";
    if (eventType === "invoice.payment_failed") return "PAST_DUE";
    if (eventType === "checkout.session.completed" || eventType === "invoice.paid") return "ACTIVE";
    switch (stripeStatus) {
      case "trialing": return "TRIALING";
      case "active": return "ACTIVE";
      case "past_due": return "PAST_DUE";
      case "canceled": case "unpaid": return "BILLING_LOCKED";
      default: return "ACTIVE";
    }
  }

  async listInvoicesPlaceholder(organizationId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription) throw new NotFoundException("No subscription exists for this organization");
    return { note: "Invoice history is served from Stripe once billing credentials are configured.", stripeCustomerId: subscription.stripeCustomerId };
  }
}
