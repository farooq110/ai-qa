import type { SessionStore } from "@ai-qa/test-dsl";
import type { PrismaService } from "../database/prisma.service";
import { decryptField, encryptField } from "./crypto.util";

/**
 * The environment's saved login (Playwright storageState, encrypted on the row): loaded into a crawl's
 * context so it can skip a fresh login, and saved back by the session keeper whenever it (re)logs in.
 * Shared by analysis, route-map re-verification and the legacy generation crawl; apps/workers keeps
 * its own copy of the same format (environment.ts).
 */
export function loadSessionState(environment: { sessionStateEnc: string | null; sessionStateIv: string | null; sessionStateTag: string | null }): unknown {
  if (!environment.sessionStateEnc || !environment.sessionStateIv || !environment.sessionStateTag) return undefined;
  try {
    return JSON.parse(decryptField({ enc: environment.sessionStateEnc, iv: environment.sessionStateIv, tag: environment.sessionStateTag }, process.env.JWT_SECRET ?? ""));
  } catch {
    return undefined; // an undecryptable or corrupt session behaves as "none" - the crawl just logs in
  }
}

export function sessionStore(prisma: PrismaService, environmentId: string): SessionStore {
  return {
    async save(sessionState) {
      const { enc, iv, tag } = encryptField(JSON.stringify(sessionState), process.env.JWT_SECRET ?? "");
      await prisma.environmentProfile.update({ where: { id: environmentId }, data: { sessionStateEnc: enc, sessionStateIv: iv, sessionStateTag: tag, sessionSavedAt: new Date() } });
    }
  };
}
