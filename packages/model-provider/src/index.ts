export interface UsageEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ModelUsage extends UsageEstimate {
  cachedInputTokens: number;
  latencyMs: number;
}

export interface StructuredGenerationRequest<TSchema extends object> {
  organizationId: string;
  projectId: string;
  jobId: string;
  capability: string;
  systemPrompt: string;
  prompt: string;
  schemaName: string;
  schema: TSchema;
}

export interface StructuredGenerationResponse<TOutput> {
  output: TOutput;
  provider: string;
  model: string;
  usage: ModelUsage;
}

export interface ModelProvider {
  estimateUsage(request: StructuredGenerationRequest<object>): Promise<UsageEstimate>;
  generateStructured<TOutput>(request: StructuredGenerationRequest<object>): Promise<StructuredGenerationResponse<TOutput>>;
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
  supports(model: string, capability: string): boolean;
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
}

export class OpenAiCompatibleModelProvider implements ModelProvider {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async estimateUsage(request: StructuredGenerationRequest<object>): Promise<UsageEstimate> {
    const inputTokens = Math.ceil((request.systemPrompt.length + request.prompt.length) / 4);
    return { inputTokens, outputTokens: 2_000, estimatedCostUsd: 0 };
  }

  async generateStructured<TOutput>(request: StructuredGenerationRequest<object>): Promise<StructuredGenerationResponse<TOutput>> {
    const startedAt = Date.now();
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: "system", content: request.systemPrompt }, { role: "user", content: request.prompt }],
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) throw new Error(`Model provider request failed with status ${response.status}`);
    const payload = await response.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
    return {
      output: JSON.parse(payload.choices[0]?.message.content ?? "{}") as TOutput,
      provider: this.options.providerName,
      model: this.options.model,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        cachedInputTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        estimatedCostUsd: 0,
        latencyMs: Date.now() - startedAt
      }
    };
  }

  async healthCheck() {
    return { healthy: Boolean(this.options.apiKey), detail: this.options.apiKey ? undefined : "No API key configured" };
  }

  supports(_model: string, capability: string) {
    return ["test-generation", "classification", "deduplication", "failure-analysis"].includes(capability);
  }
}