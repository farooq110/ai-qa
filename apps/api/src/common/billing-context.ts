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
}

const activeStatuses = new Set(["TRIALING", "ACTIVE", "PAYMENT_WARNING", "PAST_DUE"]);

export async function subscriptionContext(prisma: PrismaService, organizationId: string): Promise<SubscriptionContext> {
  const subscription = await prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const usageAggregate = await prisma.aiUsageRecord.aggregate({
    where: { organizationId, createdAt: { gte: monthStart } },
    _sum: { inputTokens: true, outputTokens: true }
  });
  const status = subscription?.status ?? "TRIALING";
  const tokenQuotaMonthly = subscription?.plan?.tokenQuotaMonthly ?? 1_000_000;
  const inputTokens = usageAggregate._sum.inputTokens ?? 0;
  const outputTokens = usageAggregate._sum.outputTokens ?? 0;
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
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null
  };
}

export function assertBillingActive(context: SubscriptionContext, action: string) {
  if (context.status === "INCOMPLETE") throw new ForbiddenException(`${action} is blocked until you choose a plan and start your trial in Billing`);
  if (context.billingLocked) throw new ForbiddenException(`${action} is blocked because the organization billing is ${context.status.toLowerCase().replace("_", " ")}`);
}

export function assertQuota(context: SubscriptionContext, estimatedTokens: number, action: string) {
  if (context.remainingTokens < estimatedTokens) {
    throw new ForbiddenException(`${action} needs an estimated ${estimatedTokens} tokens but only ${context.remainingTokens} remain in the ${context.planName} plan quota`);
  }
}

export async function recordUsage(
  prisma: PrismaService,
  record: { organizationId: string; projectId?: string; generationRunId?: string; provider: string; model: string; inputTokens: number; outputTokens: number; cachedTokens?: number; estimatedCostUsd?: number }
) {
  await prisma.aiUsageRecord.create({
    data: {
      organizationId: record.organizationId,
      projectId: record.projectId,
      generationRunId: record.generationRunId,
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedTokens: record.cachedTokens ?? 0,
      estimatedCostUsd: record.estimatedCostUsd ?? 0
    }
  });
}
