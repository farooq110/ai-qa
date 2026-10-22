/**
 * HTTP layer for the Bitbucket integration — Express routes mounted under the
 * SAME `/v1/repository-connections` root the GitHub integration uses:
 *
 *   app.use('/v1/repository-connections', createBitbucketRouter())
 *
 * Routes (relative to the mount point):
 *
 *   GET  /bitbucket/connect                              → 302 to Bitbucket (login + consent)
 *   GET  /bitbucket/callback                             → OAuth callback → 302 to the
 *                                                          web app's repository-access page
 *   GET  /bitbucket/status                               → current connection (Settings page)
 *   GET  /bitbucket/connections/:id/available-repositories → everything the account
 *                                                          can access (picker data)
 *   POST /bitbucket/connections/:id/selection             → save "All repositories" /
 *                                                          "Only selected repositories"
 *   POST /bitbucket/connections/:id/disconnect            → remove the connection
 *   GET  /:connectionId/repositories?search=              → the Import Repository modal
 *                                                          contract (passes through to the
 *                                                          GitHub handler for non-Bitbucket ids)
 *
 * All business logic lives in `service.ts` (framework-free), so the routes are
 * a thin adapter you can re-create in NestJS/Fastify if your API does not use
 * Express (see docs/BITBUCKET_SETUP.md).
 */

import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { readBitbucketConfig, type BitbucketConfig } from './config';
import {
  createJsonFileConnectionStore,
  createInMemoryPendingStateStore,
  type BitbucketConnectionStore,
  type PendingStateStore,
} from './store';
import {
  BitbucketService,
  BitbucketServiceError,
  type ConnectionStatus,
} from './service';

/** Request shape after your auth middleware (if any). */
interface AuthedRequest extends Request {
  user?: { id?: string | number } | undefined;
}

export interface BitbucketRouterOptions {
  config?: BitbucketConfig;
  store?: BitbucketConnectionStore;
  pendingStates?: PendingStateStore;
  fetchImpl?: typeof fetch;
  /** Plug your auth middleware's user id here (see setBitbucketOwnerResolver). */
  resolveOwner?: (req: Request) => string | Promise<string>;
}

function defaultOwnerResolver(req: Request): string {
  const authed = req as AuthedRequest;
  const fromUser = authed.user?.id;
  if (fromUser !== undefined && fromUser !== null && String(fromUser).length > 0) {
    return String(fromUser);
  }
  const header = req.headers['x-user-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  return 'local';
}

/** Override once at API startup when your auth middleware attaches the user. */
let ownerResolver: (req: Request) => string | Promise<string> = defaultOwnerResolver;

export function setBitbucketOwnerResolver(resolver: (req: Request) => string | Promise<string>): void {
  ownerResolver = resolver;
}

/** Reads the connection owner for a request using the active resolver. */
function resolveOwner(req: Request): string | Promise<string> {
  return ownerResolver(req);
}

function firstHeader(req: Request, name: string): string {
  const value = req.headers[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
}

function inferWebOrigin(req: Request, config: BitbucketConfig): string {
  const origin = firstHeader(req, 'origin') || firstHeader(req, 'referer');
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      // fall through to the configured default
    }
  }
  return config.webAppUrl;
}

function sanitizeErrorForUrl(message: string): string {
  return encodeURIComponent(message.slice(0, 300));
}

/** Maps service errors onto JSON responses (same error shape for all routes). */
function sendError(res: Response, error: unknown): void {
  if (error instanceof BitbucketServiceError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Unexpected Bitbucket integration error.' },
  });
}

function notConfigured(res: Response): void {
  res.status(503).json({
    error: {
      code: 'BITBUCKET_NOT_CONFIGURED',
      message:
        'Bitbucket is not configured on the API. Set BITBUCKET_CLIENT_ID, BITBUCKET_CLIENT_SECRET ' +
        'and BITBUCKET_CALLBACK_URL (the OAuth consumer Key/Secret and its Callback URL) and restart the API.',
    },
  });
}

export interface BitbucketRouter {
  router: Router;
  service: BitbucketService | null;
  config: BitbucketConfig | null;
  store: BitbucketConnectionStore | null;
}

/** Builds the repositories handler once (shared by the router and the export below). */
function makeRepositoriesHandler(
  service: BitbucketService,
  store: BitbucketConnectionStore,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const connectionId =
      (req.params.connectionId as string | undefined) ?? (req.params.id as string | undefined) ?? '';
    void (async () => {
      const connection = await store.get(connectionId);
      if (!connection || connection.provider !== 'bitbucket') {
        next(); // not ours — let an existing GitHub handler process it
        return;
      }
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const result = await service.listRepositories(connectionId, {
        search,
        limit: limitParam !== undefined && Number.isFinite(limitParam) ? limitParam : undefined,
      });
      res.json({
        connectionId: connection.id,
        provider: 'bitbucket',
        selection: connection.selection,
        repositories: result.repositories,
        total: result.total,
      });
    })().catch((error: unknown) => sendError(res, error));
  };
}

/** Builds the router + service. `null` service ⇒ every route answers 503. */
export function createBitbucketRouter(options: BitbucketRouterOptions = {}): BitbucketRouter {
  const config = options.config ?? readBitbucketConfig();
  const store = options.store ?? createJsonFileConnectionStore();
  const service = config
    ? new BitbucketService({
        config,
        store,
        pendingStates: options.pendingStates ?? createInMemoryPendingStateStore(),
        fetchImpl: options.fetchImpl,
      })
    : null;

  const router = Router();

  // -------------------------------------------------------------------------
  // Step 1 — start the OAuth flow (browser redirect to Bitbucket)
  // -------------------------------------------------------------------------
  router.get('/bitbucket/connect', (req, res) => {
    if (!service || !config) return notConfigured(res);
    const nextPath = typeof req.query.next === 'string' ? req.query.next : '/';
    const webOrigin = inferWebOrigin(req, config);
    void Promise.resolve(resolveOwner(req))
      .then((ownerId) => service.beginConnect({ ownerId, webOrigin, nextPath }))
      .then(({ authorizeUrl }) => res.redirect(302, authorizeUrl))
      .catch((error: unknown) => sendError(res, error));
  });

  // -------------------------------------------------------------------------
  // Step 2 — Bitbucket redirects back with ?code&state
  // -------------------------------------------------------------------------
  router.get('/bitbucket/callback', (req, res) => {
    if (!service || !config) return notConfigured(res);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const oauthError =
      typeof req.query.error_description === 'string'
        ? req.query.error_description
        : typeof req.query.error === 'string'
          ? req.query.error
          : null;

    if (oauthError) {
      const picker = `${config.webAppUrl}${config.selectPath}?error=${sanitizeErrorForUrl(oauthError)}`;
      return res.redirect(302, picker);
    }

    void service
      .completeConnect({ code, state })
      .then((result) => {
        const picker =
          `${result.webOrigin}${config.selectPath}` +
          `?connectionId=${encodeURIComponent(result.connectionId)}` +
          `&next=${encodeURIComponent(result.nextPath)}` +
          `&account=${encodeURIComponent(result.account.displayName)}`;
        res.redirect(302, picker);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof BitbucketServiceError ? error.message : 'Bitbucket authorization failed.';
        const fallback = `${config.webAppUrl}${config.selectPath}?error=${sanitizeErrorForUrl(message)}`;
        res.redirect(302, fallback);
      });
  });

  // -------------------------------------------------------------------------
  // Settings page — current connection
  // -------------------------------------------------------------------------
  router.get('/bitbucket/status', (req, res) => {
    if (!service) return notConfigured(res);
    void Promise.resolve(resolveOwner(req))
      .then((ownerId) => service.getStatus(ownerId))
      .then((status: ConnectionStatus | null) => res.json({ connection: status }))
      .catch((error: unknown) => sendError(res, error));
  });

  // -------------------------------------------------------------------------
  // Repository-access picker data (all workspaces + current selection)
  // -------------------------------------------------------------------------
  router.get('/bitbucket/connections/:connectionId/available-repositories', (req, res) => {
    if (!service || !store) return notConfigured(res);
    const connectionId = req.params.connectionId;
    void store
      .get(connectionId)
      .then((connection) => {
        if (!connection || connection.provider !== 'bitbucket') {
          throw new BitbucketServiceError('Bitbucket connection not found.', {
            code: 'NOT_FOUND',
          });
        }
        return service.listAvailableRepositories(connectionId).then((result) =>
          res.json({
            ...result,
            account: connection.account,
            status: connection.status,
            selection: connection.selection,
          }),
        );
      })
      .catch((error: unknown) => sendError(res, error));
  });

  // -------------------------------------------------------------------------
  // Save "All repositories" / "Only selected repositories"
  // -------------------------------------------------------------------------
  router.post('/bitbucket/connections/:connectionId/selection', (req, res) => {
    if (!service) return notConfigured(res);
    const body = (req.body ?? {}) as { mode?: unknown; repositoryIds?: unknown };
    const mode = body.mode === 'all' || body.mode === 'selected' ? body.mode : null;
    if (!mode) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'Body must be {"mode":"all"} or {"mode":"selected","repositoryIds":["workspace/repo"]}' },
      });
      return;
    }
    const repositoryIds = Array.isArray(body.repositoryIds)
      ? body.repositoryIds.filter((id): id is string => typeof id === 'string')
      : undefined;
    void service
      .saveSelection(req.params.connectionId, { mode, repositoryIds })
      .then((status) => res.json({ connection: status }))
      .catch((error: unknown) => sendError(res, error));
  });

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------
  router.post('/bitbucket/connections/:connectionId/disconnect', (req, res) => {
    if (!service) return notConfigured(res);
    void service
      .disconnect(req.params.connectionId)
      .then((deleted) =>
        deleted
          ? res.json({ disconnected: true })
          : res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bitbucket connection not found.' } }),
      )
      .catch((error: unknown) => sendError(res, error));
  });

  // -------------------------------------------------------------------------
  // Import Repository modal contract.
  // Registered LAST so the literal /bitbucket/* routes above win, and calls
  // next() for non-Bitbucket connection ids so an existing GitHub handler on
  // the same mount point still receives them.
  // -------------------------------------------------------------------------
  if (service) {
    router.get('/:connectionId/repositories', makeRepositoriesHandler(service, store));
  }

  return { router, service, config, store };
}

// ---------------------------------------------------------------------------
// App-wide singleton (what you mount in your server startup)
// ---------------------------------------------------------------------------

let singleton: BitbucketRouter | null = null;

/** Returns (and memoizes) the router to mount under /v1/repository-connections. */
export function getBitbucketRouter(options?: BitbucketRouterOptions): BitbucketRouter {
  if (!singleton) singleton = createBitbucketRouter(options);
  return singleton;
}

/**
 * Standalone handler for the modal contract, for when you already serve
 * `GET /v1/repository-connections/:id/repositories` for GitHub and prefer to
 * branch by provider inside that handler instead of mounting this router's
 * version:
 *
 *   const bitbucket = getBitbucketRouter();
 *   app.get('/v1/repository-connections/:id/repositories', async (req, res, next) => {
 *     const connection = await bitbucket.store?.get(req.params.id);
 *     if (connection?.provider === 'bitbucket') return bitbucketRepositoriesHandler(req, res, next);
 *     // …existing GitHub logic…
 *   });
 */
export const bitbucketRepositoriesHandler: RequestHandler = (req, res, next) => {
  const instance = getBitbucketRouter();
  if (!instance.service || !instance.store) {
    next();
    return;
  }
  makeRepositoriesHandler(instance.service, instance.store)(req, res, next);
};
