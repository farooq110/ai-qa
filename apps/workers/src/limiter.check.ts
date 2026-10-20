/**
 * Self-check for installHostLimiter: a local server answers 429 with Retry-After once, then 200.
 * Run: pnpm exec tsx src/limiter.check.ts
 */
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { advertisedBudget, installHostLimiter } from "@ai-qa/test-dsl";

async function run() {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (hits === 1) { res.writeHead(429, { "Retry-After": "1" }); res.end("rate limited"); return; }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await installHostLimiter(context, { minIntervalMs: 0, maxRetries: 3 });
  const page = await context.newPage();
  await page.goto("about:blank");

  const started = Date.now();
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }, `http://127.0.0.1:${port}/`);
  const elapsedMs = Date.now() - started;

  assert.equal(result.status, 200, "the limiter should retry past the 429 and return the eventual 200");
  assert.equal(result.body, "ok");
  assert.equal(hits, 2, "exactly one 429 then one 200 - the limiter must not retry past the first success");
  assert.ok(elapsedMs >= 900, `should have waited out the ~1s Retry-After before retrying (waited ${elapsedMs}ms)`);

  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // Proactive pause: the server says 0 requests left, resetting in 1s - the NEXT request must wait
  // for the reset instead of being sent into a 429, and waitUntilReady() must hold until then too.
  let budgetHits = 0;
  const budgetServer = createServer((req, res) => {
    budgetHits += 1;
    res.writeHead(200, { "content-type": "text/plain", "RateLimit-Limit": "100", "RateLimit-Remaining": budgetHits === 1 ? "0" : "99", "RateLimit-Reset": "1" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => budgetServer.listen(0, resolve));
  const budgetPort = (budgetServer.address() as { port: number }).port;
  const browser2 = await chromium.launch({ headless: true });
  const context2 = await browser2.newContext();
  let paused = 0;
  const limiter = await installHostLimiter(context2, { minIntervalMs: 0, reserve: 0, onPause: () => { paused += 1; } });
  const page2 = await context2.newPage();
  await page2.goto("about:blank");
  const url = `http://127.0.0.1:${budgetPort}/`;
  await page2.evaluate(async (target) => { await fetch(target); }, url);
  const readyStarted = Date.now();
  await limiter.waitUntilReady();
  assert.ok(Date.now() - readyStarted >= 900, "waitUntilReady holds until the advertised reset");
  assert.equal(paused, 1, "one pause started from the advertised budget, with no 429 involved");
  await page2.evaluate(async (target) => { await fetch(target); }, url);
  assert.equal(budgetHits, 2);
  await browser2.close();
  await new Promise<void>((resolve) => budgetServer.close(() => resolve()));

  // A route-specific limiter (login: max 10) at 0 left pauses only that route, never the whole host.
  const scopedServer = createServer((req, res) => {
    const login = req.url?.startsWith("/login");
    res.writeHead(200, { "RateLimit-Limit": login ? "10" : "20000", "RateLimit-Remaining": login ? "0" : "19000", "RateLimit-Reset": "30" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => scopedServer.listen(0, resolve));
  const scopedPort = (scopedServer.address() as { port: number }).port;
  const browser3 = await chromium.launch({ headless: true });
  const context3 = await browser3.newContext();
  const scopedLimiter = await installHostLimiter(context3, { minIntervalMs: 0 });
  const page3 = await context3.newPage();
  await page3.goto("about:blank");
  const base = `http://127.0.0.1:${scopedPort}`;
  await page3.evaluate(async (target) => { await fetch(`${target}/data`); await fetch(`${target}/login`, { method: "POST" }); }, base);
  const scopedStarted = Date.now();
  await scopedLimiter.waitUntilReady();
  await page3.evaluate(async (target) => { await fetch(`${target}/data`); }, base);
  assert.ok(Date.now() - scopedStarted < 2_000, "an exhausted login limiter must not hold the rest of the host for its 30s window");
  // ...but a login about to be attempted must wait it out (the paused login POST would otherwise outlive the login form's timeout).
  const loginWait = await Promise.race([scopedLimiter.waitUntilReady({ includePathPauses: true }).then(() => "ready"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 1_500))]);
  assert.equal(loginWait, "waiting", "includePathPauses holds while the login route is paused");
  await browser3.close();
  await new Promise<void>((resolve) => scopedServer.close(() => resolve()));

  assert.deepEqual(advertisedBudget({ ratelimit: "limit=100, remaining=3, reset=40" }), { remaining: 3, limit: 100, resetMs: 40_000 }, "combined draft-7 header parses");
  assert.equal(advertisedBudget({}), null);

  console.log("limiter.check: ok");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
