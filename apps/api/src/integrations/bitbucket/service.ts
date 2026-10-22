/**
 * Bitbucket connection lifecycle — the counterpart of the GitHub App
 * "install + select repositories" flow:
 *
 *   beginConnect          → redirect the browser to Bitbucket (login /
 *                           password confirmation + consent — Bitbucket-hosted)
 *   completeConnect       → exchange the code, store a *pending* connection
 *   listAvailableRepositories → everything the account can access (picker data)
 *   saveSelection         → "All repositories" | "Only selected repositories"
 *                           → connection becomes usable (status: connected)
 *   listRepositories      → the granted repositories, powering the Import
 *                           Repository modal (GET /v1/repository-connections/:id/repositories)
 *   disconnect            → remove the connection
 *
 * Bitbucket (unlike GitHub) does not host a repository-selection page during
 * authorization, so the selection step is hosted by this application and
 * mirrors GitHub's install UI one-to-one. Everything the user sees is the
 * same experience in the same order.
 *
 * SERVER-SIDE ONLY.
 */

import type { BitbucketConfig } from './config';
import {
  BitbucketApiError,
  BitbucketApiClient,
  type BitbucketRepository,
} from './client';
import {
  BitbucketOAuthError,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from './oauth';
import {
  BITBUCKET_STATE_TTL_MS,
  type BitbucketConnectionRecord,
  type BitbucketConnectionStore,
  type PendingAuthState,
  type PendingStateStore,
} from './store';
import * as crypto from 'node:crypto';

/** Refresh a bit before the two-hour expiry so listings never fail mid-flow. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Safety cap when aggregating repositories across workspaces. */
const MAX_AVAILABLE_REPOSITORIES = 300;

export class BitbucketServiceError extends Error {
  readonly code:
    | 'NOT_CONFIGURED'
    | 'INVALID_STATE'
    | 'OAUTH_ERROR'
    | 'NOT_FOUND'
    | 'VALIDATION'
    | 'API_ERROR';
  readonly status: number;

  constructor(
    message: string,
    options: { code: BitbucketServiceError['code']; status?: number },
  ) {
    super(message);
    this.name = 'BitbucketServiceError';
    this.code = options.code;
    this.status = options.status ?? (options.code === 'NOT_FOUND' ? 404 : 400);
  }
}

export interface ConnectOptions {
  ownerId: string;
  webOrigin: string;
  /** Relative path inside the web app to return the user to. */
  nextPath: string;
}

export interface ConnectResult {
  authorizeUrl: string;
}

export interface CompleteConnectResult {
  connectionId: string;
  account: BitbucketConnectionRecord['account'];
  webOrigin: string;
  nextPath: string;
}

export interface SaveSelectionInput {
  mode: 'all' | 'selected';
  repositoryIds?: string[];
}

export interface ConnectionStatus {
  connectionId: string;
  account: BitbucketConnectionRecord['account'];
  status: BitbucketConnectionRecord['status'];
  selection: BitbucketConnectionRecord['selection'];
  createdAt: string;
  updatedAt: string;
}

export interface ServiceDeps {
  config: BitbucketConfig;
  store: BitbucketConnectionStore;
  pendingStates: PendingStateStore;
  fetchImpl?: typeof fetch;
}

export class BitbucketService {
  private readonly config: BitbucketConfig;
  private readonly store: BitbucketConnectionStore;
  private readonly pendingStates: PendingStateStore;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: ServiceDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.pendingStates = deps.pendingStates;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // Step 1 — start the flow (browser redirect to Bitbucket)
  // -------------------------------------------------------------------------

  beginConnect(options: ConnectOptions): Promise<ConnectResult> {
    const state = crypto.randomBytes(24).toString('base64url');
    const record: PendingAuthState = {
      state,
      ownerId: options.ownerId,
      webOrigin: normalizeOrigin(options.webOrigin) ?? this.config.webAppUrl,
      nextPath: sanitizeNextPath(options.nextPath),
      expiresAt: Date.now() + BITBUCKET_STATE_TTL_MS,
    };
    return this.pendingStates.put(record).then(() => ({
      authorizeUrl: buildAuthorizeUrl(this.config, state),
    }));
  }

  // -------------------------------------------------------------------------
  // Step 2 — Bitbucket redirected back with ?code&state
  // -------------------------------------------------------------------------

  async completeConnect(params: { code: string; state: string }): Promise<CompleteConnectResult> {
    const pending = await this.pendingStates.take((params.state ?? '').trim());
    if (!pending) {
      throw new BitbucketServiceError(
        'The Bitbucket authorization state is invalid or has expired. Please start again.',
        { code: 'INVALID_STATE', status: 400 },
      );
    }

    let tokens;
    try {
      tokens = await exchangeAuthorizationCode(this.config, params.code, this.fetchImpl);
    } catch (error) {
      throw new BitbucketServiceError(error instanceof Error ? error.message : 'Bitbucket authorization failed', {
        code: 'OAUTH_ERROR',
        status: 502,
      });
    }

    const client = new BitbucketApiClient(tokens.accessToken, { fetchImpl: this.fetchImpl });
    let account;
    try {
      account = await client.getUser();
    } catch (error) {
      throw new BitbucketServiceError(error instanceof Error ? error.message : 'Could not read the Bitbucket account', {
        code: 'API_ERROR',
        status: 502,
      });
    }

    const connection = await this.store.create({
      ownerId: pending.ownerId,
      account: {
        uuid: account.uuid,
        username: account.username,
        displayName: account.displayName,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    });

    return {
      connectionId: connection.id,
      account: connection.account,
      webOrigin: pending.webOrigin,
      nextPath: pending.nextPath,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3 — repository-access picker data (all workspaces)
  // -------------------------------------------------------------------------

  async listAvailableRepositories(connectionId: string): Promise<{
    repositories: BitbucketRepository[];
    total: number;
    truncated: boolean;
  }> {
    const connection = await this.get(connectionId);
    const client = await this.authorizedClient(connection);
    const repositories: BitbucketRepository[] = [];
    const seen = new Set<string>();
    let truncated = false;

    let workspaces;
    try {
      workspaces = await client.listWorkspaces();
    } catch (error) {
      throw this.toServiceError(error);
    }

    for (const workspace of workspaces) {
      let page: BitbucketRepository[];
      try {
        page = await client.listWorkspaceRepositories(workspace.slug);
      } catch (error) {
        // Skip workspaces we cannot read instead of failing the whole list.
        if (error instanceof BitbucketApiError && error.status === 404) continue;
        throw this.toServiceError(error);
      }
      for (const repo of page) {
        if (seen.has(repo.id)) continue;
        seen.add(repo.id);
        repositories.push(repo);
        if (repositories.length >= MAX_AVAILABLE_REPOSITORIES) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }

    repositories.sort((a, b) => {
      if (a.workspace !== b.workspace) return a.workspace.localeCompare(b.workspace);
      return a.name.localeCompare(b.name);
    });
    return { repositories, total: repositories.length, truncated };
  }

  // -------------------------------------------------------------------------
  // Step 4 — save "All repositories" / "Only selected repositories"
  // -------------------------------------------------------------------------

  async saveSelection(connectionId: string, input: SaveSelectionInput): Promise<ConnectionStatus> {
    const connection = await this.get(connectionId);

    if (input.mode === 'all') {
      const updated = await this.store.update(connectionId, {
        selection: { mode: 'all' },
        status: 'connected',
      });
      return this.toStatus(updated ?? connection);
    }

    const repositoryIds = (input.repositoryIds ?? [])
      .map((id) => String(id).trim())
      .filter((id) => /^[^/\s]+\/[^/\s]+$/.test(id))
      .slice(0, MAX_AVAILABLE_REPOSITORIES);
    if (repositoryIds.length === 0) {
      throw new BitbucketServiceError(
        'Select at least one repository, or choose "All repositories".',
        { code: 'VALIDATION' },
      );
    }

    const updated = await this.store.update(connectionId, {
      selection: { mode: 'selected', repositoryIds },
      status: 'connected',
    });
    return this.toStatus(updated ?? connection);
  }

  // -------------------------------------------------------------------------
  // Step 5 — repositories for the Import Repository modal
  // -------------------------------------------------------------------------

  async listRepositories(
    connectionId: string,
    options: { search?: string; limit?: number } = {},
  ): Promise<{ repositories: BitbucketRepository[]; total: number }> {
    const connection = await this.get(connectionId);
    if (connection.status !== 'connected' || !connection.selection) {
      throw new BitbucketServiceError(
        'Repository access has not been granted for this Bitbucket connection yet.',
        { code: 'VALIDATION', status: 409 },
      );
    }

    const search = (options.search ?? '').trim().toLowerCase();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_AVAILABLE_REPOSITORIES);

    let repositories: BitbucketRepository[];
    if (connection.selection.mode === 'all') {
      const available = await this.listAvailableRepositories(connectionId);
      repositories = available.repositories;
    } else {
      const client = await this.authorizedClient(connection);
      repositories = await Promise.all(
        connection.selection.repositoryIds.map(async (id) => {
          const [workspace, slug] = splitRepositoryId(id);
          if (!workspace || !slug) return null;
          try {
            return await client.getRepository(workspace, slug);
          } catch {
            return null; // repository deleted or access revoked — skip it
          }
        }),
      ).then((list) => list.filter((repo): repo is BitbucketRepository => repo !== null));
    }

    const filtered = search
      ? repositories.filter(
          (repo) =>
            repo.fullName.toLowerCase().includes(search) ||
            repo.name.toLowerCase().includes(search) ||
            repo.workspace.toLowerCase().includes(search),
        )
      : repositories;

    return { repositories: filtered.slice(0, limit), total: filtered.length };
  }

  // -------------------------------------------------------------------------
  // Status / disconnect
  // -------------------------------------------------------------------------

  async getStatus(ownerId: string): Promise<ConnectionStatus | null> {
    const connection = await this.store.findByOwner(ownerId);
    return connection ? this.toStatus(connection) : null;
  }

  async disconnect(connectionId: string): Promise<boolean> {
    return this.store.delete(connectionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async get(connectionId: string): Promise<BitbucketConnectionRecord> {
    const connection = await this.store.get((connectionId ?? '').trim());
    if (!connection || connection.provider !== 'bitbucket') {
      throw new BitbucketServiceError('Bitbucket connection not found.', {
        code: 'NOT_FOUND',
        status: 404,
      });
    }
    return connection;
  }

  /** Returns a client with a fresh token, refreshing (and persisting) if needed. */
  private async authorizedClient(
    connection: BitbucketConnectionRecord,
  ): Promise<BitbucketApiClient> {
    let accessToken = connection.accessToken;
    const expiresAtMs = connection.tokenExpiresAt ? Date.parse(connection.tokenExpiresAt) : NaN;
    const needsRefresh =
      !Number.isFinite(expiresAtMs) || expiresAtMs - TOKEN_REFRESH_MARGIN_MS <= Date.now();
    if (needsRefresh && connection.refreshToken) {
      accessToken = await this.refreshTokens(connection);
    }
    return new BitbucketApiClient(accessToken, { fetchImpl: this.fetchImpl });
  }

  /** Refreshes the access token and persists the rotated tokens. */
  private async refreshTokens(connection: BitbucketConnectionRecord): Promise<string> {
    if (!connection.refreshToken) return connection.accessToken;
    try {
      const tokens = await refreshAccessToken(this.config, connection.refreshToken, this.fetchImpl);
      const patch = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? connection.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
      };
      await this.store.update(connection.id, patch);
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof BitbucketOAuthError) {
        throw new BitbucketServiceError(
          'The Bitbucket session has expired. Please reconnect your Bitbucket account.',
          { code: 'OAUTH_ERROR', status: 401 },
        );
      }
      throw error;
    }
  }

  private toStatus(connection: BitbucketConnectionRecord): ConnectionStatus {
    return {
      connectionId: connection.id,
      account: connection.account,
      status: connection.status,
      selection: connection.selection,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  private toServiceError(error: unknown): BitbucketServiceError {
    if (error instanceof BitbucketServiceError) return error;
    const status =
      typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : undefined;
    if (status === 401) {
      return new BitbucketServiceError(
        'The Bitbucket session has expired. Please reconnect your Bitbucket account.',
        { code: 'OAUTH_ERROR', status: 401 },
      );
    }
    return new BitbucketServiceError(
      error instanceof Error ? error.message : 'The Bitbucket API request failed.',
      { code: 'API_ERROR', status: status && status >= 500 ? 502 : 400 },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allows only `http(s)://host[:port]` origins. */
export function normalizeOrigin(origin: string): string | null {
  const trimmed = (origin ?? '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Only same-app relative paths — blocks open redirects. */
export function sanitizeNextPath(nextPath: string): string {
  const trimmed = (nextPath ?? '').trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return '/';
  }
  return trimmed;
}

/** Splits `workspace/repo-slug` into its parts. */
export function splitRepositoryId(id: string): [string | null, string | null] {
  const parts = (id ?? '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return [null, null];
  return [parts[0], parts[1]];
}
