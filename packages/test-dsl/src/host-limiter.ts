/**
 * Per-host request pacing + 429 backoff for a Playwright BrowserContext. Structural types only -
 * this package takes no dependency on playwright; any object with this shape works.
 *
 * Fixes a real failure mode: an app that rate-limits per IP (seen on the ERP app's /api, via
 * express-rate-limit) gets hammered by the crawler/runner/verifier, which all open many pages
 * in the same context. One pacer per host, shared across every page in the context, keeps every
 * caller under the limit instead of each page racing the others.
 */
export interface LimiterRequest {
  method(): string;
  resourceType(): string;
  url(): string;
  headers(): Record<string, string>;
}
export interface LimiterResponse {
  status(): number;
  headers(): Record<string, string>;
}
// Generic over the response type: a real Playwright Route.fulfill() requires its own concrete
// APIResponse class (many more methods than we need), not just this module's minimal
// LimiterResponse shape. Keeping fetch()/fulfill() tied to the same type parameter lets whatever
// route.fetch() actually returns flow straight into route.fulfill() without restating its shape.
export interface LimiterRoute<TResponse extends LimiterResponse = LimiterResponse> {
  request(): LimiterRequest;
  fetch(options?: { headers?: Record<string, string>; maxRedirects?: number }): Promise<TResponse>;
  fulfill(options: { response: TResponse }): Promise<void>;
  continue(options?: { headers?: Record<string, string> }): Promise<void>;
}
export interface LimiterContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridges to Playwright's own concrete APIResponse/Disposable, see LimiterRoute.
  route(pattern: string, handler: (route: LimiterRoute<any>) => void | Promise<void>): Promise<unknown>;
}

export interface HostLimiterOptions {
  /** Minimum gap between two requests to the same host. Default 120ms. */
  minIntervalMs?: number;
  /** Retries on a 429 before giving up and passing the 429 through. Default 3. */
  maxRetries?: number;
  /** Called once a request exhausts its retries still rate-limited; the caller decides what that means for the test/crawl. */
  onRateLimited?: (url: string) => void;
  /**
   * Requests to keep in hand when the server advertises its remaining budget (RateLimit-Remaining):
   * at or below this the host is paused until the window resets, BEFORE a 429 - many apps log the
   * user out on a 429 mid-page, which silently turns the rest of a crawl/run into the login screen.
   * Default max(20, 3% of RateLimit-Limit).
   */
  reserve?: number;
  /** Called when the limiter starts a pause, with how long it will hold the host. */
  onPause?: (host: string, ms: number) => void;
}

export interface HostLimiter {
  /**
   * Resolves once no host is paused - call before opening a page so it does not load half-throttled.
   * includePathPauses: also wait out route-scoped pauses (a login limiter): before a login, whose POST
   * would otherwise sit paused inside the request while the login form times out.
   */
  waitUntilReady(options?: { includePathPauses?: boolean }): Promise<void>;
}

const TRACKED_RESOURCE_TYPES = new Set(["fetch", "xhr"]);

function retryDelayMs(response: LimiterResponse, attempt: number): number {
  const headers = response.headers();
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  const reset = headers["ratelimit-reset"] ?? headers["x-ratelimit-reset"];
  if (reset && Number.isFinite(Number(reset))) return Math.max(0, Number(reset) * 1000);
  return Math.min(60_000, 2 ** attempt * 1000);
}

/** Seconds until reset as sent: draft headers send a delta, some APIs send an epoch timestamp. */
function resetMs(value: string | undefined): number | null {
  const seconds = Number(value);
  if (!value || !Number.isFinite(seconds)) return null;
  return seconds > 1e9 ? Math.max(0, seconds * 1000 - Date.now()) : seconds * 1000;
}

/** Remaining budget + time to reset from RateLimit-* / X-RateLimit-* or the combined draft-7 "RateLimit" header. */
export function advertisedBudget(headers: Record<string, string>): { remaining: number; limit: number | null; resetMs: number } | null {
  const combined = headers["ratelimit"];
  const field = (name: string) => combined?.match(new RegExp(`${name}=(\\d+)`))?.[1];
  const remaining = headers["ratelimit-remaining"] ?? headers["x-ratelimit-remaining"] ?? field("remaining");
  const reset = resetMs(headers["ratelimit-reset"] ?? headers["x-ratelimit-reset"] ?? field("reset"));
  if (remaining === undefined || !Number.isFinite(Number(remaining)) || reset === null) return null;
  const limit = Number(headers["ratelimit-limit"] ?? headers["x-ratelimit-limit"] ?? field("limit"));
  return { remaining: Number(remaining), limit: Number.isFinite(limit) ? limit : null, resetMs: reset };
}

/** Installs the limiter on every request this context makes, for the lifetime of the context. */
export async function installHostLimiter(context: LimiterContext, options: HostLimiterOptions = {}): Promise<HostLimiter> {
  const minIntervalMs = options.minIntervalMs ?? 120;
  const maxRetries = options.maxRetries ?? 3;
  const lastSentAt = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  // Host-wide pauses (the app's main budget is exhausted) vs per-path pauses (a stricter route
  // limiter - login max 10/15min, export max 30/min - is exhausted: only that route must wait).
  const pausedUntil = new Map<string, number>();
  const pathPausedUntil = new Map<string, number>();
  const mainLimit = new Map<string, number>();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const pause = (map: Map<string, number>, key: string, host: string, ms: number) => {
    const until = Date.now() + ms + 1_000; // +1s: the server's window edge, not ours
    if ((map.get(key) ?? 0) >= until) return;
    map.set(key, until);
    options.onPause?.(key === host ? host : key, until - Date.now());
  };
  /** A budget smaller than the largest one this host has advertised belongs to a route-specific limiter. */
  const pauseFor = (host: string, path: string, limit: number | null, ms: number) => {
    const routeScoped = limit !== null && limit < (mainLimit.get(host) ?? 0);
    if (routeScoped) pause(pathPausedUntil, `${host}${path}`, host, ms);
    else pause(pausedUntil, host, host, ms);
  };
  const observe = (host: string, path: string, response: LimiterResponse) => {
    const budget = advertisedBudget(response.headers());
    if (!budget) return;
    if (budget.limit !== null && budget.limit > (mainLimit.get(host) ?? 0)) mainLimit.set(host, budget.limit);
    // Proportional: a fixed reserve of 20 would treat every login response (max 10) as "exhausted".
    const reserve = options.reserve ?? (budget.limit !== null ? Math.max(1, Math.ceil(budget.limit * 0.03)) : 20);
    if (budget.remaining <= reserve) pauseFor(host, path, budget.limit, budget.resetMs);
  };

  const paced = <T>(host: string, path: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      const paused = Math.max((pausedUntil.get(host) ?? 0), (pathPausedUntil.get(`${host}${path}`) ?? 0)) - Date.now();
      if (paused > 0) await sleep(paused);
      const wait = minIntervalMs - (Date.now() - (lastSentAt.get(host) ?? 0));
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastSentAt.set(host, Date.now());
      return task();
    });
    queues.set(host, next.catch(() => undefined));
    return next;
  };

  await context.route("**/*", async (route: LimiterRoute) => {
    const request = route.request();
    if (!TRACKED_RESOURCE_TYPES.has(request.resourceType())) { await route.continue().catch(() => undefined); return; }
    const { host, pathname: path } = new URL(request.url());
    try {
      const response = await paced(host, path, async () => {
        let attempt = 0;
        let last = await route.fetch();
        observe(host, path, last);
        while (last.status() === 429 && attempt < maxRetries) {
          const delay = retryDelayMs(last, attempt);
          // Every other request under the same limiter waits too, not just this one.
          pauseFor(host, path, advertisedBudget(last.headers())?.limit ?? null, delay);
          await sleep(delay);
          attempt += 1;
          last = await route.fetch();
          observe(host, path, last);
        }
        if (last.status() === 429) options.onRateLimited?.(request.url());
        return last;
      });
      await route.fulfill({ response });
    } catch {
      // route.fetch() can throw (network error, its own timeout, a navigation that aborted the
      // request mid-flight): the intercepted request must still be resolved one way or another,
      // or the browser's own fetch/xhr call - and everything awaiting it - hangs forever.
      await route.continue().catch(() => undefined);
    }
  });

  return {
    async waitUntilReady(waitOptions) {
      for (;;) {
        const pauses = waitOptions?.includePathPauses ? [...pausedUntil.values(), ...pathPausedUntil.values()] : [...pausedUntil.values()];
        const longest = Math.max(0, ...pauses.map((until) => until - Date.now()));
        if (longest <= 0) return;
        await sleep(longest);
      }
    }
  };
}
