# Proofline test engine: semantic analysis + verified test generation

This document explains how Proofline turns a repository and a running environment into reviewable, verified end-to-end tests. It covers the full pipeline, the design rules behind it, the data it stores, and how to operate and debug it.

Architecture diagram: `.archify/architecture-engine-20261018/engine.html`

---

## 1. Why the engine was rebuilt

The original generator only saw what a crawler could find on screen. On the ERP reference app that produced mostly one template ("type in a search box, assert the empty state"). 13 of 17 tests were variations of it, and tests were never run before a human reviewed them, so some passed without testing anything.

The new engine changes three things:

1. **It reads the code, both frontend and backend.** Actions, form rules, permissions, state preconditions and backend error messages come from the source, not from what happens to be visible.
2. **It plans scenarios per action.** For example: happy path, validation, backend-rule negatives, state and permission checks.
3. **It runs every test before review.** A test must pass on the real app and must fail when its key step is removed (mutation check). Otherwise it is repaired once or held out with a reason.

---

## 2. Design rules

These rules are binding. Changes that break them should be rejected.

| Rule | Meaning |
|---|---|
| **No per-library extractors** | No deterministic parsers for zod, Joi, RTK Query, Express and the like. All library-specific understanding comes from an LLM reading code slices. |
| **Deterministic code stays generic** | Code without an LLM only fetches files, builds the import graph, slices, extracts path literals, hashes, caches and checks quotes. |
| **Every LLM fact is anchored** | A fact needs a verbatim quote that exists in the given slice. Every literal in the fact (label, message, permission, status) must appear inside one of its quotes. Facts that fail are dropped and recorded, not trusted. |
| **The dry run is the final judge** | A spec can be anchored but wrong in meaning. The verification run catches that. |
| **One login per environment** | Scenarios needing another role are skipped with a reason. |
| **Fix the engine before blaming the model** | Quality problems are traced to engine causes first. A stronger model is a later lever, not a fix. |

---

## 3. Pipeline overview

```
Analyze  ─┬─ Static:  archive → import graph/slices → endpoint discovery → flow specs (+gap-fill) ─┐
          └─ Live:    crawler (login, routes, inventory, ARIA, API shapes) ───────────────────────┤
                                                                                                    ▼
                                                                                 knowledgeModel + FlowSpec rows
Generate ─→ planner → spec generator (LLM) → groundDraft → DRAFT tests ─→ verify queue
Verify   ─→ dry run + mutation ─→ pass: PENDING_REVIEW │ fail: repair (LLM) → round 2 → held out with reason
```

The API runs analysis and generation jobs. The workers process (Playwright) runs verification and test plans. Jobs move through BullMQ queues on Redis.

| Queue | Consumer | Jobs |
|---|---|---|
| `analysis` | API | analyze a project |
| `generations` | API | `generate` (legacy), `generate-spec`, `generate-spec-wave-b`, `repair` |
| `verifications` | workers | verify a generation run (round 1 / 2) |
| `executions` | workers | run a test plan |

---

## 4. Analysis (static)

### 4.1 Repository ingestion: `apps/api/src/analysis/repo-archive.ts`
- Downloads **one tarball at the pinned commit SHA** (GitHub / GitLab / Bitbucket APIs). If that fails, it falls back to per-file readers.
- Extracts with a 300 MB cap, skipping `node_modules`, `.git`, `dist` and `build`, and skipping symlinks.
- Walks only the project's **`rootDirectory`** (frontend) plus its **`backendDirectories`**. Each file is tagged `frontend` or `backend`.
- Keeps code files (`.ts/.tsx/.js/.jsx/.vue/.svelte/.astro`) up to 250 KB each, 40 MB / 8,000 files in total. Also keeps config files (`package.json`, `tsconfig`/`jsconfig`, `next.config`, `vite.config`).

`backendDirectories` is set when importing a repository, or later from the project card ("no backend" chip). Without it, no endpoints are discovered and specs carry no backend rules.

### 4.2 Import graph and slicing: `apps/api/src/analysis/analyzer.ts`
- Follows static imports, re-exports, dynamic `import()`, `require()` and side-effect imports.
- Resolves aliases from `tsconfig`/`jsconfig` `paths` (including `extends` chains) and `vite.config` `resolve.alias`.
- Maps `.js` to `.ts`, and resolves `.vue/.svelte/.astro`.
- `sliceModule` walks breadth-first from entry files up to a token budget. It skips "shared" files (imported by at least 25% of pages and at least 5 of them), so UI kits don't crowd out feature code.

### 4.3 Route hints: `apps/api/src/analysis/adapters/`
- Deterministic adapters handle file-based routing and React Router. If neither finds anything, an LLM reads the router files.
- Files the LLM reports are resolved through the real import resolver (aliases like `@/views/Home` become real paths).

### 4.4 Endpoint discovery: `apps/api/src/analysis/endpoints.ts`
1. **Candidate files:** backend files containing a call with a path-like first argument (`router.post('/x'`, `@Get('/x')`, and similar). Test files (`tests/`, `*.test.*`, `*.spec.*`) are excluded. Each file is reduced to its import lines plus every matching statement with line numbers.
2. **LLM `EndpointMap`**, batched 8 files per call. It returns mounts (`app.use('/api', routes)`) and endpoints (method, path, handler, middleware), each with a quote.
3. **Deterministic composition:**
   - Every quote is verified against the source.
   - An endpoint is kept if its quote contains the path. Otherwise it is kept only if the quoted line sits inside a real call whose path literal matches; this covers multi-line route declarations.
   - Mount prefixes are joined from root files down.
   - Handler files are resolved through imports, including the `const x = new Controller()` pattern.
4. **Cache:** the raw LLM output is stored in `LlmCache` (kind `endpoints`). A run where any batch failed is not cached, so missing files are retried next time.

The output is `EndpointRow { id, method, fullPath, norm, file, line, handler, handlerFile, middleware }`. ERP gives 275 rows.

### 4.5 Modules: `buildModules` in `apps/api/src/analysis/specs.ts`
- Routes are grouped by their first path segment, excluding auth routes.
- A group whose pages span several directories is split by directory (for example `settings/*` becomes territories, roles, warehouses).
- Groups with no page file (redirects, aliases) are dropped.
- **Endpoint join:** an endpoint belongs to the module named by its *first* path segment (`/api/orders/:/approve` belongs to orders). Matching on any shared segment is only a fallback, so `/api/deliveries/:/orders` does not pull the deliveries backend into orders.

### 4.6 Flow specs: `apps/api/src/analysis/specs.ts`
For each module:
1. **Slice:** the frontend slice from the module's page files (50k-token budget), plus a backend slice from the joined endpoints' route and handler files (35k). Files are numbered `N: line` so quotes are exact.
2. **Conventions digest:** one cached LLM call over the highest fan-in files describing how errors surface, how permissions are checked and how forms validate. It is shared by every module prompt.
3. **Cache key:** `sliceHash` = sha256(sorted file hashes + conventions hash + prompt version + schema version + model). A hit makes **no LLM call**, so a re-analysis of unchanged code costs nothing.
4. **Main LLM call** (strict JSON schema, `FlowSpecData`). Per action it returns:
   - trigger (route, label, control, container)
   - preconditions
   - permission
   - form fields and rules
   - backend calls
   - backend rules
   - effects
   - `src` quotes
5. **Anchoring** (`anchorFlowSpec`):
   - Quotes must exist in the slice.
   - The trigger label must be inside a quote, or the action is dropped.
   - Permissions, rule messages, precondition values and effect texts must each be inside a quote, or that literal is dropped.
   - **Literal recovery:** if the model reported a real literal but skipped its citation, the engine looks for that exact literal in the slice. It accepts only a whole string literal or JSX text, and searches the action's own cited files first. An invented literal still finds nothing and is dropped.
6. **Gap-fill:** one call over a large slice reliably lists only a few actions. The module's write endpoints (non-GET) that no action's call reaches become a checklist. The engine makes follow-up calls, 6 endpoints each and at most 5 calls per module, each with a focused slice:
   - **Frontend:** the files whose path literals join those endpoints, plus up to 2 hops of files importing them, plus 1 hop of files they import whose filename contains the endpoints' resource words (for example `ApproveOrderDialog`).
   - **Backend:** route and handler files, plus their imports named after the resource (service, DTO).

   New actions are anchored the same way and kept only if they reach a still-uncovered endpoint.
7. **Endpoint ids** on `calls[]` are always set by our own join (method-aware: `POST /categories` never matches the `GET` row).

Calls run with a concurrency of 3 (`ANALYSIS_CONCURRENCY`). Before the spec stage, a quota check skips specs (setting `knowledgeModel.specError`) instead of failing the run. Real token usage is recorded per analysis run.

**ERP after the fixes:** 31 modules, 95 actions, 184 form rules, 49 permissions, 28 preconditions, 29 backend rules. Example: orders has Approve (pending, `APPROVE_ORDER`, "Only pending orders can be approved."), Process, Deliver and Cancel.

---

## 5. Analysis (live)

### 5.1 Crawler: `apps/api/src/analysis/crawler.ts`, `live-discovery.ts`
- Logs in once (a saved session is reused when still valid) and visits every route, using fixtures for `:param` routes.
- For each page it records buttons, inputs, headings, nav items, API calls and response shapes, and an **ARIA snapshot** (`page.ariaSnapshot({mode:"ai"})`, capped at 8k characters).
- It exercises filters and search controls to learn what they really do.
- Routes are marked VERIFIED, DISCOVERED or UNREACHABLE, with a reason.
- **Session keeper** (`packages/test-dsl/src/session.ts`, shared with the workers): if a page shows the login screen after a successful login, the keeper confirms the session is really gone, logs in again and the page is re-read. It keeps doing so for as long as re-logins work (short-lived tokens, e.g. ERP's 15 minutes, die many times per crawl) and stops after one fails. The session is saved at the end of the crawl, so the next run starts from the newest login.
- **Re-login guard:** if a page shows the login screen after a successful login, the crawler logs in again (up to 3 times) and re-reads the page. Without this, an expired session turns the rest of the crawl into "only a login screen was shown".
- Auth routes are read in a separate logged-out context.

### 5.2 Rate limiting: `packages/test-dsl/src/host-limiter.ts`
Many apps rate-limit per IP and log the user out on a 429. The host limiter is installed on every crawler, verifier and runner browser context:
- It paces fetch/xhr requests per host (120 ms minimum gap).
- **Proactive pause:** it reads `RateLimit-Remaining` / `RateLimit-Reset` (also the `X-` variants and the combined draft-7 header). When the remaining budget drops to the reserve (3% of the limit, at least 1), the host is paused until the window resets, **before** a 429 happens.
- **Scoped pause:** a limiter smaller than the host's main budget (login 10 per 15 minutes, export 30 per minute) pauses only its own path.
- On a 429 it waits for `Retry-After` and retries (up to 3 times).
- `waitUntilReady()` is called before every page and test, so nothing starts inside an exhausted window. Time spent paused extends the crawl deadline rather than consuming it.

---

## 6. Generation

### 6.1 Entry point
`POST /v1/projects/:id/generations/candidates` (the Generate button) uses the spec path whenever the latest analysis has flow specs with actions. Otherwise it falls back to the legacy crawl-only generator. `POST …/spec-candidates` with `{modules: [...]}` limits planning to chosen modules.

### 6.2 Planner: `apps/api/src/generations/planner.ts`
This step is deterministic and makes no LLM calls. Scenarios per action:

| Category | Source |
|---|---|
| `HAPPY_PATH` | every testable action |
| `VALIDATION` / `BOUNDARY` | each client rule with a message, deduplicated by message, at most 6 per action |
| `NEGATIVE` | each backend rule that is reproducible from the UI and has a message, deduplicated by message |
| `STATE` | each entity-state precondition (trigger hidden in other states). Permission names reported as "states" are ignored. |
| `PERMISSION` | trigger hidden when the user's known permissions lack it. The action's other scenarios are skipped ("needs another role"). |

Skipped, with a reason:
- **navigation-only:** no form, no write call, no effect beyond navigating.
- **auth flow:** the session is already logged in, and re-driving login risks locking the account.
- **budget:** the default budget is 600k tokens. Ordering is happy paths round-robin across modules, then state, negative, validation, boundary and permission.
- **duplicates:** `scenarioKey = module:action:category:variant`, deduplicated against existing non-archived tests.

**Setup chains:** a breadth-first search over transition effects from a create action (create → approve → process). Without a chain the strategy is `existing`, meaning a matching record is picked from the list.

### 6.3 Two waves
- **Wave A** covers the happy paths that other scenarios need as setup. They go through generate → verify → repair → verify.
- **Wave B** covers everything else. Chain scenarios get wave A's verified steps as their setup, with `key` stripped. If a chain link never verified, the scenario falls back to `existing`.
- The verify job enqueues wave B when wave A settles.

### 6.4 Spec generator: `apps/api/src/generations/spec-generator.ts` + `generations.service.ts`
- 4 scenarios per LLM call. Each scenario carries:
  - its anchored action data
  - the route's live inventory and ARIA snapshot
  - any recipe steps
- **Rules for the model:**
  - Targets are visible text only, never `button: X`.
  - `key: true` goes only on the scenario's own trigger and confirm steps.
  - The final assert must prove the action's effect, not the page heading.
  - Return one draft per scenario; use an "insufficient grounding" fallback instead of guessing.
- **`groundDraft`:** interactive targets must exist in live inventory ∪ ARIA ∪ spec evidence (anchored labels and messages) ∪ code. Rejected drafts are logged with a reason.
- Saved as **DRAFT** with `scenarioKey`, a version 1 record, and the module taken from the spec.

---

## 7. Verification and repair

### 7.1 Verify worker: `apps/workers/src/verify.ts`
- One stream per environment host; the session is reused or logged in once (`openRunSession` in `worker.ts`, also used by the plan runner).
- A test that fails on a login screen, or after the app answered 401, goes to the session keeper. If the session is still alive, the failure stands (a real 401). If it was restored, the test runs again. If it is lost, the test is held out as `session-lost` and never repaired. The mutation run goes through the same path, so a session dying there cannot read as a killed mutation.
- For each DRAFT test:
  1. Run strictly (exact role/name locators, no loose fallbacks), recording network errors, the ARIA snapshot at failure and match quality.
  2. An unresolved 429 is never counted as a failure: wait it out, retry, or mark `rate-limited`.
  3. On pass, run the **mutation**: remove the `key` steps (or the last interactive step). The test must now fail at an assert, waitFor or assertResponse step.

| Result | Status |
|---|---|
| Mutation killed, no loose matches | PENDING_REVIEW (0.95) |
| Killed after repair | PENDING_REVIEW (0.85) |
| Mutation not applicable | PENDING_REVIEW (0.7) |
| Failed or survived, round 1 | stays DRAFT, sent to repair |
| Failed or survived, round 2 | NEEDS_REVIEW with reason |

### 7.2 Repair: the `repair` job in the API
3 tests per LLM call. Each gets:
- its definition
- the failed step and error
- the ARIA snapshot at failure
- network errors
- the route inventory
- for mutation survivors, the ARIA diff around the key step

The result is re-sanitized and re-grounded, saved as a new version, and queued for round 2.

---

## 8. Data model (Prisma)

| Model / field | Purpose |
|---|---|
| `Project.backendDirectories` | backend folders outside `rootDirectory` |
| `AnalysisRun.knowledgeModel` | routes, endpoints, flowSpecs, discoveredPages, loginStatus |
| `AnalysisRun.progress` | live stage and module counts |
| `FlowSpec` | per-module spec, files with hashes, stats (facts, dropped, tokens, chunks); unique on `(projectId, moduleKey, sliceHash)` |
| `LlmCache` | cached LLM outputs (`endpoints`, `conventions`, …) by input hash |
| `GenerationRun.report` | stage, wave, planned, generated, verified, heldOut, skipped with reasons |
| `TestCase.status = DRAFT` | hidden from lists and counts until verified |
| `TestCase.scenarioKey` | unique per project; deduplicates scenarios across runs |
| `TestCase.verification` | round, outcome, reason, attempts, mutation result |
| `AiUsageRecord.analysisRunId` | real token usage per analysis |

---

## 9. Operating the engine

1. **Import:** set the root directory (frontend) and the backend directories.
2. **Environment:** set the base URL and login credentials. A saved session is reused.
3. **Analyze.** First run on ERP: about 1.9M input tokens on gpt-4o-mini (main calls plus gap-fill). Unchanged modules are free afterwards.
4. **Generate.** Hours for a whole app, mostly verification time. Use `modules` for a quick check of one area.
5. **Review** PENDING_REVIEW tests. NEEDS_REVIEW tests carry the failure reason.

**Environment notes:**
- Tests really create, approve, cancel and delete records. Use dummy-data environments only. "Deactivate" style actions could hit the test login itself.
- The app's rate limit decides wall time. ERP defaults to 1000 requests per 15 minutes per IP; raising it on the test deployment (for example to 20000) removes most waiting.
- The engine needs records in useful states (pending or approved orders, and so on) when no setup chain exists.

---

## 10. Debugging checklist

| Symptom | Where to look |
|---|---|
| Only legacy-style tests ("search shows clear button") | No flow specs with actions in the latest analysis, so the legacy fallback ran |
| `endpoints: 0` | `backendDirectories` is empty |
| Module has few actions | `FlowSpec.stats.dropped`, `chunks`; uncovered write endpoints per module |
| Wrong backend files in a slice | Endpoint-to-module join (first-segment rule) |
| Most drafts rejected | `knowledgeModel.discoveredPages`: many `authGated` pages mean the crawl lost its session; check the rate limit and login |
| Analysis seems stuck | `AnalysisRun.progress`; a limiter pause waiting for a rate-limit window; screenshot timestamps in `artifacts/discovery` |
| Verification never starts | the workers process is not consuming `verifications` (check its startup log for the queues being ready) |

**Self-checks** (run after engine changes):
- API: `cd apps/api && pnpm exec tsc -p tsconfig.json --outDir .check-out`, then run `node .check-out/analysis/{anchor,endpoints,slicer,archive,grounding}.check.js` and `node .check-out/generations/planner.check.js`. Remove `.check-out` afterwards.
- Workers: `cd apps/workers && pnpm exec tsx src/limiter.check.ts` and `pnpm exec tsx src/session.check.ts` (offline fake app; no real logins).
- Typecheck: `pnpm -r --if-present run typecheck`.

---

## 11. Known limits and next steps

- **Write-endpoint coverage** is about 56 of 122 on ERP. Some modules' labels sit in files outside the focused slice, or the UI genuinely lacks the action.
- **Setup chains:** create actions rarely state their resulting status, so chains are seldom found and STATE tests use existing records.
- **Single role:** permission scenarios assume one login.
- **Rate-limited apps** make whole-app verification slow, though correct.
- **Phase 6 UI** (spec viewer, coverage, run panel) is not built yet.
- **Phase 7:** the whole-app evaluation against the Phase 0 baseline is still to be run.
