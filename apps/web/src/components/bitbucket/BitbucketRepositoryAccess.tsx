'use client';

/**
 * Bitbucket repository-access page — the user-facing equivalent of GitHub's
 * App installation screen ("All repositories" / "Only select repositories").
 *
 * GitHub hosts that screen itself; Bitbucket does not offer a hosted
 * repository picker during OAuth, so this app hosts the identical step right
 * after the Bitbucket consent redirect. The experience is the same, in the
 * same order:
 *
 *   1. Connect Bitbucket  → Bitbucket login / password confirmation → Approve
 *   2. THIS PAGE          → All repositories | Only selected repositories
 *   3. Save               → the selected repositories become available in the
 *                           app (Import Repository modal) and the user is
 *                           returned to where they started (`nextPath`).
 *
 * Framework-agnostic React (no UI-library imports) — style it with your own
 * design system by replacing the inline styles.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { resolveApiBaseUrl, type BitbucketRepositorySummary } from '../../hooks/useBitbucketRepositories';
import { BitbucketMark } from './ConnectBitbucketButton';

interface AvailableRepositoriesResponse {
  repositories?: BitbucketRepositorySummary[];
  total?: number;
  truncated?: boolean;
  account?: { username?: string; displayName?: string };
  status?: string;
  selection?: { mode?: string; repositoryIds?: string[] } | null;
  error?: { code?: string; message?: string };
}

export interface BitbucketRepositoryAccessProps {
  /** Connection id created by the OAuth callback (?connectionId=…). */
  connectionId: string;
  /** Where to send the user after saving (defaults to '/'). */
  nextPath?: string;
  /** Error message carried over from the OAuth callback (?error=…). */
  initialError?: string | null;
  /** Display name of the connected account, when known. */
  accountName?: string | null;
  apiBaseUrl?: string;
  /** Where to navigate after a successful save (defaults to window.location). */
  navigate?: (path: string) => void;
}

const COLORS = {
  blue: '#0052CC',
  blueLight: '#DEEBFF',
  border: '#d0d7de',
  borderStrong: '#8c959f',
  text: '#24292f',
  textMuted: '#57606a',
  background: '#f6f8fa',
  white: '#ffffff',
};

export default function BitbucketRepositoryAccess({
  connectionId,
  nextPath = '/',
  initialError = null,
  accountName = null,
  apiBaseUrl,
  navigate,
}: BitbucketRepositoryAccessProps) {
  const baseUrl = (apiBaseUrl ?? resolveApiBaseUrl()).replace(/\/+$/, '');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(initialError);
  const [configuredError, setConfiguredError] = useState(false);
  const [repositories, setRepositories] = useState<BitbucketRepositorySummary[]>([]);
  const [account, setAccount] = useState<string | null>(accountName);
  const [truncated, setTruncated] = useState(false);
  const [mode, setMode] = useState<'all' | 'selected'>('all');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const goNext = navigate ?? ((path: string) => window.location.assign(path));

  // Load everything the account can access (and any existing selection).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(
      `${baseUrl}/v1/repository-connections/bitbucket/connections/${encodeURIComponent(connectionId)}/available-repositories`,
      { credentials: 'include' },
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as AvailableRepositoriesResponse;
        if (!response.ok) {
          const code = body.error?.code ?? '';
          if (code === 'BITBUCKET_NOT_CONFIGURED') setConfiguredError(true);
          throw new Error(body.error?.message ?? `Request failed with status ${response.status}`);
        }
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setRepositories(Array.isArray(body.repositories) ? body.repositories : []);
        setTruncated(body.truncated === true);
        setAccount(body.account?.displayName ?? body.account?.username ?? account);
        if (body.selection?.mode === 'selected') {
          setMode('selected');
          setChecked(new Set(body.selection.repositoryIds ?? []));
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'Could not load your repositories.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, connectionId]);

  const visibleRepositories = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return repositories;
    return repositories.filter(
      (repo) =>
        repo.fullName.toLowerCase().includes(query) ||
        repo.name.toLowerCase().includes(query) ||
        repo.workspace.toLowerCase().includes(query),
    );
  }, [repositories, search]);

  const toggleRepository = (id: string) => {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = () => {
    if (saving || saved) return;
    if (mode === 'selected' && checked.size === 0) {
      setSaveError('Select at least one repository, or choose "All repositories".');
      return;
    }
    setSaving(true);
    setSaveError(null);
    const payload =
      mode === 'all'
        ? { mode: 'all' }
        : { mode: 'selected', repositoryIds: Array.from(checked) };
    fetch(
      `${baseUrl}/v1/repository-connections/bitbucket/connections/${encodeURIComponent(connectionId)}/selection`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      },
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        if (!response.ok) {
          throw new Error(body.error?.message ?? `Request failed with status ${response.status}`);
        }
        return body;
      })
      .then(() => {
        setSaved(true);
        setTimeout(() => goNext(nextPath), 700);
      })
      .catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : 'Could not save your selection.');
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div
      style={{
        maxWidth: 720,
        margin: '40px auto',
        padding: '0 16px',
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif",
        color: COLORS.text,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            background: COLORS.blueLight,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <BitbucketMark size={24} color={COLORS.blue} />
        </div>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Grant repository access</h1>
          <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
            {account ? (
              <>
                Connected as <strong>{account}</strong> — choose which repositories this app can
                access.
              </>
            ) : (
              'Choose which repositories this app can access.'
            )}
          </p>
        </div>
      </div>

      {/* Configuration error (env vars missing on the API) */}
      {configuredError && (
        <Card>
          <strong style={{ display: 'block', marginBottom: 8 }}>Bitbucket is not configured yet</strong>
          <ol style={{ margin: 0, paddingLeft: 20, color: COLORS.textMuted, fontSize: 14, lineHeight: 1.7 }}>
            <li>
              In Bitbucket: workspace → <em>Settings → Apps and features → OAuth consumers → Add consumer</em>.
            </li>
            <li>Callback URL: <code>{baseUrl}/v1/repository-connections/bitbucket/callback</code></li>
            <li>Permissions: Account → Read, Repositories → Read.</li>
            <li>
              Put the consumer&apos;s Key and Secret into the API&apos;s <code>.env</code> as{' '}
              <code>BITBUCKET_CLIENT_ID</code> / <code>BITBUCKET_CLIENT_SECRET</code> (plus{' '}
              <code>BITBUCKET_CALLBACK_URL</code>) and restart the API.
            </li>
          </ol>
        </Card>
      )}

      {/* Load / OAuth error */}
      {!configuredError && loadError && (
        <Card>
          <strong style={{ display: 'block', marginBottom: 8 }}>Something went wrong</strong>
          <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 14 }}>{loadError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ marginTop: 12, ...buttonStyle }}
          >
            Try again
          </button>
        </Card>
      )}

      {/* Loading */}
      {loading && !loadError && (
        <Card>
          <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 14 }}>Loading your repositories…</p>
        </Card>
      )}

      {/* Picker */}
      {!loading && !loadError && (
        <>
          {saved && (
            <div
              style={{
                border: `1px solid #1a7f37`,
                background: '#dafbe1',
                color: '#1a7f37',
                borderRadius: 6,
                padding: '10px 14px',
                marginBottom: 16,
                fontSize: 14,
              }}
            >
              Repository access saved — the repositories are now available in the app. Redirecting…
            </div>
          )}

          <Card>
            {/* Option 1 — All repositories */}
            <label
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                padding: 14,
                border: `1px solid ${mode === 'all' ? COLORS.blue : COLORS.border}`,
                borderRadius: 6,
                background: mode === 'all' ? COLORS.blueLight : COLORS.white,
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="repository-access"
                checked={mode === 'all'}
                onChange={() => setMode('all')}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong style={{ display: 'block', fontSize: 14 }}>All repositories</strong>
                <span style={{ color: COLORS.textMuted, fontSize: 13 }}>
                  Access to all current and future repositories in your Bitbucket workspaces.
                </span>
              </span>
            </label>

            {/* Option 2 — Only selected repositories */}
            <div
              style={{
                marginTop: 12,
                border: `1px solid ${mode === 'selected' ? COLORS.blue : COLORS.border}`,
                borderRadius: 6,
                background: mode === 'selected' ? COLORS.blueLight : COLORS.white,
                padding: 14,
              }}
            >
              <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="repository-access"
                  checked={mode === 'selected'}
                  onChange={() => setMode('selected')}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <strong style={{ display: 'block', fontSize: 14 }}>Only selected repositories</strong>
                  <span style={{ color: COLORS.textMuted, fontSize: 13 }}>
                    Select the repositories this app can access.
                  </span>
                </span>
              </label>

              {mode === 'selected' && (
                <div style={{ marginTop: 12 }}>
                  <input
                    type="search"
                    value={search}
                    placeholder="Search repositories…"
                    onChange={(event) => setSearch(event.target.value)}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '7px 10px',
                      borderRadius: 6,
                      border: `1px solid ${COLORS.border}`,
                      fontSize: 14,
                      marginBottom: 10,
                    }}
                  />
                  <div
                    style={{
                      maxHeight: 280,
                      overflowY: 'auto',
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 6,
                      background: COLORS.white,
                    }}
                  >
                    {visibleRepositories.length === 0 && (
                      <p
                        style={{
                          margin: 0,
                          padding: 14,
                          color: COLORS.textMuted,
                          fontSize: 13,
                          textAlign: 'center',
                        }}
                      >
                        No repositories match “{search}”.
                      </p>
                    )}
                    {visibleRepositories.map((repo) => (
                      <RepositoryRow
                        key={repo.id}
                        repo={repo}
                        checked={checked.has(repo.id)}
                        onToggle={() => toggleRepository(repo.id)}
                      />
                    ))}
                  </div>
                  <p style={{ margin: '8px 0 0', color: COLORS.textMuted, fontSize: 12 }}>
                    {checked.size === 0
                      ? 'No repositories selected yet.'
                      : `${checked.size} ${checked.size === 1 ? 'repository' : 'repositories'} selected.`}
                    {truncated ? ' (list capped at the 300 most recently updated repositories)' : ''}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 16,
                paddingTop: 14,
                borderTop: `1px solid ${COLORS.border}`,
              }}
            >
              <a
                href={nextPath}
                style={{ color: COLORS.blue, fontSize: 14, textDecoration: 'none' }}
              >
                Cancel
              </a>
              <button
                type="button"
                onClick={save}
                disabled={saving || saved}
                style={{
                  ...buttonStyle,
                  background: saved ? '#1a7f37' : COLORS.blue,
                  borderColor: saved ? '#1a7f37' : COLORS.blue,
                  color: COLORS.white,
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
              </button>
            </div>
          </Card>

          {saveError && (
            <p style={{ color: '#cf222e', fontSize: 13, marginTop: 10 }}>{saveError}</p>
          )}
        </>
      )}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: COLORS.white,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        padding: 18,
        marginBottom: 16,
        boxShadow: '0 1px 3px rgba(16, 24, 40, 0.06)',
      }}
    >
      {children}
    </div>
  );
}

const buttonStyle: CSSProperties = {
  padding: '7px 16px',
  borderRadius: 6,
  border: `1px solid ${COLORS.border}`,
  background: COLORS.white,
  color: COLORS.text,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};

function RepositoryRow({
  repo,
  checked,
  onToggle,
}: {
  repo: BitbucketRepositorySummary;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderBottom: `1px solid ${COLORS.background}`,
        cursor: 'pointer',
        fontSize: 14,
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}>
        {repo.workspace}/<strong>{repo.name}</strong>
      </span>
      {repo.isPrivate && (
        <span
          title="Private repository"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: COLORS.textMuted,
            fontSize: 12,
          }}
        >
          <svg width={12} height={12} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4 4a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 7.5v5A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-5A1.5 1.5 0 0 1 3.5 6H4V4Zm2 2h4V4a2 2 0 1 0-4 0v2Z" />
          </svg>
          private
        </span>
      )}
    </label>
  );
}
