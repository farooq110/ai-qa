/**
 * The environment a run targets: its decrypted login credentials, route fixtures and saved session.
 * ponytail: the AES-GCM field format mirrors apps/api's crypto.util (workers cannot import apps/api);
 * lift both into a shared package if a third copy appears.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { LoginCredentials, SessionStore } from "@ai-qa/test-dsl";

const key = () => createHash("sha256").update(process.env.JWT_SECRET ?? "").digest();

function decrypt(enc: string, iv: string, tag: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8");
}

function encrypt(plain: string): { enc: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { enc: enc.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

/** The project's environment for this URL, else its default one. */
function findEnvironment(prisma: PrismaClient, projectId: string, environmentUrl: string) {
  return prisma.environmentProfile.findFirst({ where: { projectId, url: environmentUrl } })
    .then((match) => match ?? prisma.environmentProfile.findFirst({ where: { projectId, isDefault: true } }));
}

export async function loadCredentials(prisma: PrismaClient, projectId: string, environmentUrl: string): Promise<LoginCredentials | null> {
  try {
    // A credential-bearing environment: URL match first, then any on the project (a second env can
    // share the same URL without credentials).
    const withCreds = { usernameEnc: { not: null }, passwordEnc: { not: null } };
    const environment = await prisma.environmentProfile.findFirst({ where: { projectId, url: environmentUrl, ...withCreds } })
      ?? await prisma.environmentProfile.findFirst({ where: { projectId, ...withCreds } });
    if (!environment?.usernameEnc || !environment.usernameIv || !environment.usernameTag || !environment.passwordEnc || !environment.passwordIv || !environment.passwordTag) return null;
    return {
      username: decrypt(environment.usernameEnc, environment.usernameIv, environment.usernameTag),
      password: decrypt(environment.passwordEnc, environment.passwordIv, environment.passwordTag),
      loginUrl: environment.loginUrl,
      loginTrigger: environment.loginTriggerSelector,
      usernameSelector: environment.usernameSelector,
      passwordSelector: environment.passwordSelector,
      submitSelector: environment.submitSelector
    };
  } catch {
    return null;
  }
}

/** Decrypted Playwright storageState from the environment's last successful login, if any. */
export async function loadSessionState(prisma: PrismaClient, projectId: string, environmentUrl: string): Promise<unknown> {
  try {
    const environment = await findEnvironment(prisma, projectId, environmentUrl);
    if (!environment?.sessionStateEnc || !environment.sessionStateIv || !environment.sessionStateTag) return undefined;
    return JSON.parse(decrypt(environment.sessionStateEnc, environment.sessionStateIv, environment.sessionStateTag));
  } catch {
    return undefined; // an undecryptable or corrupt session behaves as "none" - the run just logs in
  }
}

/** Saves a context's session on the environment so the next run (or the API's crawl) can skip login. */
export function sessionStore(prisma: PrismaClient, projectId: string, environmentUrl: string): SessionStore {
  return {
    async save(sessionState) {
      const environment = await findEnvironment(prisma, projectId, environmentUrl);
      if (!environment) return;
      const { enc, iv, tag } = encrypt(JSON.stringify(sessionState));
      await prisma.environmentProfile.update({ where: { id: environment.id }, data: { sessionStateEnc: enc, sessionStateIv: iv, sessionStateTag: tag, sessionSavedAt: new Date() } });
    }
  };
}

/**
 * Route parameter values saved on the environment ({ "/route": { name: value } }) flattened to
 * {{name}} variables. ponytail: flat namespace - two routes sharing a parameter name with different
 * values collide (last wins); key by route if that ever matters.
 */
export async function loadFixtureVars(prisma: PrismaClient, projectId: string, environmentUrl: string): Promise<Map<string, string>> {
  const vars = new Map<string, string>();
  try {
    const environment = await findEnvironment(prisma, projectId, environmentUrl);
    const fixtures = (environment?.routeFixtures ?? {}) as Record<string, Record<string, string>>;
    for (const params of Object.values(fixtures)) for (const [name, value] of Object.entries(params)) vars.set(name, String(value));
  } catch { /* fixtures are optional */ }
  return vars;
}
