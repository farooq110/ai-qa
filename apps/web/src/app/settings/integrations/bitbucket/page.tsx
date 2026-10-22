import BitbucketRepositoryAccess from '../../../../components/bitbucket/BitbucketRepositoryAccess';

/**
 * Repository-access page for the Bitbucket connection (the GitHub-style
 * "All repositories / Only selected repositories" step).
 *
 * The API's OAuth callback redirects here after the user approves access on
 * Bitbucket:
 *
 *   /settings/integrations/bitbucket?connectionId=…&next=/…&account=…
 *                                      …or ?error=… when something failed.
 *
 * Move this file wherever it fits your routing tree and update
 * BITBUCKET_SELECT_PATH on the API accordingly.
 */

type SearchParams = Record<string, string | string[] | undefined> | Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function BitbucketIntegrationPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const params = (await Promise.resolve(searchParams ?? {})) as Record<string, string | string[] | undefined>;
  const connectionId = firstValue(params.connectionId) ?? '';
  const nextPath = firstValue(params.next) ?? '/';
  const error = firstValue(params.error);
  const account = firstValue(params.account);

  if (!connectionId) {
    return (
      <div style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 20 }}>Grant repository access</h1>
        <p style={{ color: '#57606a' }}>
          {error ?? 'This page needs an active Bitbucket connection. Start again from Settings or the Import Repository dialog.'}
        </p>
      </div>
    );
  }

  return (
    <BitbucketRepositoryAccess
      connectionId={connectionId}
      nextPath={nextPath}
      initialError={error}
      accountName={account}
    />
  );
}
