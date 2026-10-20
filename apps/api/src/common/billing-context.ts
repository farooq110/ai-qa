import { ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

export interface SubscriptionContext {
  status: string;
  planKey: string;
  planName: string;
  tokenQuotaMonthly: number;
  warningThresholdPct: number;
  executionSlotLimit: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  remainingTokens: number;
  billingLocked: boolean;
  currentPeriodEnd: Date | null;
  trialDaysLeft: number | null;
}

/**
 * One end date for everything: `currentPeriodEnd` is the trial end while TRIALING (Stripe's period end equals trial_end).
 * Only the DB-managed "trial" plan lapses locally; Stripe-managed subscriptions follow Stripe's own status.
 */
type SubscriptionLike = { status: string; currentPeriodEnd: Date | null; plan: { key: string } | null };
export function effectiveStatus(subscription: SubscriptionLike | null | undefined) {
  if (!subscription) return "TRIALING";
  const lapsed = subscription.status === "TRIALING" && subscription.plan?.key === "trial" && subscription.currentPeriodEnd !== null && subscription.currentPeriodEnd.getTime() < Date.now();
  return lapsed ? "EXPIRED" : subscription.status;
}
export function trialDaysLeft(subscription: SubscriptionLike | null | undefined) {
  if (!subscription || subscription.status !== "TRIALING" || !subscription.currentPeriodEnd || effectiveStatus(subscription) === "EXPIRED") return null;
  return Math.max(0, Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / 86400000));
}

// PAST_DUE is deliberately not active: an unpaid renewal pauses the product until the payment goes through.
const activeStatuses = new Set(["TRIALING", "ACTIVE", "PAYMENT_WARNING"]);

export async function subscriptionContext(prisma: PrismaService, organizationId: string): Promise<SubscriptionContext> {
  const subscription = await prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const usageAggregate = await prisma.aiUsageRecord.aggregate({
    where: { organizationId, createdAt: { gte: monthStart } },
    _sum: { inputTokens: true, outputTokens: true }
  });
  const tokenQuotaMonthly = subscription?.plan?.tokenQuotaMonthly ?? 1_000_000;
  const inputTokens = usageAggregate._sum.inputTokens ?? 0;
  const outputTokens = usageAggregate._sum.outputTokens ?? 0;
  // Free-trial freeze: when the Trial plan's window lapses the organization drops to read-only
  // (EXPIRED is not an active status, so every billing gate engages) until a paid plan is purchased.
  const status = effectiveStatus(subscription);
  return {
    status,
    planKey: subscription?.plan?.key ?? "trial",
    planName: subscription?.plan?.name ?? "Trial",
    tokenQuotaMonthly,
    warningThresholdPct: subscription?.plan?.warningThresholdPct ?? 80,
    executionSlotLimit: subscription?.plan?.executionSlotLimit ?? 5,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    remainingTokens: Math.max(0, tokenQuotaMonthly - (inputTokens + outputTokens)),
    billingLocked: !activeStatuses.has(status),
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    trialDaysLeft: trialDaysLeft(subscription)
  };
}

export function assertBillingActive(context: SubscriptionContext, action: string) {
  if (context.status === "INCOMPLETE") throw new ForbiddenException(`${action} is blocked until you choose a plan and start your trial in Billing`);
  if (context.status === "EXPIRED") throw new ForbiddenException(`${action} is blocked because your free trial has ended — subscribe to a plan in Billing to continue`);
  if (context.status === "PAST_DUE") throw new ForbiddenException(`${action} is blocked because your last payment failed — update your card in Billing to resume`);
  if (context.billingLocked) throw new ForbiddenException(`${action} is blocked because the organization billing is ${context.status.toLowerCase().replace("_", " ")}`);
}

export function assertQuota(context: SubscriptionContext, estimatedTokens: number, action: string) {
  if (context.remainingTokens < estimatedTokens) {
    throw new ForbiddenException(`${action} needs an estimated ${estimatedTokens} tokens but only ${context.remainingTokens} remain in the ${context.planName} plan quota`);
  }
}

export async function recordUsage(
  prisma: PrismaService,
  record: { organizationId: string; projectId?: string; generationRunId?: string; analysisRunId?: string; provider: string; model: string; inputTokens: number; outputTokens: number; cachedTokens?: number; estimatedCostUsd?: number }
) {
  await prisma.aiUsageRecord.create({
    data: {
      organizationId: record.organizationId,
      projectId: record.projectId,
      generationRunId: record.generationRunId,
      analysisRunId: record.analysisRunId,
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedTokens: record.cachedTokens ?? 0,
      estimatedCostUsd: record.estimatedCostUsd ?? 0
    }
  });
}
