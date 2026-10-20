# Handoff: test generation accuracy work

Branch: `feat/provider-connection`. Date: 2026-10-13.
Audience: engineers continuing the test-generation accuracy work.

## 1. Why this work exists

A manager reported that generated tests hallucinate: the AI invented buttons and steps for pages it never saw (for example a protected Summary page behind a login), and it ignored pages that need URL parameters (`modelCode`, `projectId`). A larger app also produced mostly auth and navigation tests.

Goal: tests a QA team can trust. Success metric we agreed on but have **not measured yet**: first-run pass rate of generated tests on a clean environment.

## 2. Where the code stands

- Commit `ff9a924` contains phase 1 (grounded generation) and the live step log.
- Everything after that is **uncommitted** in the working tree: background analysis, crawler, Route Map, adapters, weighting, module canonicalization, UI fixes. `git status` lists it. Review and commit before building on it.
- Local DB (`localhost:5433`) is managed with `prisma db push`, not migrations. Migration folders exist for other environments:
  `20261013090000_environment_route_fixtures`, `20261013120000_execution_item_step_log`, `20261013150000_project_routes`.
- Typecheck is clean for `apps/api`, `apps/workers`, `apps/web`, `packages/test-dsl`, `packages/model-provider`.
- One self-check exists: `apps/api/src/analysis/grounding.check.ts`.
  Run: `cd apps/api && pnpm exec tsc -p tsconfig.json --outDir .check-out && node .check-out/analysis/grounding.check.js; rm -rf .check-out`.
- Nothing has been run end to end against a real app after the crawler rewrite (see section 6).

## 3. What was built

### Generation pipeline (accuracy)
| Piece | Where | What it does |
| --- | --- | --- |
| Logged-in discovery | `apps/api/src/analysis/live-discovery.ts` | Generic login (login URL, trigger, selectors from the environment), then crawls with that session. |
| Auth-gate and redirect detection | `capturePage` in `live-discovery.ts` | Pages showing a login screen are `authGated`; routes the app redirects away from get `redirectedTo`. Both are skipped for generation. |
| Auth routes crawled logged out | `isAuthRoute` in `packages/test-dsl/src/index.ts` | `/login`, `/forgot-password`, `/reset-password/:t`, and similar are read in a clean context. |
| Route parameters | `extractRouteParams` in `analyzer.ts`, `routeFixtures` on `EnvironmentProfile` | Names from code, values from user fixtures or crawl samples. A page is verified by comparing it with and without the values. Tests use `{{name}}` placeholders; the worker fills them (`loadFixtureVars`). |
| Grounding gate | `groundDraft` in `generations.service.ts` | Every click/fill/select target must exist on the live page or in code labels, otherwise the draft is rejected. The system writes the opening navigate and sets `confidence`. |
| Prompt and model call | `providerCandidates` | All collected data is sent; zero tests is allowed; per-page `maxTests`; temperature 0 (retried without it if the model rejects it). |
| Per-test session isolation | `needsAnonymousSession` (test-dsl), `processPlan` in `worker.ts` | Auth-page tests and tests using `{{username}}`/`{{password}}` get a fresh logged-out context each. |
| Runner fixes | `worker.ts` | Generic `genericLogin` (legacy FABRIC/DECORATION wizard kept as fallback), `fill` resolves label/placeholder/accessible name/attribute, credentials resolved in values. |
| Live step log | `ExecutionPlanItem.stepLog`, `runTestCase`, `executions/page.tsx` | Per-step status, duration, how the element was found (`matchedBy`, `loose`), written as the test runs. UI refreshes the open run every 2s while live. |

### Discovery and coverage
| Piece | Where |
| --- | --- |
| Background analysis | `POST /analysis` queues a run; `AnalysisProcessor` (BullMQ worker inside the API) executes it; UI polls (`waitForAnalysis` in `apps/web/src/lib/api.ts`). Runs left `RUNNING` by a restart are marked failed at startup. |
| Framework-independent crawler | `apps/api/src/analysis/crawler.ts`: History API interception, navigation BFS, click on nav controls with a deny-list, URL clustering (`/orders/123` to `/orders/:id`), budget 60 pages / 6 min. |
| Route Map | `ProjectRoute` table; `apps/api/src/route-map/*` (list, add, update, verify); `RouteMapModal` opened from the **Routes** button on a project card. |
| Code adapters (hints only) | `apps/api/src/analysis/adapters/`: file-based (Next, Nuxt, SvelteKit, Remix, Astro), React Router AST, model fallback on router files. Hints are verified by the crawl. |
| Assertion evidence | `ControlBehavior` also records `kept` (matching text still shown) and `responseCall`; `isNoiseText` (test-dsl) drops counters/glued labels from diffs; `dedupeSharedControls` drops app-shell controls seen on >=80% of pages. `groundDraft` rejects noise/sentence asserts, visible-vs-hidden contradictions and unobserved before-text asserts, and adds an observed visible proof after hidden-only checks. The generation prompt requires `basis` (steering only, dropped at sanitize). |
| Control combos | `exerciseControls` (`live-discovery.ts`) also tries up to 3 (select, then another data-driving control) pairs per page; the result is a `ControlBehavior` with `after` set. `groundDraft` holds the assert after two exercised controls in a row to that pair's entry, falling back to the solo entry when no combo was observed. Time-capped by `until` (crawler passes `deadline - 5s`). |
| Generation from the Route Map | `routeTargets` in `generations.service.ts`: verified, non-excluded routes; pinned then sidebar order; auth pages share at most 2 tests; per-page budget by control count (`testBudget`). |
| Recorder seeding | `recordings.service.ts` adds visited pages to the Route Map on stop. |
| Module canonicalization | `moduleKey`, `sameModule`, `consolidateModules` in `generations.service.ts`; existing module names are passed to the prompts. |
| Failed-login protection | A failed login keeps the previous good crawl and retries once on HTTP 429. |

### Operational fixes made along the way
- The worker did not load the root `.env` (jobs failed with `DATABASE_URL` missing). Dev script is now `tsx watch --env-file=../../.env src/worker.ts`.
- CSS class collision: live-log classes were renamed to `run-step-*` because `.step-row` belongs to the test-case editor.

## 4. Known gaps (ordered by impact on accuracy)

1. **Outcome assertions are unverified.** After an action, text not yet on the page is allowed through as a possible result. A real failure came from this (`Area details for North Territory`).
2. **No dry run before review.** `confidence` is "found on the page", not "ran green". This is the biggest remaining gap.
3. **Multi-step flows are partly grounded.** Controls revealed by a click (modals, wizard steps) are matched against code labels, not seen live.
4. **The runner still falls back to fuzzy text matching.** It flags loose matches in the step log but can still pass on the wrong element.
5. **Single login per environment.** No per-role crawling or role matrix.
6. **Logged-in tests share one plan session.** A test that logs out can break later tests.
7. **On-demand per-page code context is not implemented.** The 600-file bulk read is still used (cap raised from 300). `pageFile` from the adapters now makes reachability and code context work.
8. **Two copies of the generic login** (API `live-discovery.ts` and `worker.ts`), marked `ponytail:`. Lift into a shared package if it grows.
9. **`requiresAuth` on routes** is only set for login-gated pages, not inferred for all.

## 5. Recommended next steps

1. Dry-run every draft in the worker before it enters `PENDING_REVIEW`; one repair attempt from the real page; hold out what still fails with its reason; derive `confidence` from the result.
2. Ground outcomes by recording what actually appears after each action during the dry run, and rewrite or reject non-matching asserts.
3. Strict locators for generated tests: fuzzy matches fail instead of passing.
4. Validate on the ERP app and record the first-run pass rate (the metric above).
5. Then, in this order: step-by-step exploration for multi-step flows, role matrix, per-test isolation from a saved session.
6. Deliberately postponed by the product owner: complex flow tests (CRUD lifecycles, validation matrices). Environment note: the only environment today is Production, so any mutating flow needs a staging/test environment flag first.

## 6. Things you must know before running it

- **Apply the schema.** `cd apps/api && pnpm run prisma:push` (local), or run the three migrations elsewhere. Restart the API so the new Prisma client loads.
- **The target app rate-limits logins per IP** (`429 Too many requests` on `POST api.vdistro.com/api/auth/login`). Each analysis, route verify and execution plan logs in once. Frequent re-runs from one machine will trip it; the crawler waits 30s and retries once.
- **Analysis is asynchronous.** The Projects page and dashboard poll the run. A run can take up to ~6 minutes.
- **Environment data was wiped** for `khanroshaan9@gmail.com` (project, tests, plans, environment, modules). Re-import the repository and re-add the environment and login before testing.
- **Crawler safety.** It only clicks inside navigation regions, never submits forms, and skips labels like delete, logout, save, create, approve. Verify on a copy before pointing it at a system with destructive nav items.
- **Unvalidated against real code.** The React Router AST adapter is tested on a synthetic fixture only. The ERP route file (`web/src/routes/index.tsx` in `roshaan-khan/ERP`) was not read; use it as the first real fixture.
- **Decrypting the stored GitHub token for diagnosis was refused by the permission system.** Use the app's normal analysis path, or paste file contents, to inspect a customer repo.
- **Model provider.** Resolved by `resolveModelProvider` (`apps/api/src/common/model-provider.ts`): admin-configured primary, else any enabled, else `OPENAI_*` env. Structured output is plain `json_object`; no strict JSON schema yet.

## 7. Key files

```
apps/api/src/analysis/        analysis.service.ts, analysis.processor.ts, crawler.ts,
                              live-discovery.ts, analyzer.ts, adapters/, grounding.check.ts
apps/api/src/generations/     generations.service.ts   (routeTargets, groundDraft, prompts)
apps/api/src/route-map/       route-map.{service,controller,module}.ts
apps/api/src/common/          queue.ts, model-provider.ts
apps/workers/src/worker.ts    login, runTestCase (live log), executeStep, plan loop
packages/test-dsl/src/index.ts  isAuthRoute, needsAnonymousSession, TestDefinition.session
packages/database/prisma/schema.prisma  ProjectRoute, EnvironmentProfile.routeFixtures, ExecutionPlanItem.stepLog
apps/web/src/components/route-map-modal.tsx, apps/web/src/app/executions/page.tsx
```
