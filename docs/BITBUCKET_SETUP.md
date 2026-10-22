# Bitbucket Integration — GitHub-style connection flow

This integration reproduces, step for step, the user experience of the existing
GitHub App integration:

| Step | GitHub (existing) | Bitbucket (this integration) |
|------|-------------------|------------------------------|
| 1. Click "Connect …" | Browser redirected to GitHub | Browser redirected to Bitbucket (`/v1/repository-connections/bitbucket/connect`) |
| 2. Identity | Log in, or confirm identity with password | Log in, or confirm identity with password (Atlassian consent page with **Approve / Cancel**) |
| 3. Repository access | GitHub-hosted page: **All repositories** or **Only select repositories** | App-hosted page (same look & wording): **All repositories** or **Only selected repositories** |
| 4. Confirm | Install / Save | **Save** |
| 5. Result | Repositories available in the app | Repositories available in the app (Import Repository modal) |

The only structural difference: GitHub hosts step 3 itself for GitHub Apps,
while Bitbucket has no hosted repository picker during OAuth — so this app
hosts that step (`BitbucketRepositoryAccess`) right after Bitbucket's consent
redirect. The user sees the same screens in the same order.

---

## 1. Environment variables

Bitbucket OAuth consumers are simpler than GitHub Apps, so only three
variables are required (plus one optional):

```
BITBUCKET_CLIENT_ID=            # the OAuth consumer's "Key"
BITBUCKET_CLIENT_SECRET=        # the OAuth consumer's "Secret"
BITBUCKET_CALLBACK_URL=http://localhost:4000/v1/repository-connections/bitbucket/callback

# Optional — absolute URL of the web app; auto-detected from the browser's
# Origin header when omitted (defaults to http://localhost:3004):
BITBUCKET_WEB_URL=http://localhost:3004
```

Mapping to the GitHub variables (why fewer are needed):

| GitHub | Bitbucket equivalent | Why |
|--------|----------------------|-----|
| `GITHUB_APP_CLIENT_ID` | `BITBUCKET_CLIENT_ID` | Consumer "Key" |
| `GITHUB_APP_CLIENT_SECRET` | `BITBUCKET_CLIENT_SECRET` | Consumer "Secret" |
| `GITHUB_APP_PRIVATE_KEY` | — | Bitbucket OAuth has no JWT/private-key app authentication; the client secret over HTTPS is the credential |
| `GITHUB_APP_SLUG` | — | Bitbucket has no hosted install page to deep-link to; the repository-access step is hosted by this app |
| `GITHUB_CALLBACK_URL` | `BITBUCKET_CALLBACK_URL` | Same role |

## 2. Creating the OAuth consumer (where to get the credentials)

1. Go to **https://bitbucket.org** and select your avatar (bottom of the left
   navigation) → under **Recent workspaces** choose the workspace the app
   should connect through (a personal workspace is fine for testing).
2. Select the **Settings cog** (top navigation) → **Workspace settings**.
3. In the sidebar under **Apps and features**, click **OAuth consumers**.
4. Click **Add consumer** and fill in:
   - **Name** — e.g. `Proofline`
   - **Callback URL** — `http://localhost:4000/v1/repository-connections/bitbucket/callback`
     (in production: `https://your-api-domain/v1/repository-connections/bitbucket/callback`;
     it must match `BITBUCKET_CALLBACK_URL` exactly)
   - **URL** — optional, e.g. `http://localhost:3004`
   - **This is a private consumer** — leave checked
   - **Permissions** (expand the accordion):
     - **Account** → **Read**
     - **Repositories** → **Read** (add **Write** only if you later want the
       app to create webhooks or push)
5. Click **Save**. The consumer appears in the list — open it and copy:
   - **Key** → `BITBUCKET_CLIENT_ID`
   - **Secret** → `BITBUCKET_CLIENT_SECRET`
6. Put both in the API server's `.env` together with `BITBUCKET_CALLBACK_URL`
   and restart the API.

> Note: scopes (permissions) are configured **on the consumer** in this step.
> Bitbucket does not accept a `scope` parameter in the authorize request, so
> there is nothing to request per-connection.

## 3. What was implemented

```
apps/api/src/integrations/bitbucket/
  config.ts    env vars (mirrors the GitHub env config) + endpoint constants
  oauth.ts     authorize URL, code→token exchange, token refresh, x-token-auth clone URLs
  client.ts    REST client: /user, /user/workspaces, /repositories/{workspace}[/{slug}], branches
  store.ts     BitbucketConnectionStore interface (DB seam) + JSON-file default + CSRF state store
  service.ts   the flow itself: beginConnect → completeConnect → saveSelection → listRepositories
  routes.ts    Express routes under /v1/repository-connections (thin adapter over service.ts)

apps/web/src/
  hooks/useBitbucketRepositories.ts                      modal data hook (discovers the connection, debounced search)
  components/bitbucket/ConnectBitbucketButton.tsx        connect entry point (Settings + Import modal)
  components/bitbucket/BitbucketRepositoryAccess.tsx     the All / Only-selected picker page
  app/settings/integrations/bitbucket/page.tsx           Next.js route rendering the picker
```

API surface (all under the same `/v1/repository-connections` root the app
already uses for GitHub):

| Route | Purpose |
|-------|---------|
| `GET  /v1/repository-connections/bitbucket/connect?next=/path` | 302 → Bitbucket authorization |
| `GET  /v1/repository-connections/bitbucket/callback` | OAuth callback → 302 → picker page |
| `GET  /v1/repository-connections/bitbucket/status` | Current connection (Settings card) |
| `GET  /v1/repository-connections/bitbucket/connections/:id/available-repositories` | Picker data (all workspaces) |
| `POST /v1/repository-connections/bitbucket/connections/:id/selection` | Save All / Only-selected |
| `POST /v1/repository-connections/bitbucket/connections/:id/disconnect` | Disconnect |
| `GET  /v1/repository-connections/:id/repositories?search=` | **Import Repository modal contract** (same call the modal already makes; passes non-Bitbucket ids through to the GitHub handler) |

## 4. Wiring it into the API server

### 4.1 Express

```ts
import { getBitbucketRouter } from './integrations/bitbucket/routes';

app.use('/v1/repository-connections', getBitbucketRouter().router);
```

If your GitHub routes are mounted on the same path, mount this router
**first** — its `/repositories` handler calls `next()` for any connection id
that is not a Bitbucket connection, so GitHub requests fall through unchanged.
Alternatively keep your GitHub route and branch inside it:

```ts
import { getBitbucketRouter, bitbucketRepositoriesHandler } from './integrations/bitbucket/routes';

app.get('/v1/repository-connections/:id/repositories', async (req, res, next) => {
  const connection = await getBitbucketRouter().store?.get(req.params.id);
  if (connection?.provider === 'bitbucket') return bitbucketRepositoriesHandler(req, res, next);
  // …existing GitHub logic…
});
```

### 4.2 Authentication (per-user connections)

By default the owner is read from `req.user?.id` (fallback: `x-user-id`
header, then `'local'`). After your auth middleware:

```ts
import { setBitbucketOwnerResolver } from './integrations/bitbucket/routes';

setBitbucketOwnerResolver((req) => String(req.user.id));
```

### 4.3 Persisting connections in your database

The default store is a JSON file (`.data/bitbucket-connections.json`) so the
flow works immediately. To make Bitbucket connections live in the same place
as GitHub ones (and appear in existing "connections" listings), implement the
five-method `BitbucketConnectionStore` interface from `store.ts` against your
DB. Prisma example:

```prisma
model RepositoryConnection {
  id            String   @id @default(cuid())
  provider      String   // "github" | "bitbucket"
  ownerId       String
  // Bitbucket fields (nullable; GitHub uses its own columns):
  accountJson   String?  // { uuid, username, displayName }
  accessToken   String?
  refreshToken  String?
  tokenExpiresAt DateTime?
  scopes        String?
  status        String?  // "pending_selection" | "connected"
  selectionJson String?  // { mode: "all" } | { mode: "selected", repositoryIds: [...] }
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

```ts
const bitbucketStore: BitbucketConnectionStore = {
  async create(input) { /* prisma.repositoryConnection.create({ data: { provider: 'bitbucket', ... } }) */ },
  async get(id)       { /* findUnique, return null when provider !== 'bitbucket' */ },
  async findByOwner(o){ /*findFirst({ where: { ownerId: o, provider: 'bitbucket' }, orderBy: { updatedAt: 'desc' } })*/ },
  async update(id, p) { /* update */ },
  async delete(id)    { /* delete */ },
};

app.use('/v1/repository-connections', createBitbucketRouter({ store: bitbucketStore }).router);
```

### 4.4 Non-Express APIs

All logic lives in `service.ts` (framework-free). For NestJS expose the
service in a controller; for Fastify re-create the six handlers from
`routes.ts` (they are ~10 lines each); for a Next.js API app convert them to
App Router `route.ts` handlers. The service methods to call are exactly:
`beginConnect`, `completeConnect`, `listAvailableRepositories`,
`saveSelection`, `listRepositories`, `getStatus`, `disconnect`.

## 5. Wiring it into the web app

**Settings page** — next to the GitHub card:

```tsx
import ConnectBitbucketButton from '@/components/bitbucket/ConnectBitbucketButton';
// or a relative import: '../../components/bitbucket/ConnectBitbucketButton'

<ConnectBitbucketButton returnTo="/settings" />
```

**Import Repository modal** — same component; `returnTo` defaults to the
current path so the user lands back in the project context:

```tsx
<ConnectBitbucketButton label="Connect Bitbucket" />
```

**Listing the granted repositories** (e.g. inside the modal):

```tsx
const { repositories, loading, error, refresh } = useBitbucketRepositories({ search });
// repositories: [{ id, fullName, name, workspace, isPrivate, cloneUrl, htmlUrl, defaultBranch, updatedAt }]
```

`resolveApiBaseUrl()` (in the hook file) reads `NEXT_PUBLIC_API_URL` /
`NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_SERVER_URL` and falls back to
`http://localhost:4000` — adjust it if your env var is named differently.
The fetches send `credentials: 'include'` and rely on the CORS setup the web
app already uses for its other `/v1` calls.

## 6. Reverting the previous attempt

Delete every file delivered by the earlier zips (they were additive-only, so
deleting these restores the repo exactly):

```
docs/INTEGRATION-BITBUCKET.md

apps/web/src/lib/integrations/bitbucket/errors.ts
apps/web/src/lib/integrations/bitbucket/http.ts
apps/web/src/lib/integrations/bitbucket/index.ts
apps/web/src/lib/integrations/bitbucket/client.ts
apps/web/src/lib/integrations/bitbucket/oauth.ts
apps/web/src/lib/integrations/bitbucket/service.ts
apps/web/src/lib/integrations/bitbucket/store.ts
apps/web/src/lib/integrations/bitbucket/types.ts

apps/web/src/app/v1/integrations/bitbucket/branches/route.ts
apps/web/src/app/v1/integrations/bitbucket/callback/route.ts
apps/web/src/app/v1/integrations/bitbucket/connect/route.ts
apps/web/src/app/v1/integrations/bitbucket/disconnect/route.ts
apps/web/src/app/v1/integrations/bitbucket/import/route.ts
apps/web/src/app/v1/integrations/bitbucket/repositories/route.ts
apps/web/src/app/v1/integrations/bitbucket/status/route.ts
apps/web/src/app/v1/integrations/bitbucket/workspaces/route.ts

apps/web/src/app/v1/repository-connections/[id]/repositories/route.ts

apps/web/src/hooks/integrations/useBitbucketIntegration.ts

apps/web/src/components/integrations/bitbucket/BitbucketConnectForm.tsx
apps/web/src/components/integrations/bitbucket/BitbucketConnectionCard.tsx
apps/web/src/components/integrations/bitbucket/BitbucketLogo.tsx
apps/web/src/components/integrations/bitbucket/BitbucketRepositoryBrowser.tsx
apps/web/src/components/integrations/bitbucket/index.ts
```

Then remove the empty directories (`apps/web/src/lib/integrations`,
`apps/web/src/app/v1/integrations`, `apps/web/src/hooks/integrations`,
`apps/web/src/components/integrations`) and any local state file the old
version wrote (`.data/bitbucket-connections.json`,
`.data/bitbucket-oauth-pending.json` — paths may vary).

## 7. Troubleshooting

**"Bitbucket API request failed with status 404" when opening the Import modal.**
That was the original bug: the previous implementation registered its routes
inside the Next.js web app (port 3004) while the modal calls the API server on
port 4000 — which never had the route, and never knew the connection id. In
this implementation the routes live on the API server under the exact path
the modal already calls (`/v1/repository-connections/:id/repositories`), and
the connection is created by that same server. If you still see a 404, the
router is not mounted on the :4000 service — check section 4.1.

**A 404 on `auth.atlassian.com/gateway/api/gasv3/api/v1/metadata?…` after the redirect.**
This request is made by **Atlassian's own consent page** (their Global
Analytics Service), not by this app — it appears in the browser network tab
and is safe to ignore; the consent page itself keeps working. This
integration only talks to the officially documented endpoints
(`bitbucket.org/site/oauth2/*` and `api.bitbucket.org/2.0/*`).

**Everything returns 503 `BITBUCKET_NOT_CONFIGURED`.** The API process does not
see the three env vars — check the `.env` the :4000 service actually loads
(`pnpm --filter api dev` picks up the workspace/app `.env`), then restart it.

**"The Bitbucket session has expired. Please reconnect."** Access tokens live
two hours; the service refreshes them automatically. This message means the
refresh token itself was revoked — disconnect the connection in Settings and
connect again.

**Repository missing from the picker.** The listing shows repositories the
authorized account can access in its workspaces (capped at 300, most recently
updated first). Repositories from other users' workspaces you cannot read are
never visible to the token.
