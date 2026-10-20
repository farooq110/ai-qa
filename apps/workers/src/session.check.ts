/**
 * Offline self-check for @ai-qa/test-dsl's session module against a fake app served through
 * route.fulfill - no real environment, no real logins. Run: pnpm exec tsx src/session.check.ts
 */
import { strict as assert } from "node:assert";
import { chromium, type BrowserContext } from "playwright";
import { hasLoginScreen, isLoggedIn, sessionKeeper } from "@ai-qa/test-dsl";
import { firstPage, runRecovering } from "./step-helpers";

const BASE = "http://app.test";
const LOGIN_PAGE = `<html><body><form id="f"><input id="u" type="email"><input id="p" type="password"><button type="submit">Sign in</button><p id="err"></p></form>
  <script>document.getElementById("f").addEventListener("submit", (event) => {
    event.preventDefault();
    if (document.getElementById("u").value === "qa@test.dev" && document.getElementById("p").value === "pw") { document.cookie = "sid=ok; path=/"; location.href = "/"; }
    else document.getElementById("err").textContent = "Invalid";
  });</script></body></html>`;
// The SPA shape that fooled the old check: the shell renders first, then its own auth call fails and it redirects.
const APP_SHELL = `<html><body><nav><a href="/orders">Orders</a><button>Menu</button><input placeholder="Search"></nav>
  <script>fetch('/api/me').then((r) => { if (r.status === 401) setTimeout(() => { location.href = '/login'; }, 400); });</script></body></html>`;

async function fakeApp(context: BrowserContext) {
  await context.route(`${BASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    const loggedIn = ((await route.request().allHeaders()).cookie ?? "").includes("sid=ok");
    if (url.pathname === "/api/me") return route.fulfill({ status: loggedIn ? 200 : 401, contentType: "application/json", body: "{}" });
    if (url.pathname === "/login") return route.fulfill({ contentType: "text/html", body: LOGIN_PAGE });
    return route.fulfill({ contentType: "text/html", body: APP_SHELL });
  });
}

/** runRecovering decides retry vs hold-out vs a normal failure; checked against a scripted keeper. */
async function checkRunRecovering() {
  type Result = { status: "PASSED" | "FAILED"; error?: string; unauthorized?: boolean };
  const keeper = (answer: "alive" | "restored" | "lost") => {
    const calls: Array<{ loginScreen?: boolean; probeUrl?: string } | undefined> = [];
    return { calls, recover: async (evidence?: { loginScreen?: boolean; probeUrl?: string }) => { calls.push(evidence); return answer; } };
  };
  const runs = (...results: Result[]) => { let index = 0; const fn = async () => results[Math.min(index++, results.length - 1)]; return Object.assign(fn, { count: () => index }); };
  const loginScreen: Result = { status: "FAILED", error: "Step 1 (navigate) failed: Opened /x but the app showed a login screen" };
  const only401: Result = { status: "FAILED", error: "Step 3 failed: timeout", unauthorized: true };

  let k = keeper("alive"); let r = runs(only401);
  let out = await runRecovering(k, r, "/orders");
  assert.equal(r.count(), 1, "alive: no rerun"); assert.equal(out.sessionLost, false);
  assert.deepEqual(k.calls[0], { loginScreen: false, probeUrl: "/orders" }, "a bare 401 asks on the test's own page");

  k = keeper("restored"); r = runs(loginScreen, { status: "PASSED" });
  out = await runRecovering(k, r);
  assert.equal(r.count(), 2, "restored: one rerun"); assert.equal(out.result.status, "PASSED");
  assert.equal(k.calls[0]?.loginScreen, true, "a seen login screen skips the alive check");

  k = keeper("lost"); r = runs(loginScreen);
  out = await runRecovering(k, r);
  assert.equal(out.sessionLost, true, "lost: held out as session-lost"); assert.equal(r.count(), 1);

  k = keeper("restored"); r = runs({ status: "FAILED", error: "Step 2 (click) failed: no element" });
  out = await runRecovering(k, r);
  assert.equal(k.calls.length, 0, "a plain failure never touches the session"); assert.equal(out.sessionLost, false);

  assert.equal(firstPage({ steps: [{ action: "navigate", target: "/orders/{{id}}" }] } as never), undefined, "unresolved placeholders are not a probe URL");
}

async function run() {
  await checkRunRecovering();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await fakeApp(context);
    const page = await context.newPage();

    assert.equal(await isLoggedIn(page, BASE), false, "app shell that redirects after its 401 reads as logged out");
    await page.goto(`${BASE}/login`);
    assert.equal(await hasLoginScreen(page), true, "password + sign-in button is a login screen");
    await page.setContent(`<input type="password"><button>Save password</button>`);
    assert.equal(await hasLoginScreen(page), false, "a change-password form is not a login screen");

    const saved: unknown[] = [];
    const keeper = sessionKeeper(context, { baseUrl: BASE, credentials: { username: "qa@test.dev", password: "pw", loginUrl: "/login" }, store: { save: async (state) => { saved.push(state); } }, retryDelayMs: 10 });
    assert.equal(await keeper.login(true), "ok", "dead session -> real login");
    assert.equal(saved.length, 1, "a good login is saved");
    assert.equal(await isLoggedIn(page, BASE), true, "logged-in app shell reads as logged in");
    assert.equal(await keeper.recover(), "alive", "a 401 with the session alive is not a session loss");

    await context.clearCookies();
    assert.equal(await keeper.recover(), "restored", "a dead session mid-run is restored");

    const badContext = await browser.newContext();
    await fakeApp(badContext);
    const bad = sessionKeeper(badContext, { baseUrl: BASE, credentials: { username: "qa@test.dev", password: "wrong", loginUrl: "/login" }, attempts: 2, retryDelayMs: 10 });
    assert.equal(await bad.login(), "failed", "wrong password fails");
    assert.equal(await bad.recover(), "lost", "re-login with wrong password is lost");
    assert.equal(await bad.recover(), "lost", "and stays lost without trying again");
    console.log("session.check: ok");
  } finally {
    await browser.close();
  }
}

void run().catch((error) => { console.error(error); process.exit(1); });
