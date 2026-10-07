import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import Stripe = require("stripe");
import { PrismaService } from "../database/prisma.service";
import { recordAudit } from "../common/audit";
import { subscriptionContext } from "../common/billing-context";
import type { AuthenticatedUser } from "../auth/auth.types";

const TRIAL_DAYS = 14;
const webUrl = () => (process.env.WEB_APP_URL ?? "http://localhost:3004").replace(/\/$/, "");

const statusMap: Record<string, "INCOMPLETE" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "BILLING_LOCKED" | "CANCELED" | "EXPIRED"> = {
  trialing: "TRIALING",
  active: "ACTIVE",
  past_due: "PAST_DUE",
  unpaid: "BILLING_LOCKED",
  paused: "BILLING_LOCKED",
  canceled: "CANCELED",
  incomplete: "INCOMPLETE",
  incomplete_expired: "EXPIRED"
};

@Injectable()
export class BillingService {
  private client?: Stripe;

  constructor(private readonly prisma: PrismaService) {}

  private get stripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new ServiceUnavailableException("Billing is not configured on this deployment");
    return (this.client ??= new Stripe(key));
  }

  private assertAdmin(user: AuthenticatedUser) {
    if (user.role !== "ADMIN") throw new ForbiddenException("Only organization admins can manage billing");
  }

  /** Public (landing page): sellable plans with their active prices. */
  async publicPlans() {
    const plans = await this.prisma.pricingPlan.findMany({ where: { isActive: true, stripeProductId: { not: null } }, orderBy: { monthlyPriceUsd: "asc" }, include: { prices: { where: { isActive: true } } } });
    return plans.map((plan) => ({
      key: plan.key,
      name: plan.name,
      executionSlotLimit: plan.executionSlotLimit,
      tokenQuotaMonthly: plan.tokenQuotaMonthly,
      prices: plan.prices.map((price) => ({ interval: price.interval, unitAmountCents: price.unitAmountCents }))
    }));
  }

  async summary(organizationId: string) {
    const context = await subscriptionContext(this.prisma, organizationId);
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true, price: true } });
    const plans = await this.prisma.pricingPlan.findMany({ where: { isActive: true }, orderBy: { monthlyPriceUsd: "asc" }, include: { prices: { where: { isActive: true } } } });
    return {
      subscription: subscription ? {
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        trialEndsAt: subscription.trialEndsAt,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        interval: subscription.price?.interval ?? null,
        hasStripeSubscription: Boolean(subscription.stripeSubscriptionId),
        trialEligible: !subscription.stripeSubscriptionId
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
      availablePlans: plans.map((plan) => ({
        key: plan.key,
        name: plan.name,
        monthlyPriceUsd: plan.monthlyPriceUsd,
        tokenQuotaMonthly: plan.tokenQuotaMonthly,
        executionSlotLimit: plan.executionSlotLimit,
        prices: plan.prices.map((price) => ({ interval: price.interval, unitAmountCents: price.unitAmountCents }))
      }))
    };
  }

  async createCheckout(user: AuthenticatedUser, planKey: string, interval: string) {
    this.assertAdmin(user);
    const price = await this.prisma.planPrice.findFirst({ where: { isActive: true, interval: interval as never, plan: { key: planKey, isActive: true } } });
    if (!price) throw new BadRequestException("Unknown plan or billing interval");

    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId: user.organizationId } });
    if (!subscription) throw new NotFoundException("No subscription record exists for this organization");
    if (subscription.stripeSubscriptionId && !["CANCELED", "EXPIRED", "INCOMPLETE"].includes(subscription.status)) {
      throw new ConflictException("This organization already has a subscription. Use Manage billing to change it.");
    }

    let customerId = subscription.stripeCustomerId;
    if (!customerId) {
      const [account, organization] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: user.userId } }),
        this.prisma.organization.findUnique({ where: { id: user.organizationId } })
      ]);
      const customer = await this.stripe.customers.create({ email: account?.email, name: organization?.name, metadata: { organizationId: user.organizationId } });
      customerId = customer.id;
      await this.prisma.subscription.update({ where: { id: subscription.id }, data: { stripeCustomerId: customerId } });
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: user.organizationId,
      line_items: [{ price: price.stripePriceId, quantity: 1 }],
      subscription_data: {
        metadata: { organizationId: user.organizationId },
        // One trial per organization: a prior Stripe subscription (even canceled) forfeits it.
        ...(subscription.stripeSubscriptionId ? {} : { trial_period_days: TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } } })
      },
      success_url: `${webUrl()}/billing?checkout=success`,
      cancel_url: `${webUrl()}/billing?checkout=canceled`
    });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "billing.checkout_started", targetType: "Subscription", targetId: subscription.id, metadata: { planKey, interval } });
    return { url: session.url };
  }

  async createPortal(user: AuthenticatedUser) {
    this.assertAdmin(user);
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId: user.organizationId } });
    if (!subscription?.stripeCustomerId) throw new BadRequestException("Start a plan first; there is no billing account yet");
    const session = await this.stripe.billingPortal.sessions.create({ customer: subscription.stripeCustomerId, return_url: `${webUrl()}/billing` });
    return { url: session.url };
  }

  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException("Stripe webhook processing is not configured on this deployment");
    if (!rawBody || !signature) throw new BadRequestException("A raw body and Stripe-Signature header are required");

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new BadRequestException("Stripe webhook signature verification failed");
    }
    if (await this.prisma.billingEvent.findUnique({ where: { id: event.id } })) return { received: true, duplicate: true };

    const subscriptionId = this.subscriptionIdOf(event);
    if (subscriptionId) await this.syncSubscription(subscriptionId, event);
    // Recorded only after a successful sync, so a failure (500) makes Stripe retry.
    await this.prisma.billingEvent.upsert({ where: { id: event.id }, create: { id: event.id, type: event.type }, update: {} });
    return { received: true };
  }

  private subscriptionIdOf(event: Stripe.Event): string | undefined {
    const object = event.data.object as unknown as Record<string, unknown>;
    switch (event.type) {
      case "checkout.session.completed":
        return typeof object.subscription === "string" ? object.subscription : undefined;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        return object.id as string;
      case "invoice.paid":
      case "invoice.payment_failed":
        return (object as unknown as Stripe.Invoice).parent?.subscription_details?.subscription as string | undefined;
      default:
        return undefined;
    }
  }

  // Always re-reads the subscription from Stripe, so event order and duplicates cannot leave stale state.
  private async syncSubscription(subscriptionId: string, event: Stripe.Event) {
    const remote = await this.stripe.subscriptions.retrieve(subscriptionId);
    const customerId = typeof remote.customer === "string" ? remote.customer : remote.customer.id;
    const local = remote.metadata.organizationId
      ? await this.prisma.subscription.findUnique({ where: { organizationId: remote.metadata.organizationId } })
      : await this.prisma.subscription.findUnique({ where: { stripeCustomerId: customerId } });
    if (!local) return;

    const item = remote.items.data[0];
    const price = item ? await this.prisma.planPrice.findUnique({ where: { stripePriceId: item.price.id } }) : null;
    const status = statusMap[remote.status] ?? "ACTIVE";
    await this.prisma.subscription.update({
      where: { id: local.id },
      data: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: remote.id,
        status,
        ...(price ? { planId: price.planId, priceId: price.id } : {}),
        currentPeriodEnd: item ? new Date(item.current_period_end * 1000) : local.currentPeriodEnd,
        cancelAtPeriodEnd: remote.cancel_at_period_end,
        trialEndsAt: remote.trial_end ? new Date(remote.trial_end * 1000) : null
      }
    });
    await recordAudit(this.prisma, {
      organizationId: local.organizationId,
      action: `billing.${event.type.replace(/\./g, "_")}`,
      targetType: "Subscription",
      targetId: local.id,
      metadata: { stripeEventId: event.id, status },
      scope: "PLATFORM"
    });
  }
}
