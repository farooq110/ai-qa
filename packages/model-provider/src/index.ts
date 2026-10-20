import Ajv2020 from "ajv/dist/2020";

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
  /** Sampling temperature; omitted when the model rejects it (some reasoning models only accept their default). */
  temperature?: number;
  /** Caps the model's own output; a response cut off by this limit throws TruncatedOutputError instead of invalid JSON. */
  maxTokens?: number;
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

/** The model's own output-token cap cut the response off mid-JSON; the caller should split the input and retry smaller, not treat this as a parse failure. */
export class TruncatedOutputError extends Error {
  constructor(message = "Model output was truncated by the max-tokens limit") {
    super(message);
    this.name = "TruncatedOutputError";
  }
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
  /** Per-call timeout in ms. Calls otherwise hang forever on a dead connection. */
  timeoutMs?: number;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validatorCache = new Map<string, ReturnType<Ajv2020["compile"]>>();

function validatorFor(schemaName: string, schema: object): ReturnType<Ajv2020["compile"]> {
  const key = `${schemaName}:${JSON.stringify(schema)}`;
  let validator = validatorCache.get(key);
  if (!validator) {
    validator = ajv.compile(schema);
    validatorCache.set(key, validator);
  }
  return validator;
}

interface ChatCompletion {
  choices: Array<{ message: { content: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export class OpenAiCompatibleModelProvider implements ModelProvider {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async estimateUsage(request: StructuredGenerationRequest<object>): Promise<UsageEstimate> {
    const inputTokens = Math.ceil((request.systemPrompt.length + request.prompt.length) / 4);
    return { inputTokens, outputTokens: 2_000, estimatedCostUsd: 0 };
  }

  private async send(messages: Array<{ role: string; content: string }>, options: { temperature?: number; maxTokens?: number; responseFormat: unknown }): Promise<Response> {
    return fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
      body: JSON.stringify({
        model: this.options.model,
        messages,
        response_format: options.responseFormat,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens })
      })
    });
  }

  /** Retries a 429/5xx up to 3 times, honouring Retry-After when present; anything else is returned as-is for the caller to interpret. */
  private async sendWithRetry(messages: Array<{ role: string; content: string }>, options: { temperature?: number; maxTokens?: number; responseFormat: unknown }): Promise<Response> {
    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const response = await this.send(messages, options);
      if (response.status !== 429 && response.status < 500) return response;
      lastResponse = response;
      if (attempt === 3) return response;
      const retryAfter = response.headers.get("retry-after");
      const delayMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : 2 ** attempt * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 30_000)));
    }
    return lastResponse!;
  }

  async generateStructured<TOutput>(request: StructuredGenerationRequest<object>): Promise<StructuredGenerationResponse<TOutput>> {
    const startedAt = Date.now();
    const hasSchema = Object.keys(request.schema ?? {}).length > 0;
    const baseMessages = [{ role: "system", content: request.systemPrompt }, { role: "user", content: request.prompt }];
    const sendOptions = { temperature: request.temperature, maxTokens: request.maxTokens };

    let response: Response;
    let usedJsonObjectFallback = false;
    if (hasSchema) {
      response = await this.sendWithRetry(baseMessages, { ...sendOptions, responseFormat: { type: "json_schema", json_schema: { name: request.schemaName, schema: request.schema, strict: true } } });
      // Some models reject temperature, others reject json_schema outright: each 400 narrows down what to drop next.
      if (response.status === 400 && sendOptions.temperature !== undefined) {
        response = await this.sendWithRetry(baseMessages, { maxTokens: sendOptions.maxTokens, responseFormat: { type: "json_schema", json_schema: { name: request.schemaName, schema: request.schema, strict: true } } });
      }
      if (response.status === 400) {
        usedJsonObjectFallback = true;
        const schemaPrompt = `${request.prompt}\n\nRespond with ONLY JSON matching this schema:\n${JSON.stringify(request.schema)}`;
        response = await this.sendWithRetry([{ role: "system", content: request.systemPrompt }, { role: "user", content: schemaPrompt }], { ...sendOptions, responseFormat: { type: "json_object" } });
        if (response.status === 400 && sendOptions.temperature !== undefined) {
          response = await this.sendWithRetry([{ role: "system", content: request.systemPrompt }, { role: "user", content: schemaPrompt }], { maxTokens: sendOptions.maxTokens, responseFormat: { type: "json_object" } });
        }
      }
    } else {
      response = await this.sendWithRetry(baseMessages, { ...sendOptions, responseFormat: { type: "json_object" } });
      if (response.status === 400 && sendOptions.temperature !== undefined) {
        response = await this.sendWithRetry(baseMessages, { maxTokens: sendOptions.maxTokens, responseFormat: { type: "json_object" } });
      }
    }
    if (!response.ok) throw new Error(`Model provider request failed with status ${response.status}`);

    const payload = await response.json() as ChatCompletion;
    if (payload.choices[0]?.finish_reason === "length") throw new TruncatedOutputError();
    const usage: ModelUsage = {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
      cachedInputTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      estimatedCostUsd: 0,
      latencyMs: Date.now() - startedAt
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.choices[0]?.message.content ?? "{}");
    } catch (error) {
      if (usedJsonObjectFallback) throw error;
      // A truncated or malformed response under strict schema mode: one retry, falling back to
      // json_object with the schema spelled out in the prompt, is cheaper than failing the caller.
      const schemaPrompt = `${request.prompt}\n\nRespond with ONLY JSON matching this schema:\n${JSON.stringify(request.schema)}`;
      const retryResponse = await this.sendWithRetry([{ role: "system", content: request.systemPrompt }, { role: "user", content: schemaPrompt }], { ...sendOptions, responseFormat: { type: "json_object" } });
      if (!retryResponse.ok) throw error;
      const retryPayload = await retryResponse.json() as ChatCompletion;
      if (retryPayload.choices[0]?.finish_reason === "length") throw new TruncatedOutputError();
      parsed = JSON.parse(retryPayload.choices[0]?.message.content ?? "{}");
      usage.inputTokens += retryPayload.usage?.prompt_tokens ?? 0;
      usage.outputTokens += retryPayload.usage?.completion_tokens ?? 0;
    }

    if (hasSchema) {
      const validate = validatorFor(request.schemaName, request.schema);
      if (!validate(parsed)) {
        const errors = ajv.errorsText(validate.errors, { separator: "; " });
        const correctionPrompt = `${request.prompt}\n\nYour previous JSON response failed schema validation: ${errors}\nReturn corrected JSON matching the schema exactly.`;
        const retryResponse = await this.sendWithRetry([{ role: "system", content: request.systemPrompt }, { role: "user", content: correctionPrompt }], { ...sendOptions, responseFormat: usedJsonObjectFallback ? { type: "json_object" } : { type: "json_schema", json_schema: { name: request.schemaName, schema: request.schema, strict: true } } });
        if (retryResponse.ok) {
          const retryPayload = await retryResponse.json() as ChatCompletion;
          if (retryPayload.choices[0]?.finish_reason === "length") throw new TruncatedOutputError();
          const retryParsed = JSON.parse(retryPayload.choices[0]?.message.content ?? "{}");
          usage.inputTokens += retryPayload.usage?.prompt_tokens ?? 0;
          usage.outputTokens += retryPayload.usage?.completion_tokens ?? 0;
          if (validate(retryParsed)) parsed = retryParsed;
        }
      }
    }

    return { output: parsed as TOutput, provider: this.options.providerName, model: this.options.model, usage };
  }

  async healthCheck() {
    return { healthy: Boolean(this.options.apiKey), detail: this.options.apiKey ? undefined : "No API key configured" };
  }

  supports(_model: string, capability: string) {
    return ["test-generation", "classification", "deduplication", "failure-analysis"].includes(capability);
  }
}
