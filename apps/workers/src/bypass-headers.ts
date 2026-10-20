import { createDecipheriv, createHash } from "node:crypto";
import type { BrowserContext } from "playwright";
import type { PrismaClient } from "@prisma/client";

interface StoredHeader { name: string; enc: string; iv: string; tag: string }

/** The project's access headers for protected deployments, decrypted. Empty when none are configured. */
export async function loadBypassHeaders(prisma: PrismaClient, projectId: string, secret: string): Promise<Record<string, string>> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ciBypassHeaders: true } });
  const stored = Array.isArray(project?.ciBypassHeaders) ? (project.ciBypassHeaders as unknown as StoredHeader[]) : [];
  const key = createHash("sha256").update(secret).digest();
  const headers: Record<string, string> = {};
  for (const header of stored) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"));
      decipher.setAuthTag(Buffer.from(header.tag, "base64"));
      headers[header.name] = Buffer.concat([decipher.update(Buffer.from(header.enc, "base64")), decipher.final()]).toString("utf8");
    } catch {
      console.warn(JSON.stringify({ service: "ai-qa-workers", warning: `could not decrypt access header ${header.name}` }));
    }
  }
  return headers;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Adds the headers to requests going to the target's own origin and nowhere else — the secret must never
 * reach third-party scripts or fonts the app loads.
 *
 * Playwright does not route redirect hops, and Chromium carries a header override through them, so a plain
 * `continue({ headers })` would hand the secret to whatever origin a protected page redirects to (an identity
 * provider, say). GET/HEAD requests are therefore fetched first without following redirects: a response or a
 * cross-origin redirect is returned to the browser as-is (the browser's own follow-up goes out without the
 * header), and only a same-origin redirect is re-sent with `continue`, so its hops keep the header.
 * ponytail: a same-origin redirect chain that later leaves the origin, or a non-GET request that redirects
 * cross-origin, still carries the header to that hop; per-hop control needs a proxy in front of the browser.
 */
export async function attachBypassHeaders(context: BrowserContext, targetUrl: string, headers: Record<string, string>): Promise<void> {
  if (!Object.keys(headers).length) return;
  let origin: string;
  try { origin = new URL(targetUrl).origin; } catch { return; }
  await context.route((url) => url.origin === origin, async (route) => {
    const request = route.request();
    const sent = { ...request.headers(), ...headers };
    // A body can't be replayed safely, so non-idempotent requests go straight through.
    if (request.method() !== "GET" && request.method() !== "HEAD") return route.continue({ headers: sent });
    try {
      const response = await route.fetch({ headers: sent, maxRedirects: 0 });
      const location = response.headers()["location"];
      const sameOriginRedirect = REDIRECT_STATUSES.has(response.status()) && location && new URL(location, request.url()).origin === origin;
      return sameOriginRedirect ? route.continue({ headers: sent }) : route.fulfill({ response });
    } catch {
      return route.continue({ headers: sent });
    }
  });
}
