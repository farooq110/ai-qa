/**
 * Framework-agnostic route discovery: drives the running app like a user.
 *
 * Log in, patch the History API, then follow real links and click navigation
 * controls (sidebar groups, menu items, tabs). Every URL the app moves to is a
 * route. Works for any router (React Router, Vue Router, Angular, Svelte, hash
 * routing, server-rendered) because it never reads the router's code.
 *
 * Safety: only elements inside navigation regions are clicked, forms are never
 * submitted, and labels that suggest a state change are never clicked.
 */
import { chromium, type Page } from "playwright";
import { isAuthRoute, installHostLimiter, sessionKeeper, type SessionStore } from "@ai-qa/test-dsl";
import { MAX_RESPONSE_BYTES, summarizeResponse, type ResponseShape } from "./response-shape";
import {
  NAV_TIMEOUT_MS, SETTLE_MS, exerciseControls, capturePage, routeWithValues, strip,
  type DiscoveredPage, type DiscoveryAuth
} from "./live-discovery";

/** Exercising controls reloads the page per control: skip it once less than this much crawl time is left. */
const CONTROL_BUDGET_MS = 25_000;

export interface CrawledParam { name: string; in: "path" | "query"; samples: string[] }

export interface CrawledRoute {
  pattern: string;
  label?: string;
  /** Position in the navigation (lower = earlier in the sidebar). */
  navOrder?: number;
  sources: string[];
  samples: string[];
  params: CrawledParam[];
  page?: DiscoveredPage;
  apiCalls: string[];
  /** Opened in the real app and rendered its own content. */
  verified: boolean;
  /** Why it could not be verified, when it could not. */
  reason?: string;
}

export interface CrawlResult {
  routes: CrawledRoute[];
  login: "none" | "ok" | "failed";
  loginRateLimited?: boolean;
  /** The page or time budget ended the crawl before the queue was empty. */
  budgetHit?: boolean;
  error?: string;
}

export interface CrawlOptions {
  auth?: DiscoveryAuth;
  /** Route patterns from code, the Route Map or the user: opened after navigation discovery. */
  hints?: string[];
  /** Skip navigation discovery: open only the hints (used to re-verify one route). */
  onlyHints?: boolean;
  maxPages?: number;
  maxMs?: number;
  /** Navigation depth from the start page. */
  maxDepth?: number;
  /** Playwright storageState saved from a previous successful login - skips a fresh login when still valid. */
  sessionState?: unknown;
  /** Where the session keeper persists the context's login after each (re)login and at the end. */
  sessionStore?: SessionStore;
}

/** Labels that suggest the click changes data or session: never clicked. */
export const DENY_CLICK = /delete|remove|archive|logout|log out|sign out|signout|cancel|deactivate|disable|enable|reset|clear|pay|approve|reject|send|submit|save|create|add\b|new\b|import|export|download|upload|confirm|publish|discard|revoke|unsubscribe/i;

const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{12,}$/i,
  /^c[a-z0-9]{20,}$/,
  /^(?=.*\d)[A-Za-z0-9_-]{6,}$/
];
const FILE_LINK = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|map|woff2?|ttf|pdf|csv|xlsx?|docx?|zip|json|xml|txt)$/i;

/** `/orders/123/items/9?tab=lines` -> pattern `/orders/:id/items/:id2`, values, query keys. */
export function clusterPath(pathWithQuery: string): { pattern: string; values: Record<string, string>; query: Record<string, string> } {
  const [rawPath, rawQuery = ""] = pathWithQuery.split("?");
  const path = rawPath.split("#")[0] || "/";
  const values: Record<string, string> = {};
  let count = 0;
  const segments = path.split("/").map((segment) => {
    if (!segment || !ID_SEGMENT.some((pattern) => pattern.test(segment))) return segment;
    count += 1;
    const name = count === 1 ? "id" : `id${count}`;
    values[name] = decodeURIComponent(segment);
    return `:${name}`;
  });
  const query: Record<string, string> = {};
  new URLSearchParams(rawQuery.split("#")[0]).forEach((value, key) => { if (value.length <= 80) query[key] = value; });
  return { pattern: segments.join("/").replace(/\/+$/, "") || "/", values, query };
}

/** Init script: report every client-side navigation, whatever router caused it. */
const HISTORY_SCRIPT = `(() => {
  const report = (url) => { try { window.__crawlerNav && window.__crawlerNav(String(url)); } catch (e) {} };
  const wrap = (fn) => function (state, title, url) { if (url) { try { report(new URL(url, location.href).href); } catch (e) {} } return fn.apply(this, arguments); };
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener('popstate', () => report(location.href));
  window.addEventListener('hashchange', () => report(location.href));
})();`;

interface Candidate { path: string; text: string; order: number }
interface ClickTarget { idx: number; text: string; order: number }

/** Links and clickable navigation controls on the current page. Clickables get a `data-crawl-idx` marker. */
async function scanNavigation(page: Page): Promise<{ links: Candidate[]; clicks: ClickTarget[] }> {
  return page.evaluate((denySource) => {
    const deny = new RegExp(denySource, "i");
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const regions = Array.from(document.querySelectorAll('nav, aside, header, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], [class*="sidebar" i], [class*="navbar" i], [class*="menu" i], [id*="sidebar" i]'));
    const inRegion = (el: Element) => regions.some((region) => region.contains(el));
    const links: Array<{ path: string; text: string; order: number }> = [];
    const seen = new Set<string>();
    let order = 0;
    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const href = (anchor as HTMLAnchorElement).href;
      if (!href.startsWith(window.location.origin) || !visible(anchor)) continue;
      const url = new URL(href);
      const path = url.pathname + url.search;
      const text = clean(anchor.textContent || anchor.getAttribute("aria-label") || "");
      if (seen.has(path)) continue;
      seen.add(path);
      // Navigation-region links keep document order; other links are queued after them.
      links.push({ path, text: text.slice(0, 60), order: inRegion(anchor) ? order++ : 10_000 + links.length });
    }
    const clicks: Array<{ idx: number; text: string; order: number }> = [];
    let idx = 0;
    for (const el of Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"], summary, li, div, span'))) {
      if (clicks.length >= 20) break;
      if (!inRegion(el) || !visible(el) || el.closest("form")) continue;
      if ((el as HTMLButtonElement).type === "submit" || el.closest("a[href]") || el.querySelector("a[href], button, input")) continue;
      const style = window.getComputedStyle(el);
      const interactive = el.matches('button, [role="button"], [role="menuitem"], [role="tab"], summary') || style.cursor === "pointer";
      if (!interactive) continue;
      const text = clean(el.textContent || el.getAttribute("aria-label") || "");
      if (!text || text.length > 40 || deny.test(text)) continue;
      el.setAttribute("data-crawl-idx", String(idx));
      clicks.push({ idx, text, order: order + idx });
      idx += 1;
    }
    return { links, clicks };
  }, DENY_CLICK.source);
}

export async function crawlApp(baseUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? 60;
  let deadline = Date.now() + (options.maxMs ?? 6 * 60_000);
  const maxDepth = options.maxDepth ?? 3;
  const fixtures = options.auth?.fixtures ?? {};
  const routes = new Map<string, CrawledRoute>();
  let login: CrawlResult["login"] = "none";
  let rateLimited = false;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...(options.sessionState ? { storageState: options.sessionState as never } : {}) });
    const limiter = await installHostLimiter(context, { onRateLimited: () => { rateLimited = true; } });
    // Waiting out the app's own rate-limit window is not crawl work: it extends the deadline
    // instead of spending it, so a throttled app is crawled late rather than half-crawled.
    const waitForBudget = async () => { const started = Date.now(); await limiter.waitUntilReady(); deadline += Date.now() - started; };
    await context.addInitScript(HISTORY_SCRIPT);
    const page = await context.newPage();
    const navLog: string[] = [];
    await page.exposeFunction("__crawlerNav", (url: string) => { navLog.push(url); });
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
    context.on("response", (response) => { if (response.status() === 429) rateLimited = true; });
    let apiCalls: string[] = [];
    let apiShapes: Record<string, ResponseShape> = {};
    let pendingShapes: Array<Promise<void>> = [];
    const isApiCall = (resourceType: string, url: URL) =>
      ["fetch", "xhr"].includes(resourceType) && (url.origin === new URL(baseUrl).origin || /api/i.test(url.hostname + url.pathname));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!isApiCall(request.resourceType(), url)) return;
      const call = `${request.method()} ${clusterPath(url.pathname).pattern}`;
      if (!apiCalls.includes(call) && apiCalls.length < 15) apiCalls.push(call);
    });
    // List responses: read the body the app itself fetched (works for any auth scheme), keep only its redacted shape.
    page.on("response", (response) => {
      const request = response.request();
      const url = new URL(request.url());
      if (request.method() !== "GET" || response.status() !== 200 || !isApiCall(request.resourceType(), url)) return;
      if (!(response.headers()["content-type"] ?? "").includes("json")) return;
      const key = `GET ${clusterPath(url.pathname).pattern}`;
      if (apiShapes[key] || Object.keys(apiShapes).length >= 8) return;
      // response.body() can hang rather than reject when its request is aborted mid-navigation
      // (observed live) - race it against a timeout so one bad response never stalls the whole crawl.
      pendingShapes.push(Promise.race([
        response.body(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("response.body() timed out")), 5_000))
      ]).then((body) => {
        if (body.length > MAX_RESPONSE_BYTES) return;
        const shape = summarizeResponse(JSON.parse(body.toString("utf8")));
        if (shape && !apiShapes[key]) apiShapes[key] = shape;
      }).catch(() => undefined));
    });

    const keeper = sessionKeeper(context, { baseUrl, credentials: options.auth?.credentials, limiter, store: options.sessionStore });
    login = await keeper.login(Boolean(options.sessionState));
    let anonPage: Page | undefined;
    const anonymous = async () => {
      if (anonPage) return anonPage;
      const anonContext = await browser!.newContext({ viewport: { width: 1366, height: 900 } });
      await installHostLimiter(anonContext, { onRateLimited: () => { rateLimited = true; } });
      return (anonPage = await anonContext.newPage());
    };

    interface Task { pattern: string; concrete: string; depth: number; order: number; label?: string; source: string }
    const queue: Task[] = [];
    const queued = new Set<string>();
    let visited = 0;
    let budgetHit = false;
    /** Navigation controls already clicked this crawl: the sidebar is the same on every page, click it once. */
    const clickedLabels = new Set<string>();

    const routeFor = (pattern: string): CrawledRoute => {
      let route = routes.get(pattern);
      if (!route) { route = { pattern, sources: [], samples: [], params: [], apiCalls: [], verified: false }; routes.set(pattern, route); }
      return route;
    };

    /** Register a discovered URL; queue it once per route pattern. */
    const discover = (pathWithQuery: string, meta: { depth: number; order: number; label?: string; source: string }) => {
      if (FILE_LINK.test(pathWithQuery.split("?")[0])) return;
      const { pattern, values, query } = clusterPath(pathWithQuery);
      const route = routeFor(pattern);
      if (!route.sources.includes(meta.source)) route.sources.push(meta.source);
      if (meta.label && !route.label) route.label = meta.label;
      if (meta.order < (route.navOrder ?? Infinity) && meta.order < 10_000) route.navOrder = meta.order;
      for (const [name, value] of Object.entries(values)) {
        const param = route.params.find((entry) => entry.name === name && entry.in === "path") ?? (route.params.push({ name, in: "path", samples: [] }), route.params[route.params.length - 1]);
        if (!param.samples.includes(value) && param.samples.length < 3) param.samples.push(value);
      }
      for (const [name, value] of Object.entries(query)) {
        const param = route.params.find((entry) => entry.name === name && entry.in === "query") ?? (route.params.push({ name, in: "query", samples: [] }), route.params[route.params.length - 1]);
        if (!param.samples.includes(value) && param.samples.length < 3) param.samples.push(value);
      }
      if (route.samples.length < 3 && !route.samples.includes(pathWithQuery)) route.samples.push(pathWithQuery);
      if (queued.has(pattern)) return;
      queued.add(pattern);
      queue.push({ pattern, concrete: pathWithQuery, depth: meta.depth, order: meta.order, label: meta.label, source: meta.source });
    };

    /** Open one route (fixtures win over crawled samples), read it, and discover what it links to. */
    const visit = async (task: Task) => {
      const route = routeFor(task.pattern);
      const fixture = fixtures[task.pattern];
      const hasFixture = Boolean(fixture && Object.keys(fixture).length);
      const requested = hasFixture ? routeWithValues(task.pattern, fixture!) : task.concrete;
      const target = isAuthRoute(task.pattern) && login === "ok" ? await anonymous() : page;
      apiCalls = [];
      apiShapes = {};
      pendingShapes = [];
      navLog.length = 0;
      const queryKeys = route.params.filter((param) => param.in === "query").map((param) => param.name);
      const bareRequested = requested.split("?")[0];
      if (queryKeys.length) await waitForBudget();
      const bare = queryKeys.length && !task.pattern.includes(":") ? await capturePage(target, baseUrl, task.pattern, bareRequested) : null;
      apiCalls = [];
      apiShapes = {};
      pendingShapes = [];
      await waitForBudget();
      let record = await capturePage(target, baseUrl, task.pattern, requested, hasFixture ? fixture : undefined);
      // Logged in at the start but this page shows the login screen: the session died mid-crawl
      // (expired token, a logout on a throttled request). Log in again once and re-read the page
      // rather than recording every remaining route as "only a login screen was shown".
      // The session died mid-crawl (short-lived tokens die many times per crawl): recover it and re-read the page.
      if (record?.authGated && target === page && login === "ok") {
        const started = Date.now();
        const recovered = await keeper.recover({ loginScreen: true });
        deadline += Date.now() - started; // waiting out a login rate limit is not crawl work
        if (recovered === "restored") {
          apiCalls = [];
          apiShapes = {};
          pendingShapes = [];
          record = await capturePage(target, baseUrl, task.pattern, requested, hasFixture ? fixture : undefined);
        }
      }
      visited += 1;
      if (!record) { route.reason = "the page failed to load"; return; }
      await Promise.allSettled(pendingShapes);
      route.apiCalls = [...apiCalls];
      if (Object.keys(apiShapes).length) record.apiShapes = { ...apiShapes };
      if (bare) record.paramsVerified = !record.authGated && bare.signature !== record.signature;
      else if (hasFixture || queryKeys.length) record.paramsVerified = !record.authGated && Boolean(record.buttons.length || record.headings.length || record.inputs.length);
      route.page = strip(record);
      const useful = Boolean(record.buttons.length || record.headings.length || record.inputs.length || record.navItems.length || record.clickables.length);
      route.verified = !record.authGated && !record.redirectedTo && useful && record.paramsVerified !== false;
      route.reason = record.authGated ? "only a login screen was shown"
        : record.redirectedTo ? `the app sends this route to ${record.redirectedTo}`
        : !useful ? "the page rendered no controls"
        : record.paramsVerified === false ? "the parameter values did not change the page" : undefined;
      // A real, verified page with budget to spare: learn what its filters/search actually do
      // (real request, real response, real DOM change), not just what the unfiltered page shows.
      if (route.verified && target === page && Date.now() < deadline - CONTROL_BUDGET_MS) {
        const behaviors = await exerciseControls(page, baseUrl, 6, deadline - 5_000).catch(() => []);
        if (behaviors.length) route.page.controlBehaviors = behaviors;
      }
      if (record.authGated || task.depth >= maxDepth || target !== page) return;

      // Follow what this page links to, then click navigation controls that reveal more.
      let scan = await scanNavigation(page);
      const known = new Set<string>();
      const take = (links: Candidate[]) => {
        for (const link of links) {
          if (known.has(link.path)) continue;
          known.add(link.path);
          discover(link.path, { depth: task.depth + 1, order: link.order, label: link.text, source: "crawl" });
        }
      };
      take(scan.links);
      const startUrl = page.url();
      for (const click of scan.clicks) {
        if (Date.now() > deadline) break;
        const label = click.text.toLowerCase();
        if (clickedLabels.has(label)) continue;
        clickedLabels.add(label);
        navLog.length = 0;
        try {
          await page.locator(`[data-crawl-idx="${click.idx}"]`).first().click({ timeout: 3_000 });
          await page.waitForTimeout(600);
        } catch { continue; }
        const moved = page.url() !== startUrl ? page.url() : navLog.at(-1);
        if (moved && new URL(moved).origin === new URL(baseUrl).origin) {
          const url = new URL(moved);
          discover(url.pathname + url.search, { depth: task.depth + 1, order: click.order, label: click.text, source: "crawl" });
          if (page.url() !== startUrl) { await page.goBack({ timeout: 5_000 }).catch(() => undefined); if (page.url() !== startUrl) await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => undefined); await page.waitForTimeout(SETTLE_MS); }
        } else {
          // A group that expanded: links inside it are new.
          scan = await scanNavigation(page).catch(() => scan);
          take(scan.links);
        }
      }
    };

    // Seed: the app root, then code / user / Route Map hints (opened after navigation discovery).
    if (!options.onlyHints) discover("/", { depth: 0, order: 0, label: "Home", source: "crawl" });
    const next = () => {
      queue.sort((a, b) => Number(isAuthRoute(a.pattern)) - Number(isAuthRoute(b.pattern)) || a.order - b.order || a.depth - b.depth);
      return queue.shift();
    };
    for (let task = next(); task; task = next()) {
      if (visited >= maxPages || Date.now() > deadline) { budgetHit = true; break; }
      await visit(task);
    }

    // Hints the navigation never reached: open them directly when real values are known.
    for (const hint of options.hints ?? []) {
      if (visited >= maxPages || Date.now() > deadline) { budgetHit = true; break; }
      const key = hint.includes(":") ? hint : clusterPath(hint).pattern;
      const route = routes.get(key);
      if (route?.page || key === "*") continue;
      const entry = routeFor(key);
      if (!entry.sources.includes("hint")) entry.sources.push("hint");
      const sample = entry.samples[0] ?? (fixtures[key] ? routeWithValues(key, fixtures[key]) : undefined);
      if (key.includes(":") && !sample) { entry.reason = "needs parameter values (add them in the Route Map)"; continue; }
      await visit({ pattern: key, concrete: sample ?? key, depth: maxDepth, order: 20_000, source: "hint" });
    }

    await keeper.save();
    return { routes: [...routes.values()], login, ...(rateLimited ? { loginRateLimited: true } : {}), ...(budgetHit ? { budgetHit: true } : {}) };
  } catch (error) {
    return { routes: [...routes.values()], login, error: error instanceof Error ? error.message : "crawl failed" };
  } finally {
    try { await browser?.close(); } catch { /* already closed */ }
  }
}
