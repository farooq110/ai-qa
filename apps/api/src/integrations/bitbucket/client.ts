/**
 * Minimal Bitbucket Cloud REST API (2.0) client.
 *
 * Only the endpoints this integration needs, mirroring what the GitHub
 * integration gets from the installation/API token:
 *
 *   GET /user                              — who authorized the app
 *   GET /user/workspaces                   — workspaces the user belongs to
 *   GET /repositories/{workspace}          — repositories in a workspace
 *   GET /repositories/{workspace}/{slug}   — a single repository
 *   GET /repositories/{workspace}/{slug}/refs/branches — branches (import)
 *
 * All requests use `Authorization: Bearer {access_token}` and follow the
 * documented pagination model (page / pagelen ≤ 100 / `next` links).
 * Reference: https://developer.atlassian.com/cloud/bitbucket/rest/
 *
 * SERVER-SIDE ONLY.
 */

import { BITBUCKET_API_BASE_URL } from './config';

export const BITBUCKET_REQUEST_TIMEOUT_MS = 15_000;
export const BITBUCKET_PAGE_LEN = 50;
export const BITBUCKET_MAX_PAGES = 20;

export class BitbucketApiError extends Error {
  readonly code: 'NETWORK' | 'TIMEOUT' | 'API_ERROR';
  readonly status?: number;

  constructor(message: string, options: { code: BitbucketApiError['code']; status?: number }) {
    super(message);
    this.name = 'BitbucketApiError';
    this.code = options.code;
    this.status = options.status;
  }
}

/** Normalized repository shape used everywhere in this integration. */
export interface BitbucketRepository {
  /** Canonical id: `workspace/repo-slug` (Bitbucket `full_name`). */
  id: string;
  fullName: string;
  /** Repository slug, e.g. `proofline-recorder`. */
  name: string;
  /** Workspace slug, e.g. `acme`. */
  workspace: string;
  isPrivate: boolean;
  /** Plain HTTPS clone URL (embed the token via `withTokenCredentials`). */
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string | null;
  updatedAt: string | null;
}

interface ApiUser {
  uuid?: unknown;
  username?: unknown;
  display_name?: unknown;
  account_id?: unknown;
}

interface ApiPage<T> {
  values?: T[];
  next?: unknown;
  size?: unknown;
}

interface ApiWorkspaceAccess {
  workspace?: { uuid?: unknown; slug?: unknown; name?: unknown };
}

interface ApiRepository {
  uuid?: unknown;
  full_name?: unknown;
  slug?: unknown;
  name?: unknown;
  is_private?: unknown;
  mainbranch?: { name?: unknown } | null;
  updated_on?: unknown;
  links?: {
    html?: { href?: unknown };
    clone?: { href?: unknown; name?: unknown }[];
  };
  workspace?: { slug?: unknown; uuid?: unknown; name?: unknown };
}

interface ApiBranch {
  name?: unknown;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Extracts the `https` clone URL from a repository's links. */
function httpsCloneUrl(repo: ApiRepository): string | null {
  const clones = repo.links?.clone;
  if (!Array.isArray(clones)) return null;
  for (const clone of clones) {
    if (clone?.name === 'https' && typeof clone.href === 'string') {
      return clone.href;
    }
  }
  return null;
}

/** Maps a raw API repository object onto the normalized shape. */
export function toRepository(repo: ApiRepository): BitbucketRepository | null {
  const fullName = string(repo.full_name);
  if (!fullName) return null;
  const [workspace, ...rest] = fullName.split('/');
  const slug = string(repo.slug) ?? rest.join('/');
  if (!workspace || !slug) return null;
  return {
    id: fullName,
    fullName,
    name: string(repo.name) ?? slug,
    workspace: string(repo.workspace?.slug) ?? workspace,
    isPrivate: repo.is_private === true,
    cloneUrl: httpsCloneUrl(repo) ?? `https://bitbucket.org/${fullName}.git`,
    htmlUrl: string(repo.links?.html?.href) ?? `https://bitbucket.org/${fullName}`,
    defaultBranch: string(repo.mainbranch?.name),
    updatedAt: string(repo.updated_on),
  };
}

export class BitbucketApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly accessToken: string,
    options: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? BITBUCKET_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? BITBUCKET_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `GET /user` — the account that granted access. */
  async getUser(): Promise<{ uuid: string; username: string; displayName: string; accountId: string | null }> {
    const user = await this.request<ApiUser>('/user');
    const username = string(user.username);
    if (!username) {
      throw new BitbucketApiError('The Bitbucket API returned an account without a username', {
        code: 'API_ERROR',
      });
    }
    return {
      uuid: string(user.uuid) ?? username,
      username,
      displayName: string(user.display_name) ?? username,
      accountId: string(user.account_id),
    };
  }

  /** `GET /user/workspaces` — every workspace the user belongs to. */
  async listWorkspaces(): Promise<Array<{ slug: string; name: string; uuid: string | null }>> {
    const workspaces: Array<{ slug: string; name: string; uuid: string | null }> = [];
    let next: string | null = '/user/workspaces';
    let pages = 0;
    while (next && pages < BITBUCKET_MAX_PAGES) {
      const page = next === '/user/workspaces'
        ? await this.request<ApiPage<ApiWorkspaceAccess>>(next, { pagelen: BITBUCKET_PAGE_LEN })
        : await this.requestUrl<ApiPage<ApiWorkspaceAccess>>(next);
      for (const access of page.values ?? []) {
        const slug = string(access.workspace?.slug);
        if (!slug) continue;
        workspaces.push({
          slug,
          name: string(access.workspace?.name) ?? slug,
          uuid: string(access.workspace?.uuid),
        });
      }
      next = string(page.next);
      pages += 1;
    }
    return workspaces;
  }

  /** `GET /repositories/{workspace}` — all repositories visible in a workspace. */
  async listWorkspaceRepositories(
    workspace: string,
    options: { maxPages?: number } = {},
  ): Promise<BitbucketRepository[]> {
    const maxPages = Math.min(options.maxPages ?? BITBUCKET_MAX_PAGES, BITBUCKET_MAX_PAGES);
    const path = `/repositories/${encodeURIComponent(workspace)}`;
    const repositories: BitbucketRepository[] = [];
    let next: string | null = path;
    let pages = 0;
    while (next && pages < maxPages) {
      const page = next === path
        ? await this.request<ApiPage<ApiRepository>>(next, { pagelen: BITBUCKET_PAGE_LEN, sort: 'updated_on' })
        : await this.requestUrl<ApiPage<ApiRepository>>(next);
      for (const repo of page.values ?? []) {
        const mapped = toRepository(repo);
        if (mapped) repositories.push(mapped);
      }
      next = string(page.next);
      pages += 1;
    }
    return repositories;
  }

  /** `GET /repositories/{workspace}/{slug}` — one repository (or null when missing). */
  async getRepository(workspace: string, repoSlug: string): Promise<BitbucketRepository | null> {
    try {
      const repo = await this.request<ApiRepository>(
        `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`,
      );
      return toRepository(repo);
    } catch (error) {
      if (error instanceof BitbucketApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** `GET /repositories/{ws}/{slug}/refs/branches` — branch names (first page). */
  async listBranchNames(workspace: string, repoSlug: string): Promise<string[]> {
    const page = await this.request<ApiPage<ApiBranch>>(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/refs/branches`,
      { pagelen: BITBUCKET_PAGE_LEN },
    );
    const names: string[] = [];
    for (const branch of page.values ?? []) {
      const name = string(branch.name);
      if (name) names.push(name);
    }
    return names;
  }

  // -------------------------------------------------------------------------

  private buildUrl(path: string, params?: Record<string, string | number>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    return this.requestUrl<T>(this.buildUrl(path, params));
  }

  private async requestUrl<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.accessToken}` },
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new BitbucketApiError(
          `The Bitbucket API request timed out after ${this.timeoutMs} ms`,
          { code: 'TIMEOUT' },
        );
      }
      throw new BitbucketApiError(`Could not reach the Bitbucket API: ${String(error)}`, {
        code: 'NETWORK',
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401) {
      throw new BitbucketApiError('The Bitbucket access token is no longer valid', {
        code: 'API_ERROR',
        status: 401,
      });
    }
    if (!response.ok) {
      let message: string | null = null;
      try {
        const body = (await response.json()) as { error?: { message?: unknown } | string };
        if (typeof body.error === 'string') message = body.error;
        else if (typeof body.error?.message === 'string') message = body.error.message;
      } catch {
        message = null;
      }
      throw new BitbucketApiError(
        message ?? `The Bitbucket API request failed with status ${response.status}`,
        { code: 'API_ERROR', status: response.status },
      );
    }

    return (await response.json()) as T;
  }
}
