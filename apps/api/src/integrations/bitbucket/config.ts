/**
 * Bitbucket Cloud integration — environment configuration.
 *
 * This mirrors how the GitHub App integration is configured
 * (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET / GITHUB_CALLBACK_URL …)
 * but with the variables a Bitbucket OAuth consumer actually provides.
 *
 * Mapping (GitHub → Bitbucket):
 *
 *   GITHUB_APP_CLIENT_ID      → BITBUCKET_CLIENT_ID       (the consumer's "Key")
 *   GITHUB_APP_CLIENT_SECRET  → BITBUCKET_CLIENT_SECRET   (the consumer's "Secret")
 *   GITHUB_APP_PRIVATE_KEY    → (not needed — Bitbucket OAuth consumers
 *                                authenticate with the client secret over HTTPS;
 *                                there is no JWT/private-key app authentication)
 *   GITHUB_APP_SLUG           → (not needed — Bitbucket has no hosted
 *                                "install app" page to deep-link to; the
 *                                repository-access step is hosted by this app)
 *   GITHUB_CALLBACK_URL       → BITBUCKET_CALLBACK_URL
 *
 * SERVER-SIDE ONLY.
 */

/** Base path of the Bitbucket Cloud REST API (version 2.0). */
export const BITBUCKET_API_BASE_URL = 'https://api.bitbucket.org/2.0';

/** OAuth 2.0 authorization endpoint (browser redirect target). */
export const BITBUCKET_AUTHORIZE_URL = 'https://bitbucket.org/site/oauth2/authorize';

/** OAuth 2.0 token endpoint (code exchange + refresh, HTTP Basic auth). */
export const BITBUCKET_TOKEN_URL = 'https://bitbucket.org/site/oauth2/access_token';

/** Where the web app hosts the repository-access (All / Only selected) page. */
export const BITBUCKET_DEFAULT_SELECT_PATH = '/settings/integrations/bitbucket';

/** Fallback web origin when it cannot be inferred from the request. */
export const BITBUCKET_DEFAULT_WEB_URL = 'http://localhost:3004';

/** Validity window of the OAuth `state` (CSRF) value. */
export const BITBUCKET_STATE_TTL_MS = 10 * 60 * 1000;

export interface BitbucketConfig {
  /** OAuth consumer "Key" (Atlassian labels it Key, not client id). */
  clientId: string;
  /** OAuth consumer "Secret". */
  clientSecret: string;
  /**
   * Callback URL registered on the OAuth consumer, e.g.
   * http://localhost:4000/v1/repository-connections/bitbucket/callback
   */
  callbackUrl: string;
  /** Absolute URL of the web app (defaults to request origin, then localhost:3004). */
  webAppUrl: string;
  /** Route in the web app that renders the repository-access picker. */
  selectPath: string;
}

/**
 * Reads the Bitbucket configuration from the environment.
 * Returns `null` when the integration is not configured yet —
 * callers surface this as HTTP 503 `BITBUCKET_NOT_CONFIGURED`.
 */
export function readBitbucketConfig(env: NodeJS.ProcessEnv = process.env): BitbucketConfig | null {
  const clientId = (env.BITBUCKET_CLIENT_ID ?? '').trim();
  const clientSecret = (env.BITBUCKET_CLIENT_SECRET ?? '').trim();
  const callbackUrl = (env.BITBUCKET_CALLBACK_URL ?? '').trim();
  if (!clientId || !clientSecret) {
    return null;
  }
  return {
    clientId,
    clientSecret,
    callbackUrl,
    webAppUrl: (env.BITBUCKET_WEB_URL ?? '').trim() || BITBUCKET_DEFAULT_WEB_URL,
    selectPath: (env.BITBUCKET_SELECT_PATH ?? '').trim() || BITBUCKET_DEFAULT_SELECT_PATH,
  };
}

/** Convenience predicate for health/status endpoints. */
export function isBitbucketConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBitbucketConfig(env) !== null;
}
