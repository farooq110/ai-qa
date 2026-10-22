'use client';

/**
 * React hook powering the Import Repository modal for Bitbucket.
 *
 * Mirrors how the modal consumes the GitHub integration: repositories are
 * fetched from the API server's repository-connections endpoint —
 *
 *   GET {API}/v1/repository-connections/{connectionId}/repositories?search=…
 *
 * When `connectionId` is omitted the hook first discovers the current
 * Bitbucket connection via `GET {API}/v1/repository-connections/bitbucket/status`
 * and then lists its granted repositories.
 *
 * Single-flight + debounced search: overlapping requests are suppressed and
 * stale responses are discarded, so typing in the modal's search box never
 * produces out-of-order results.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Where the API server runs (adjust the env name to match your app). */
export function resolveApiBaseUrl(): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    process.env.NEXT_PUBLIC_SERVER_URL;
  return (fromEnv ?? 'http://localhost:4000').replace(/\/+$/, '');
}

export interface BitbucketRepositorySummary {
  /** `workspace/repo-slug` — also the value used when selecting repositories. */
  id: string;
  fullName: string;
  name: string;
  workspace: string;
  isPrivate: boolean;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string | null;
  updatedAt: string | null;
}

interface ApiErrorShape {
  error?: { code?: string; message?: string };
}

async function readApiError(response: Response): Promise<{ message: string; code: string | null }> {
  try {
    const body = (await response.json()) as ApiErrorShape;
    if (body?.error?.message) {
      return { message: body.error.message, code: body.error.code ?? null };
    }
  } catch {
    // fall through
  }
  return { message: `Request failed with status ${response.status}`, code: null };
}

export interface UseBitbucketRepositoriesResult {
  /** Discovered or provided connection id (null while discovering / when absent). */
  connectionId: string | null;
  repositories: BitbucketRepositorySummary[];
  total: number;
  loading: boolean;
  error: string | null;
  /** Error code (e.g. BITBUCKET_NOT_CONFIGURED) for special-casing in the UI. */
  errorCode: string | null;
  /** True while the connection itself is being discovered. */
  discovering: boolean;
  refresh: () => void;
}

export function useBitbucketRepositories(options: {
  connectionId?: string | null;
  search?: string;
  debounceMs?: number;
  apiBaseUrl?: string;
} = {}): UseBitbucketRepositoriesResult {
  const { connectionId, search = '', debounceMs = 300, apiBaseUrl } = options;

  const [discoveredId, setDiscoveredId] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState<boolean>(connectionId == null);
  const [repositories, setRepositories] = useState<BitbucketRepositorySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const requestIdRef = useRef(0);
  const activeConnectionId = connectionId ?? discoveredId;
  const baseUrl = apiBaseUrl ?? resolveApiBaseUrl();

  // Discover the current Bitbucket connection once when no id is provided.
  useEffect(() => {
    if (connectionId != null) return;
    let cancelled = false;
    setDiscovering(true);
    fetch(`${baseUrl}/v1/repository-connections/bitbucket/status`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error((await readApiError(response)).message);
        return (await response.json()) as { connection?: { connectionId?: string } | null };
      })
      .then((body) => {
        if (cancelled) return;
        setDiscoveredId(body.connection?.connectionId ?? null);
        setDiscovering(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load the Bitbucket connection.');
        setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, connectionId]);

  // Fetch repositories (debounced, single-flight, stale-response guarded).
  useEffect(() => {
    if (!activeConnectionId) {
      setRepositories([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    const timer = setTimeout(() => {
      setLoading(true);
      const query = new URLSearchParams({ search });
      const url =
        `${baseUrl}/v1/repository-connections/${encodeURIComponent(activeConnectionId)}` +
        `/repositories?${query.toString()}`;
      fetch(url, { credentials: 'include' })
        .then(async (response) => {
          if (!response.ok) {
            const apiError = await readApiError(response);
            const failure = new Error(apiError.message);
            (failure as Error & { code?: string | null }).code = apiError.code;
            throw failure;
          }
          return (await response.json()) as {
            repositories?: BitbucketRepositorySummary[];
            total?: number;
          };
        })
        .then((body) => {
          if (requestId !== requestIdRef.current) return; // stale response
          setRepositories(Array.isArray(body.repositories) ? body.repositories : []);
          setTotal(typeof body.total === 'number' ? body.total : 0);
          setError(null);
          setErrorCode(null);
        })
        .catch((err: unknown) => {
          if (requestId !== requestIdRef.current) return;
          setError(err instanceof Error ? err.message : 'Could not load Bitbucket repositories.');
          setErrorCode((err as { code?: string | null })?.code ?? null);
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setLoading(false);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
    };
  }, [activeConnectionId, baseUrl, search, debounceMs, refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  return {
    connectionId: activeConnectionId,
    repositories,
    total,
    loading,
    error,
    errorCode,
    discovering,
    refresh,
  };
}
