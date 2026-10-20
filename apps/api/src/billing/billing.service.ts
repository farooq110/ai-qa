import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import Stripe = require("stripe");
import { PrismaService } from "../database/prisma.service";
import { recordAudit } from "../common/audit";
import { subscriptionContext } from "../common/billing-context";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PermissionsService } from "../rbac/permissions.service";
import { PERMISSIONS } from "@ai-qa/domain";

const TRIAL_DAYS = 14;
const webUrl = () => (process.env.WEB_APP_URL ?? "http://localhost:3004").replace(/\/$/, "");

const intervalOf: Record<string, "MONTHLY" | "QUARTERLY" | "YEARLY"> = { monthly: "MONTHLY", quarterly: "QUARTERLY", yearly: "YEARLY" };

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
export class BillingService implements OnModuleInit {
  private client?: Stripe;
  private readonly logger = new Logger(BillingService.name);

  /** Mirror the Stripe catalog into the DB on boot so a fresh environment sells plans without a manual seed step. */
  async onModuleInit() {
    if (!process.env.STRIPE_SECRET_KEY) return;
    try { await this.syncCatalog(); } catch (error) { this.logger.error(`Stripe catalog sync failed: ${error instanceof Error ? error.message : error}`); }
  }

  async syncCatalog() {
    const products = (await this.stripe.products.list({ active: true, limit: 100 })).data.filter((product) => product.metadata.plan_key);
    const seenProducts: string[] = [];
    const seenPrices: string[] = [];
    for (const product of products) {
      const prices = (await this.stripe.prices.list({ product: product.id, active: true, limit: 100 })).data.filter((price) => intervalOf[price.metadata.billing_interval ?? ""] && price.unit_amount !== null && price.recurring !== null);
      const monthly = prices.find((price) => price.metadata.billing_interval === "monthly");
      const planData = {
        name: product.name.replace(/^Proofline /, ""),
        stripeProductId: product.id,
        monthlyPriceUsd: monthly ? Math.round(monthly.unit_amount! / 100) : 0,
        tokenQuotaMonthly: Number(product.metadata.token_quota_monthly),
        executionSlotLimit: Number(product.metadata.execution_slot_limit),
        retentionDays: Number(product.metadata.retention_days),
        isActive: true
      };
      const plan = await this.prisma.pricingPlan.upsert({ where: { key: product.metadata.plan_key! }, create: { key: product.metadata.plan_key!, ...planData }, update: planData });
      seenProducts.push(product.id);
      for (const price of prices) {
        const data = { planId: plan.id, interval: intervalOf[price.metadata.billing_interval!]!, lookupKey: price.lookup_key, unitAmountCents: price.unit_amount!, currency: price.currency, isActive: true };
        await this.prisma.planPrice.upsert({ where: { stripePriceId: price.id }, create: { stripePriceId: price.id, ...data }, update: data });
        seenPrices.push(price.id);
      }
    }
    if (!products.length) { this.logger.warn("Stripe returned no plan products; leaving the DB catalog untouched"); return; }
    // Gone from Stripe: keep rows (existing subscriptions reference them) but stop selling.
    // The Trial plan is DB-managed (no Stripe product) — never deactivate it here.
    await this.prisma.planPrice.updateMany({ where: { stripePriceId: { notIn: seenPrices } }, data: { isActive: false } });
    await this.prisma.pricingPlan.updateMany({ where: { AND: [{ key: { not: "trial" } }, { OR: [{ stripeProductId: null }, { stripeProductId: { notIn: seenProducts } }] }] }, data: { isActive: false } });
    this.logger.log(`Stripe catalog synced: ${seenProducts.length} plans, ${seenPrices.length} prices`);
  }

  constructor(private readonly prisma: PrismaService, private readonly permissions: PermissionsService) {}

  private get stripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new ServiceUnavailableException("Billing is not configured on this deployment");
    return (this.client ??= new Stripe(key));
  }

  private async assertAdmin(user: AuthenticatedUser) {
    await this.permissions.assert(user, PERMISSIONS.BILLING_MANAGE);
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
        startedAt: subscription.createdAt,
        currentPeriodEnd: subscription.currentPeriodEnd,
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
    await this.assertAdmin(user);
    const price = await this.prisma.planPrice.findFirst({ where: { isActive: true, interval: interval as never, plan: { key: planKey, isActive: true } } });
    if (!price) throw new BadRequestException("Unknown plan or billing interval");

    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId: user.organizationId } });
    if (!subscription) throw new NotFoundException("No subscription record exists for this organization");
    if (subscription.stripeSubscriptionId && !["CANCELED", "EXPIRED", "INCOMPLETE"].includes(subscription.status)) {
      throw new ConflictException("This organization already has a subscription. Use Change plan instead.");
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

    // Trial length comes from the Trial pricing plan so the superadmin can change it.
    // The free trial is its own DB-managed plan (attached at signup) — paid plans
    // start billing immediately, no extra Stripe trial on top.
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: user.organizationId,
      line_items: [{ price: price.stripePriceId, quantity: 1 }],
      subscription_data: {
        metadata: { organizationId: user.organizationId }
      },
      success_url: `${webUrl()}/billing?checkout=success`,
      cancel_url: `${webUrl()}/billing?checkout=canceled`
    });
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "billing.checkout_started", targetType: "Subscription", targetId: subscription.id, metadata: { planKey, interval } });
    return { url: session.url };
  }

  /** Payment method, upcoming invoice and invoice history, straight from Stripe. Kept out of summary() so that stays fast and Stripe-free. */
  async invoices(organizationId: string) {
    const local = await this.prisma.subscription.findUnique({ where: { organizationId } });
    const empty = { paymentMethod: null, upcoming: null, invoices: [] as unknown[] };
    if (!local?.stripeCustomerId) return empty;

    const [remote, list] = await Promise.all([
      local.stripeSubscriptionId ? this.stripe.subscriptions.retrieve(local.stripeSubscriptionId, { expand: ["default_payment_method"] }) : null,
      this.stripe.invoices.list({ customer: local.stripeCustomerId, limit: 12 })
    ]);

    let method = remote && typeof remote.default_payment_method === "object" ? remote.default_payment_method : null;
    if (!method) {
      const customer = await this.stripe.customers.retrieve(local.stripeCustomerId, { expand: ["invoice_settings.default_payment_method"] });
      const fallback = !customer.deleted ? customer.invoice_settings.default_payment_method : null;
      method = typeof fallback === "object" ? fallback : null;
    }

    let upcoming: { amountDue: number; currency: string; date: string | null } | null = null;
    if (remote && !remote.cancel_at_period_end && ["trialing", "active", "past_due"].includes(remote.status)) {
      try {
        const preview = await this.stripe.invoices.createPreview({ customer: local.stripeCustomerId, subscription: remote.id });
        upcoming = { amountDue: preview.amount_due, currency: preview.currency, date: local.currentPeriodEnd?.toISOString() ?? null };
      } catch (error) {
        this.logger.warn(`Invoice preview failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    return {
      paymentMethod: method?.card ? { brand: method.card.brand, last4: method.card.last4, expMonth: method.card.exp_month, expYear: method.card.exp_year } : null,
      upcoming,
      invoices: list.data.filter((invoice) => invoice.status !== "draft").map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        createdAt: new Date(invoice.created * 1000).toISOString(),
        amount: invoice.status === "paid" ? invoice.amount_paid : invoice.amount_due,
        currency: invoice.currency,
        status: invoice.status,
        viewUrl: invoice.hosted_invoice_url ?? null,
        pdfUrl: invoice.invoice_pdf ?? null
      }))
    };
  }

  /** Hosted Stripe page in setup mode: collects a new card; the webhook then makes it the default. */
  async createCardUpdate(user: AuthenticatedUser) {
    await this.assertAdmin(user);
    const local = await this.prisma.subscription.findUnique({ where: { organizationId: user.organizationId } });
    if (!local?.stripeCustomerId || !local.stripeSubscriptionId) throw new BadRequestException("Subscribe to a plan first; there is no card on file to update");
    const session = await this.stripe.checkout.sessions.create({
      mode: "setup",
      currency: "usd",
      customer: local.stripeCustomerId,
      metadata: { organizationId: user.organizationId, subscriptionId: local.stripeSubscriptionId },
      success_url: `${webUrl()}/billing?card=updated`,
      cancel_url: `${webUrl()}/billing?card=canceled`
    });
    return { url: session.url };
  }

  /** Switch plan and/or interval on a live subscription; Stripe prorates the difference. */
  async changePlan(user: AuthenticatedUser, planKey: string, interval: string) {
    await this.assertAdmin(user);
    const price = await this.prisma.planPrice.findFirst({ where: { isActive: true, interval: interval as never, plan: { key: planKey, isActive: true } } });
    if (!price) throw new BadRequestException("Unknown plan or billing interval");
    const local = await this.prisma.subscription.findUnique({ where: { organizationId: user.organizationId } });
    if (!local?.stripeSubscriptionId || ["CANCELED", "EXPIRED", "INCOMPLETE"].includes(local.status)) throw new BadRequestException("There is no active subscription to change");
    if (local.priceId === price.id) throw new BadRequestException("The organization is already on this plan and interval");

    const remote = await this.stripe.subscriptions.retrieve(local.stripeSubscriptionId);
    const item = remote.items.data[0];
    if (!item) throw new BadRequestException("The subscription has no items to change");
    const updated = await this.stripe.subscriptions.update(remote.id, {
      items: [{ id: item.id, price: price.stripePriceId }],
      proration_behavior: "create_prorations",
      // Changing plan also un-schedules a pending cancellation: the admin is clearly staying.
      cancel_at_period_end: false
    });
    await this.syncSubscription(updated.id, null);
    await recordAudit(this.prisma, { organizationId: user.organizationId, actorId: user.userId, action: "billing.plan_changed", targetType: "Subscription", targetId: local.id, metadata: { planKey, interval } });
    return { ok: true };
  }

  /** In-app cancel: ends at period end (access continues until then); resume undoes it before that date. */
  async setCancellation(user: AuthenticatedUser, cancel: boolean, reason?: string) {
    await this.assertAdmin(user);
    const local = await this.prisma.subscription.findUnique({ where: { organizationId: user.organizationId } });
    if (!local?.stripeSubscriptionId || ["CANCELED", "EXPIRED", "INCOMPLETE"].includes(local.status)) throw new BadRequestException("There is no active subscription to change");
    const remote = await this.stripe.subscriptions.update(local.stripeSubscriptionId, {
      cancel_at_period_end: cancel,
      ...(cancel && reason ? { cancellation_details: { comment: reason.slice(0, 500) } } : {})
    });
    await this.prisma.subscription.update({ where: { id: local.id }, data: { cancelAtPeriodEnd: remote.cancel_at_period_end } });
    await recordAudit(this.prisma, {
      organizationId: local.organizationId,
      actorId: user.userId,
      action: cancel ? "billing.cancel_requested" : "billing.cancel_reverted",
      targetType: "Subscription",
      targetId: local.id,
      metadata: { reason: reason?.slice(0, 500) }
    });
    return { cancelAtPeriodEnd: remote.cancel_at_period_end };
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

    const object = event.data.object as unknown as Record<string, unknown>;
    if (event.type === "checkout.session.completed" && object.mode === "setup") await this.applyNewCard(object as unknown as Stripe.Checkout.Session);
    const subscriptionId = this.subscriptionIdOf(event);
    if (subscriptionId) await this.syncSubscription(subscriptionId, event);
    // Recorded only after a successful sync, so a failure (500) makes Stripe retry.
    await this.prisma.billingEvent.upsert({ where: { id: event.id }, create: { id: event.id, type: event.type }, update: {} });
    return { received: true };
  }

  /** A setup-mode Checkout finished: make its card the default on the customer AND the subscription (the subscription-level one wins on renewal). */
  private async applyNewCard(session: Stripe.Checkout.Session) {
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
    const subscriptionId = session.metadata?.subscriptionId;
    const intentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
    if (!customerId || !subscriptionId || !intentId) return;
    const intent = await this.stripe.setupIntents.retrieve(intentId);
    const paymentMethod = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
    if (!paymentMethod) return;
    await this.stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethod } });
    await this.stripe.subscriptions.update(subscriptionId, { default_payment_method: paymentMethod });
    // A new default card does not retry an invoice that already failed, and Stripe stops retrying
    // unpaid subscriptions entirely; pay them now so a past-due/locked org recovers (invoice.paid then unlocks it).
    const open = await this.stripe.invoices.list({ subscription: subscriptionId, status: "open" });
    for (const invoice of open.data) {
      try { await this.stripe.invoices.pay(invoice.id); }
      catch (error) { this.logger.warn(`Paying open invoice ${invoice.id} with the new card failed: ${error instanceof Error ? error.message : error}`); }
    }
    const local = await this.prisma.subscription.findUnique({ where: { stripeCustomerId: customerId } });
    if (local) await recordAudit(this.prisma, { organizationId: local.organizationId, action: "billing.card_updated", targetType: "Subscription", targetId: local.id });
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
  private async syncSubscription(subscriptionId: string, event: Stripe.Event | null) {
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
        cancelAtPeriodEnd: remote.cancel_at_period_end
      }
    });
    await recordAudit(this.prisma, {
      organizationId: local.organizationId,
      action: `billing.${event ? event.type.replace(/\./g, "_") : "plan_synced"}`,
      targetType: "Subscription",
      targetId: local.id,
      metadata: { stripeEventId: event?.id, status },
      scope: "PLATFORM"
    });
  }
}
