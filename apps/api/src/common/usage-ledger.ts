import type { ModelProvider, StructuredGenerationRequest, StructuredGenerationResponse } from "@ai-qa/model-provider";
import { PrismaService } from "../database/prisma.service";
import { recordUsage } from "./billing-context";

interface UsageTotal { provider: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; estimatedCostUsd: number }

/**
 * Wraps generateStructured calls and accumulates the REAL usage each one reports, instead of the
 * targets*1200 estimate generation has recorded until now. Call `run` everywhere a draft/generation
 * batch would otherwise call `impl.generateStructured` directly, then `flush` once at the end.
 */
export class UsageLedger {
  private readonly totals = new Map<string, UsageTotal>();

  async run<TOutput>(impl: ModelProvider, request: StructuredGenerationRequest<object>): Promise<StructuredGenerationResponse<TOutput>> {
    const response = await impl.generateStructured<TOutput>(request);
    const key = `${response.provider}:${response.model}`;
    const entry = this.totals.get(key) ?? { provider: response.provider, model: response.model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 };
    entry.inputTokens += response.usage.inputTokens;
    entry.outputTokens += response.usage.outputTokens;
    entry.cachedTokens += response.usage.cachedInputTokens;
    entry.estimatedCostUsd += response.usage.estimatedCostUsd;
    this.totals.set(key, entry);
    return response;
  }

  /** Accumulates usage already reported elsewhere (e.g. specs.ts calls generateStructured itself, per module, outside this ledger) instead of wrapping the call. */
  recordDirect(provider: string, model: string, inputTokens: number, outputTokens: number): void {
    const key = `${provider}:${model}`;
    const entry = this.totals.get(key) ?? { provider, model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 };
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    this.totals.set(key, entry);
  }

  get consumedTokens(): number {
    return [...this.totals.values()].reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0);
  }

  async flush(prisma: PrismaService, meta: { organizationId: string; projectId?: string; generationRunId?: string; analysisRunId?: string }): Promise<void> {
    for (const entry of this.totals.values()) await recordUsage(prisma, { ...meta, ...entry });
  }
}
