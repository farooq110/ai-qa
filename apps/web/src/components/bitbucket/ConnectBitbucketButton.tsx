'use client';

/**
 * "Connect Bitbucket" button — the single entry point for both touch points:
 *
 *   1. the Settings page connection card (next to the GitHub one), and
 *   2. the in-project "Import Repository" modal.
 *
 * Clicking it navigates the browser to the API server:
 *
 *   GET {API}/v1/repository-connections/bitbucket/connect?next={currentPath}
 *
 * which redirects to Bitbucket, where the user logs in (or confirms their
 * identity with their password) and approves access — exactly like the GitHub
 * flow. After the callback the user lands on the repository-access page
 * ("All repositories" / "Only selected repositories") and is returned to
 * `returnTo` (defaults to the current browser path) once they save.
 */

import { resolveApiBaseUrl } from '../../hooks/useBitbucketRepositories';
import type { CSSProperties } from 'react';

export interface ConnectBitbucketButtonProps {
  /** Relative path inside the web app to return to afterwards. */
  returnTo?: string;
  /** API base URL override (defaults to resolveApiBaseUrl()). */
  apiBaseUrl?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
}

export function BitbucketMark({ size = 18, color = '#2684FF' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill={color}>
      <path d="M1.5 2.25a.75.75 0 0 0 0 1.5h2.45l1.2 12.9a1.125 1.125 0 0 0 1.12 1.02h11.1a1.125 1.125 0 0 0 1.11-.94l1.68-8.4a.75.75 0 0 0-.74-.9H8.06l-.28-3a1.125 1.125 0 0 0-1.12-1.02H1.5Zm7.6 14.06a.9375.9375 0 1 1-1.87 0 .9375.9375 0 0 1 1.87 0Zm7.34 0a.9375.9375 0 1 1-1.87 0 .9375.9375 0 0 1 1.87 0Zm1.66-11.06-1.4 7H8.02l-.8-8.62a.1875.1875 0 0 1 .19-.2h9.7a.375.375 0 0 1 .37.3l.22 1.52Z" />
    </svg>
  );
}

export default function ConnectBitbucketButton({
  returnTo,
  apiBaseUrl,
  label = 'Connect Bitbucket',
  disabled = false,
  className,
  style,
  onClick,
}: ConnectBitbucketButtonProps) {
  const handleClick = () => {
    onClick?.();
    const nextPath =
      returnTo ??
      (typeof window !== 'undefined'
        ? `${window.location.pathname}${window.location.search}`
        : '/');
    const base = (apiBaseUrl ?? resolveApiBaseUrl()).replace(/\/+$/, '');
    window.location.assign(
      `${base}/v1/repository-connections/bitbucket/connect?next=${encodeURIComponent(nextPath)}`,
    );
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 16px',
        borderRadius: 6,
        border: '1px solid #d0d7de',
        background: '#ffffff',
        color: '#24292f',
        fontSize: 14,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
    >
      <BitbucketMark />
      {label}
    </button>
  );
}
