/**
 * One login/session implementation for every browser that acts as the user: the API's crawlers and
 * the workers' verifier and plan runner. Structural types only (like host-limiter): any Playwright
 * Page/BrowserContext fits, and this package takes no dependency on playwright.
 *
 * Why it exists: three drifted copies of this logic produced the "stale login" bugs - a dead session
 * reported as logged in (the SPA shell renders before its auth check fails), re-login caps that a
 * 15-minute token exhausts mid-run, and no recovery at all in some callers.
 */
import { isAuthRoute } from "./index";
import type { HostLimiter } from "./host-limiter";

export interface LoginCredentials {
  username: string;
  password: string;
  loginUrl?: string | null;
  /** Selector of the control that opens a login popup, when the form is not on the page by default. */
  loginTrigger?: string | null;
  usernameSelector?: string | null;
  passwordSelector?: string | null;
  submitSelector?: string | null;
}

export interface SessionLocator {
  first(): SessionLocator;
  locator(selector: string): SessionLocator;
  or(other: SessionLocator): SessionLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  waitFor(options: { state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  press(key: string): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  getByRole(role: "button" | "link", options: { name: RegExp }): SessionLocator;
}

export interface SessionPage {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load" | "networkidle"; timeout?: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): SessionLocator;
  getByRole(role: "button" | "link", options: { name: RegExp }): SessionLocator;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state: "networkidle", options?: { timeout?: number }): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

export interface SessionContext {
  newPage(): Promise<SessionPage>;
  storageState(): Promise<unknown>;
}

/** Where a context's logged-in storageState survives between runs (encrypted on the environment row). */
export interface SessionStore {
  save(state: unknown): Promise<void>;
}

/**
 * A visible password field together with a log-in/sign-in button: the app is asking the user to log
 * in. Evaluated as a string - tsx compiles named inner functions to __name(...), which does not exist
 * in the page, so a function body here would throw and silently read as "no login screen".
 */
const LOGIN_SCREEN_SCRIPT = `(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const password = Array.from(document.querySelectorAll('input[type="password"]')).some(shown);
  if (!password) return false;
  return Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
    .some((el) => shown(el) && /log ?in|sign ?in/i.test(el.textContent || el.value || el.getAttribute("aria-label") || ""));
})()`;

export async function hasLoginScreen(page: Pick<SessionPage, "evaluate">): Promise<boolean> {
  return page.evaluate<boolean>(LOGIN_SCREEN_SCRIPT).catch(() => false);
}

/** The page is the app's login screen: on an auth route, or showing the login form. */
export async function onLoginScreen(page: Pick<SessionPage, "evaluate" | "url">): Promise<boolean> {
  return isAuthRoute(page.url()) || hasLoginScreen(page);
}

/**
 * Whether the context's current session (cookies + storage) is still logged in. Waits for the network
 * to settle first: an SPA renders its shell, then its auth check (a 401 and a failed refresh) sends it
 * to the login screen - checking before that reads a dead session as alive.
 */
export async function isLoggedIn(page: SessionPage, baseUrl: string): Promise<boolean> {
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    return !(await onLoginScreen(page));
  } catch {
    return false;
  }
}

/**
 * Generic login: open the login URL (or the site), open the popup via the trigger when the form is not
 * already there, fill the visible username + password, submit, and report whether the form went away.
 */
export async function genericLogin(page: SessionPage, baseUrl: string, credentials: LoginCredentials): Promise<boolean> {
  try {
    await page.goto(new URL(credentials.loginUrl?.trim() || "/", baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    const password = page.locator(credentials.passwordSelector?.trim() || 'input[type="password"]').first();
    if (!(await password.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false))) {
      // The trigger is either a selector or just the button's visible text ("Product Rack").
      const raw = credentials.loginTrigger?.trim() ?? "";
      const trigger = raw
        ? page.locator(/[#.[\]=>:]/.test(raw) ? raw : `text="${raw.replace(/"/g, '\\"')}"`).first()
        : page.getByRole("button", { name: /log ?in|sign ?in/i }).or(page.getByRole("link", { name: /log ?in|sign ?in/i })).first();
      await trigger.click({ timeout: 5_000 }).catch(() => undefined);
      await password.waitFor({ state: "visible", timeout: 15_000 });
    }
    // Let the form finish initializing: a phone widget filled before it sets its country code sends a
    // malformed number (Tailorcarte: 404 "user not found" on a correct login).
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    const form = password.locator("xpath=ancestor::form[1]");
    const scope = (await form.count()) ? form : page;
    const username = credentials.usernameSelector?.trim()
      ? page.locator(credentials.usernameSelector.trim()).first()
      : scope.locator('input[autocomplete="username"]:visible, input[type="email"]:visible, input[type="tel"]:visible, input[name*="user" i]:visible, input[name*="email" i]:visible, input[name*="phone" i]:visible, input[name*="mobile" i]:visible, input[type="text"]:visible').first();
    await username.fill(credentials.username, { timeout: 16_000 });
    await username.press("Tab").catch(() => undefined); // many apps validate on blur
    await password.fill(credentials.password, { timeout: 16_000 });
    const submit = credentials.submitSelector?.trim()
      ? page.locator(credentials.submitSelector.trim()).first()
      : scope.getByRole("button", { name: /log ?in|sign ?in|submit|continue/i }).first();
    if (await submit.count()) await submit.click({ timeout: 16_000 });
    else await password.press("Enter");
    await password.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    return !(await password.isVisible().catch(() => false));
  } catch {
    return false;
  }
}

export type LoginStatus = "none" | "ok" | "failed";

export interface SessionKeeperOptions {
  baseUrl: string;
  credentials?: LoginCredentials | null;
  /** Logins wait out the app's rate-limit windows (host-wide and the login route's own) before each attempt. */
  limiter?: HostLimiter;
  store?: SessionStore;
  /** Login attempts per login(); apps throttle logins (ERP: 10 per 15 min). Default 3. */
  attempts?: number;
  /** Pause between failed attempts when the limiter reported no window to wait for. Default 60s. */
  retryDelayMs?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface SessionKeeper {
  /** Establish the session: reuse the context's loaded state when it is still logged in, else log in. */
  login(reuse?: boolean): Promise<LoginStatus>;
  /**
   * Call when a page showed the login screen, or the app answered 401, mid-run.
   * - evidence.loginScreen: a protected page literally showed the login screen - log in again directly.
   * - otherwise (only a 401): first check whether the session is really gone, on evidence.probeUrl (the
   *   failing test's own page; the site root may be public and read as logged in) or the base URL.
   * "alive" = it was not the session (a real 401, a test bug - do not retry), "restored" = logged in
   * again (retry), "lost" = re-login failed; sticky for the rest of the run, since credentials or a
   * lockout will not get better by retrying every test.
   */
  recover(evidence?: { loginScreen?: boolean; probeUrl?: string }): Promise<"alive" | "restored" | "lost">;
  /** Persist the context's current session (call at the end: a re-login replaced the one loaded at start). */
  save(): Promise<void>;
  status(): LoginStatus;
}

export function sessionKeeper(context: SessionContext, options: SessionKeeperOptions): SessionKeeper {
  const { baseUrl, credentials, limiter, store, log } = options;
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 60_000;
  let status: LoginStatus = credentials ? "failed" : "none";
  let gaveUp = false;

  const withScratch = async <T>(task: (page: SessionPage) => Promise<T>): Promise<T> => {
    const page = await context.newPage();
    try { return await task(page); } finally { await page.close().catch(() => undefined); }
  };
  const save = async () => {
    if (status !== "ok" || !store) return;
    await store.save(await context.storageState()).catch(() => undefined);
  };
  const freshLogin = (page: SessionPage) => async (): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      await limiter?.waitUntilReady({ includePathPauses: true });
      if (await genericLogin(page, baseUrl, credentials!)) return true;
      log?.("login attempt failed", { attempt: attempt + 1, of: attempts });
    }
    return false;
  };

  return {
    status: () => status,
    save,
    async login(reuse = true) {
      if (!credentials) return (status = "none");
      const ok = await withScratch(async (page) => (reuse && await isLoggedIn(page, baseUrl)) || freshLogin(page)());
      status = ok ? "ok" : "failed";
      log?.(ok ? "session ready" : "login failed");
      if (ok) await save();
      return status;
    },
    async recover(evidence) {
      if (!credentials || gaveUp) return "lost";
      const probe = evidence?.probeUrl ? new URL(evidence.probeUrl, baseUrl).toString() : baseUrl;
      const outcome = await withScratch(async (page) =>
        !evidence?.loginScreen && await isLoggedIn(page, probe) ? "alive" as const : (await freshLogin(page)()) ? "restored" as const : "lost" as const);
      if (outcome === "lost") { gaveUp = true; status = "failed"; log?.("re-login failed - giving up for this run"); return outcome; }
      status = "ok";
      if (outcome === "restored") { log?.("session restored"); await save(); }
      return outcome;
    }
  };
}
