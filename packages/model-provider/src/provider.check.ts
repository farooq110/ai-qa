/**
 * Self-check for the Phase 4 model-provider upgrades. Run:
 * pnpm exec tsc --outDir .check-out && node .check-out/provider.check.js (delete .check-out afterwards).
 * Mocks global fetch so this needs no real API key or network call. Fails loudly if the
 * json_schema -> json_object fallback, the invalid-JSON retry, or the TruncatedOutputError regress.
 */
import { strict as assert } from "node:assert";
import { OpenAiCompatibleModelProvider, TruncatedOutputError } from "./index";

type FetchArgs = [url: string, init: { body: string }];
function completion(content: string, finishReason = "stop") {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) } as Response;
}
function badRequest() { return { ok: false, status: 400, headers: new Headers(), json: async () => ({}) } as Response; }

const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };

async function run() {
  // --- json_schema rejected (400) -> falls back to json_object with the schema spelled out in the prompt ---
  {
    const calls: FetchArgs[] = [];
    (globalThis as { fetch?: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      calls.push([url, init]);
      const body = JSON.parse(init.body);
      if (body.response_format.type === "json_schema") return badRequest();
      assert.ok(body.messages[1].content.includes(JSON.stringify(schema)), "fallback prompt embeds the schema as text");
      return completion(JSON.stringify({ name: "ok" }));
    }) as typeof fetch;
    const provider = new OpenAiCompatibleModelProvider({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m", providerName: "p" });
    const result = await provider.generateStructured<{ name: string }>({ organizationId: "o", projectId: "p", jobId: "j", capability: "c", systemPrompt: "s", prompt: "p", schemaName: "S", schema });
    assert.equal(result.output.name, "ok");
    assert.equal(calls.length, 2, "exactly one schema attempt, then one json_object fallback");
  }

  // --- invalid JSON on the first response -> one retry with json_object, which succeeds ---
  {
    let call = 0;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      call += 1;
      if (call === 1) return completion("{not valid json");
      return completion(JSON.stringify({ name: "recovered" }));
    }) as typeof fetch;
    const provider = new OpenAiCompatibleModelProvider({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m", providerName: "p" });
    const result = await provider.generateStructured<{ name: string }>({ organizationId: "o", projectId: "p", jobId: "j", capability: "c", systemPrompt: "s", prompt: "p", schemaName: "S", schema: {} });
    assert.equal(result.output.name, "recovered");
    assert.equal(call, 2, "exactly one retry after invalid JSON");
  }

  // --- schema validation failure -> one correction retry, which then validates ---
  {
    let call = 0;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      call += 1;
      if (call === 1) return completion(JSON.stringify({ wrong: "field" }));
      return completion(JSON.stringify({ name: "corrected" }));
    }) as typeof fetch;
    const provider = new OpenAiCompatibleModelProvider({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m", providerName: "p" });
    const result = await provider.generateStructured<{ name: string }>({ organizationId: "o", projectId: "p", jobId: "j", capability: "c", systemPrompt: "s", prompt: "p", schemaName: "S", schema });
    assert.equal(result.output.name, "corrected");
    assert.equal(call, 2, "exactly one correction retry after a schema-invalid response");
  }

  // --- finish_reason "length" throws TruncatedOutputError, not a JSON parse error ---
  {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => completion("{\"name\": \"cut off", "length")) as typeof fetch;
    const provider = new OpenAiCompatibleModelProvider({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m", providerName: "p" });
    await assert.rejects(
      () => provider.generateStructured({ organizationId: "o", projectId: "p", jobId: "j", capability: "c", systemPrompt: "s", prompt: "p", schemaName: "S", schema: {} }),
      TruncatedOutputError
    );
  }

  console.log("provider.check.ts: all assertions passed");
}

run().catch((error) => { console.error(error); process.exit(1); });
