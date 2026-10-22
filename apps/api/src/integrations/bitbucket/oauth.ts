/**
 * Bitbucket Cloud OAuth 2.0 (authorization-code grant).
 *
 * Implements the official flow documented at
 * https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/
 *
 *   1. Browser is redirected to
 *      https://bitbucket.org/site/oauth2/authorize?client_id={key}&response_type=code&state={state}&redirect_uri={callback}
 *      The user signs in with their Atlassian account (or just confirms their
 *      identity with their password if already signed in) and approves access.
 *      NOTE: Bitbucket does not accept a `scope` parameter here — the granted
 *      scopes are the Permissions configured on the OAuth consumer itself
 *      (Account: Read, Repositories: Read).
 *   2. Bitbucket redirects back to the consumer's registered Callback URL with
 *      `?code={code}&state={state}`.
 *   3. The code is exchanged for tokens via
 *      POST https://bitbucket.org/site/oauth2/access_token
 *      using HTTP Basic auth (`key:secret`) and `grant_type=authorization_code`.
 *   4. REST calls authenticate with `Authorization: Bearer {access_token}`.
 *      Access tokens expire after two hours; `grant_type=refresh_token`
 *      obtains fresh ones.
 *
 * SERVER-SIDE ONLY: handles the client secret and uses `Buffer`.
 */

import { BITBUCKET_AUTHORIZE_URL, BITBUCKET_TOKEN_URL, type BitbucketConfig } from './config';

export const BITBUCKET_TOKEN_TIMEOUT_MS = 15_000;

export class BitbucketOAuthError extends Error {
  readonly code: 'NETWORK' | 'TIMEOUT' | 'OAUTH_ERROR';
  readonly status?: number;

  constructor(message: string, options: { code: BitbucketOAuthError['code']; status?: number }) {
    super(message);
    this.name = 'BitbucketOAuthError';
    this.code = options.code;
    this.status = options.status;
  }
}

/** Token pair returned by the Bitbucket token endpoint. */
export interface BitbucketTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Scope string echoed back by Bitbucket (e.g. "account repository"). */
  scopes: string | null;
  /** ISO timestamp of expiry (tokens live two hours). */
  expiresAt: string | null;
}

/**
 * Builds the authorize URL the browser is redirected to (step 1).
 * Deliberately omits `scope`: Bitbucket resolves scopes from the consumer
 * configuration, and an unknown scope in the request is rejected.
 */
export function buildAuthorizeUrl(config: BitbucketConfig, state: string): string {
  const url = new URL(BITBUCKET_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  if (config.callbackUrl) {
    url.searchParams.set('redirect_uri', config.callbackUrl);
  }
  return url.toString();
}

interface TokenEndpointPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  scopes?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
}

/** Shared POST to the token endpoint (code exchange and refresh grant). */
async function requestTokens(
  config: BitbucketConfig,
  grant: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<BitbucketTokens> {
  // RFC 6749 §2.3.1 / Bitbucket docs: HTTP Basic auth with "key:secret".
  const authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')}`;
  const body = new URLSearchParams(grant).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BITBUCKET_TOKEN_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(BITBUCKET_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'AbortError') {
      throw new BitbucketOAuthError(
        `The Bitbucket token request timed out after ${BITBUCKET_TOKEN_TIMEOUT_MS} ms`,
        { code: 'TIMEOUT' },
      );
    }
    throw new BitbucketOAuthError(`Could not reach the Bitbucket token endpoint: ${String(error)}`, {
      code: 'NETWORK',
    });
  } finally {
    clearTimeout(timeout);
  }

  let payload: TokenEndpointPayload | null = null;
  try {
    payload = (await response.json()) as TokenEndpointPayload;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorBody = (payload ?? {}) as { error?: unknown; error_description?: unknown };
    const description =
      typeof errorBody.error_description === 'string' && errorBody.error_description.trim()
        ? errorBody.error_description.trim()
        : undefined;
    const grantError = typeof errorBody.error === 'string' ? errorBody.error : undefined;
    throw new BitbucketOAuthError(
      description ?? grantError ?? `The Bitbucket token request failed with status ${response.status}`,
      { code: 'OAUTH_ERROR', status: response.status },
    );
  }

  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : '';
  if (!accessToken) {
    throw new BitbucketOAuthError('The Bitbucket token endpoint returned no access token', {
      code: 'OAUTH_ERROR',
      status: response.status,
    });
  }

  const expiresIn =
    typeof payload?.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? payload.expires_in
      : null;

  return {
    accessToken,
    // Bitbucket issues a new refresh token on each refresh; persist it.
    refreshToken: typeof payload?.refresh_token === 'string' ? payload.refresh_token : null,
    scopes: typeof payload?.scopes === 'string' ? payload.scopes : null,
    expiresAt: expiresIn !== null ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
  };
}

/** Exchanges the authorization code for tokens (step 3). */
export function exchangeAuthorizationCode(
  config: BitbucketConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BitbucketTokens> {
  const trimmed = (code ?? '').trim();
  if (!trimmed) {
    throw new BitbucketOAuthError('The Bitbucket authorization code is missing', {
      code: 'OAUTH_ERROR',
    });
  }
  const grant: Record<string, string> = { grant_type: 'authorization_code', code: trimmed };
  if (config.callbackUrl) {
    grant.redirect_uri = config.callbackUrl;
  }
  return requestTokens(config, grant, fetchImpl);
}

/** Uses the refresh-token grant to obtain a fresh access token. */
export function refreshAccessToken(
  config: BitbucketConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BitbucketTokens> {
  const trimmed = (refreshToken ?? '').trim();
  if (!trimmed) {
    throw new BitbucketOAuthError('A Bitbucket refresh token is required', { code: 'OAUTH_ERROR' });
  }
  return requestTokens(config, { grant_type: 'refresh_token', refresh_token: trimmed }, fetchImpl);
}

/**
 * Embeds an OAuth access token into an HTTPS git clone URL using the
 * officially documented `x-token-auth` username convention:
 *
 *   git clone https://x-token-auth:{access_token}@bitbucket.org/{workspace}/{repo}.git
 */
export function withTokenCredentials(cloneUrl: string, accessToken: string): string {
  try {
    const url = new URL(cloneUrl);
    url.username = 'x-token-auth';
    url.password = accessToken;
    return url.toString();
  } catch {
    return cloneUrl;
  }
}
