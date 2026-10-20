import { createDecipheriv, createHash } from "node:crypto";
import { OpenAiCompatibleModelProvider, type ModelProvider } from "@ai-qa/model-provider";
import type { PrismaService } from "../database/prisma.service";

/** The enabled AI provider (admin-configured primary, else any enabled, else OPENAI_* env), or null impl when none. */
export async function resolveModelProvider(prisma: PrismaService): Promise<{ name: string; model: string; impl: ModelProvider | null }> {
  const config = await prisma.aiProviderConfig.findFirst({ where: { enabled: true, isPrimary: true } }) ?? await prisma.aiProviderConfig.findFirst({ where: { enabled: true } });
  const baseUrl = config?.baseUrl ?? (process.env.OPENAI_API_KEY ? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1" : undefined);
  const apiKey = config?.apiKeyCiphertext ? decryptKey(config.apiKeyCiphertext, config.apiKeyIv!, config.apiKeyTag!) : process.env.OPENAI_API_KEY || undefined;
  const model = config?.model ?? process.env.OPENAI_MODEL;
  if (baseUrl && apiKey && model) {
    return { name: config?.name ?? "openai", model, impl: new OpenAiCompatibleModelProvider({ baseUrl, apiKey, model, providerName: config?.name ?? "openai" }) };
  }
  return { name: "heuristic", model: "template", impl: null };
}

function decryptKey(ciphertext: string, iv: string, tag: string) {
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(process.env.JWT_SECRET ?? "").digest(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
