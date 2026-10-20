# Setup App — AI QA Platform (Complete Setup Guide)

A-to-Z instructions for setting up and running the entire application locally: PostgreSQL, Redis, Prisma database setup and migrations, the API server, the web app, background workers, and the optional supporting services.

---

## 1. What you're setting up

The repo is a **pnpm + Turborepo monorepo**. Components and their ports:

| Component | Path | What it does | Dev port |
|---|---|---|---|
| **Postgres 16** | `infrastructure/compose/docker-compose.yml` | Primary database (Docker) | `5433` (maps to container 5432) |
| **Redis 7** | `infrastructure/compose/docker-compose.yml` | Job queue (BullMQ) backend (Docker) | `6380` (maps to container 6379) |
| **API** ("control plane") | `apps/api` | NestJS + Fastify backend | `4000` |
| **Web** | `apps/web` | Next.js main app UI | `3004` |
| **Workers** | `apps/workers` | BullMQ consumer that executes tests with Playwright | — (no port) |
| Admin | `apps/admin` | Internal admin UI (optional) | `3005` |
| Landing | `apps/landing` | Marketing site (optional) | `3010` |
| Demo target app | `infrastructure/demo-app` | Dummy app used as a test target (optional) | `4600` |

Data flow: **Web → API → Postgres/Redis → Workers → (Playwright) → target app**, with artifacts stored on local disk or S3.

---

## 2. Prerequisites

Install these once, before anything else:

1. **Docker** (with the Compose plugin) — must be running:
   ```bash
   docker info   # should print server info, not an error
   ```
2. **Node.js 20 or newer LTS** (required by Next.js 15 / Prisma 6):
   ```bash
   node -v
   ```
3. **pnpm 10.30.1** — the exact version is pinned in the root `package.json` (`packageManager` field). Enable it via corepack:
   ```bash
   corepack enable
   corepack prepare pnpm@10.30.1 --activate
   pnpm -v   # must print 10.30.1
   ```

---

## 3. Get the code

```bash
cd /path/to/your/projects
git clone <repo-url> agentic-qa
cd agentic-qa

# If you already have the repo, make sure you're on the branch you want and up to date:
git checkout <branch>          # e.g. gitlab-setup or master
git pull origin <branch>
```

---

## 4. Configure environment variables

All services read a single `.env` file at the **repo root** (the API explicitly loads `../../.env`).

```bash
cp .env.example .env
```

Open `.env` and set at minimum these for local development:

| Variable | Example / note |
|---|---|
| `DATABASE_URL` | `postgresql://proofline:proofline@localhost:5433/proofline?schema=public` (matches the Docker compose defaults — keep as-is) |
| `REDIS_URL` | `redis://localhost:6380` (matches Docker compose) |
| `JWT_SECRET` | any long random string (required — the API and workers use it to sign tokens / encrypt credentials) |
| `SUPERADMIN_PASSWORD` | a strong password (used to bootstrap the superadmin user) |
| `API_PORT` | `4000` (default) |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` |
| `WEB_APP_URL` | `http://localhost:3004` |
| `ARTIFACT_DIR` | `./artifacts` (test artifacts fallback storage) |
| `CI_ENVIRONMENT_URL_TEMPLATE` | `http://localhost:4600` (target app used by tests) |

Optional integrations — the app runs fine without them, leave blank unless you need them:

- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` — AI-powered test generation/classification
- `GITHUB_CALLBACK_URL`, `GITLAB_CALLBACK_URL`, `BITBUCKET_CALLBACK_URL` — the fixed OAuth redirect URIs for repository connections (defaults point at `http://localhost:4000/v1/repository-connections/<provider>/callback`). Override only when deploying on a real domain. **There are no platform-level OAuth client credentials** — each organization registers its own OAuth app per provider in the app (see §9.6).
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` — billing
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_S3_BUCKET_NAME` / `AWS_S3_REGION` — S3 artifact storage (falls back to local disk if unset)
- `PLAYWRIGHT_WORKER_CONCURRENCY` (default `2`), `PLAYWRIGHT_STEP_TIMEOUT_MS` (default `8000`)

> ⚠️ **Never commit `.env`.** It is git-ignored; if a pull from a remote branch ever deletes it, re-create it from `.env.example`.

---

## 5. Start the infrastructure (PostgreSQL + Redis)

From the repo root:

```bash
docker compose -f infrastructure/compose/docker-compose.yml up -d
```

Verify both containers are healthy:

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
# compose-postgres-1   Up ... (healthy)
# compose-redis-1      Up ... (healthy)
```

Notes:
- Postgres is exposed on host port **5433** (not the default 5432) and Redis on **6380** — this avoids clashes with any local installs.
- Data persists in the `postgres-data` Docker volume across restarts. Stopping the containers (`docker compose -f infrastructure/compose/docker-compose.yml stop`) does **not** delete data; `down -v` does.

---

## 6. Install dependencies

From the repo root:

```bash
pnpm install
```

This installs all 12 workspace packages. **Re-run this every time you pull changes** — a merged branch often adds dependencies (e.g. `nodemailer` in `apps/api`). If you skip this, the API fails to compile with `Cannot find module '...'` errors.

---

## 7. Set up the database (Prisma)

All Prisma files live in `packages/database`. Run these from the repo root so the root `.env` is picked up:

```bash
# 1) Generate the Prisma Client (TypeScript types used by API + workers)
cd packages/database && pnpm exec prisma generate && cd ../..

# 2) Apply all committed migrations to the database
set -a && source .env && set +a
cd packages/database && pnpm exec prisma migrate deploy && cd ../..
```

`prisma migrate deploy` is idempotent — it applies only migrations that haven't been applied yet.

### Daily / after-every-pull routine

Whenever you switch branches or pull from master, if `packages/database/prisma/` changed (schema or migrations):

```bash
pnpm install                                    # in case deps changed
cd packages/database && pnpm exec prisma generate && cd ../..   # regenerate client
set -a && source .env && set +a && cd packages/database && pnpm exec prisma migrate deploy && cd ../..
```

> ⚠️ **The most common startup error is a stale Prisma Client.** If `apps/api` fails to compile with errors like `Property 'X' does not exist on type ...` (e.g. `emailVerifiedAt`, `accessTokenExpiresAt`) — the field exists in `schema.prisma` but your generated client is old. Fix: `cd packages/database && pnpm exec prisma generate`, then restart the API. (`nest --watch` does **not** detect `node_modules` changes, so always restart the API after regenerating.)

### Dev-time schema iteration (optional)

- `pnpm exec prisma migrate dev` (in `packages/database`) — creates a **new** migration from schema changes. Use when you're changing the schema yourself.
- `pnpm exec prisma studio` — browse/inspect the database in a GUI.

> ⚠️ **Avoid `prisma db push` on this project.** It syncs the schema *without recording migration history*, which causes drift: later `migrate deploy` runs fail with errors like `enum label "INCOMPLETE" already exists` because the DB physically has the changes but the migrations table doesn't know it. (See Troubleshooting §12.3 if this has already happened.)

---

## 8. Install Playwright browsers (needed by workers, once per machine)

The workers app drives Chromium via Playwright. pnpm 10 blocks Playwright's automatic browser download, so install browsers explicitly once:

```bash
cd apps/workers && pnpm exec playwright install chromium && cd ../..
```

Browsers land in `~/.cache/ms-playwright/`. Skip this if `ls ~/.cache/ms-playwright` already shows a `chromium-*` folder. Only needed to actually *execute* tests — the worker starts fine without it and will fail per-execution until browsers exist.

### 8.1 Recording steps — the Proofline Recorder desktop app

"Record steps in a browser" runs **entirely on the user's machine** through the **Proofline Recorder** Electron app (`apps/recorder`) — the server never launches a browser, so local and production behave identically.

**How it works:** clicking *Record steps in a browser* creates a session and opens the `proofline-recorder://` deep link. The OS launches the recorder app (or focuses a running instance), which opens the target URL in its own Chromium window, captures your clicks/fills/selects (passwords masked as `{{password}}`), and pushes them to the platform every couple of seconds. Closing the recorded window keeps the session open — stop (and import) from the web's **Stop Recording** button; a 10-minute cap auto-ends sessions. On Linux, Chromium shows a one-time "Open xdg-open?" confirmation when handing the link to the OS — that's the browser's standard mechanism, and it can be remembered with *Always allow*.

**Install-once (Linux):** download the AppImage, `chmod +x`, and run it **once**. On every launch the app self-installs:
- copies itself to the stable home `~/.local/share/proofline-recorder/` (Downloads paths get cleaned up),
- registers `proofline-recorder://` (desktop entry + `xdg-mime`, refreshed on each run so it self-heals),
- enables **autostart at login** (`~/.config/autostart/proofline-recorder.desktop`, runs hidden in the background).

**Install-once (Windows/macOS):** run the installer — the NSIS installer registers the protocol in the Windows registry, the macOS app declares it in Info.plist, and both enable a hidden **login item** (`setLoginItemSettings`) so the recorder is resident after every reboot. Launch the app once to activate.

After that single setup, recordings launch with one click; setup/instructions are available any time via the **Recorder Setup** button in the test editor (downloads are disabled once the app is installed on the machine). The modal's **Uninstall** button removes the recorder completely (`proofline-recorder://uninstall`): protocol registration from both MIME registries, the autostart entry, and the app files (`~/.local/share/proofline-recorder/`); on Windows/macOS it clears the protocol handler and login item. Downloads re-enable after uninstalling.

**Building the installers:**
```bash
pnpm --filter @ai-qa/recorder dist --linux AppImage   # works anywhere
pnpm --filter @ai-qa/recorder dist --win nsis         # needs wine on Linux (sudo apt install wine)
pnpm --filter @ai-qa/recorder dist --mac dmg          # needs macOS
```

#### 8.2 Installer files — where they're generated, stored, and served

**Generated artifacts** (exact names matter — the download links use them):

| Platform | File | Build requirement |
|---|---|---|
| Windows | `apps/recorder/dist/ProoflineRecorder-Setup.exe` | wine on Linux, or any Windows machine |
| macOS | `apps/recorder/dist/ProoflineRecorder.dmg` | a Mac |
| Linux | `apps/recorder/dist/ProoflineRecorder.AppImage` | any machine |

**How they're served:** the API streams them from a single endpoint — `GET /v1/recordings/installer/windows|mac|linux` — reading files from the directory in `RECORDER_INSTALLER_DIR` (default: `apps/recorder/dist`). The web app's setup modal links to `${NEXT_PUBLIC_API_URL}/v1/recordings/installer/<platform>`, so no URL configuration exists to maintain: wherever the API is reachable, the downloads are too.

**Local environment:** nothing to configure. Build (or download) the artifacts into `apps/recorder/dist/` and they're live at `http://localhost:4000/v1/recordings/installer/…`. A missing file returns a clear "not published yet" message.

**Production deployment (VPS):**
1. Build all three installers (see commands above; produce them wherever wine/macOS are available).
2. Copy them to the VPS installers directory:
   ```bash
   scp apps/recorder/dist/ProoflineRecorder-* <user>@<vps>:/opt/agentic-qa/installers/
   # (sudo mkdir -p /opt/agentic-qa/installers on the VPS first if it doesn't exist)
   ```
   The production compose already bind-mounts `/opt/agentic-qa/installers` → `/data/installers` inside the API container (read-only).
3. Set the directory in `/opt/agentic-qa/.env.production`:
   ```
   RECORDER_INSTALLER_DIR=/data/installers
   ```
4. Reapply the stack so the mount/env take effect:
   ```bash
   ssh <user>@<vps> "cd /opt/agentic-qa && docker compose -f infrastructure/compose/docker-compose.prod.yml --env-file .env.production up -d api"
   ```
5. Verify from the outside:
   ```bash
   curl -I https://api.prooflineqa.com/v1/recordings/installer/linux   # 200 + Content-Disposition
   ```
Updating an installer later = rebuild → scp to the same folder → done (no container restart needed; files are streamed per request).

**Local development:**
```bash
pnpm --filter @ai-qa/recorder dev     # registers the proofline-recorder:// protocol + starts the app
```
Dev runs disable Electron's sandbox automatically (`ELECTRON_DISABLE_SANDBOX` in the dev script) because the SUID helper needs root; the Linux AppImage runs with `--no-sandbox` (an AppImage cannot preserve the setuid sandbox helper), while Windows/macOS builds keep their native sandboxes.

**Build installers (Windows NSIS + Linux AppImage):**
```bash
pnpm --filter @ai-qa/recorder dist --win nsis --linux AppImage
# output: apps/recorder/dist/…
# Windows NSIS on Linux requires wine (sudo apt install wine); DMG builds require macOS.
```
Installers are served by the **API**: `GET /v1/recordings/installer/windows|mac|linux` (public, streams from `apps/recorder/dist` by default). The web app's install prompt links there, so dev testing works with zero setup. For production, either set `RECORDER_INSTALLER_DIR=/opt/agentic-qa/downloads` in `.env.production` and copy the built artifacts to that folder on the VPS, or keep the default by baking `apps/recorder/dist` into the API image.

---

## 9. Run the services

Run each service in its own terminal, from the repo root.

### 9.1 API server (port 4000)

```bash
pnpm --filter @ai-qa/api dev
```

- Starts NestJS in watch mode (hot-reload on code changes).
- Reads the root `.env` automatically (`envFilePath: ["../../.env", ".env"]`).
- Wait for `Nest application successfully started` / `Control plane listening on port 4000`.

Verify:

```bash
curl http://localhost:4000/v1/health
# {"status":"ok","service":"ai-qa-control-plane",...}
```

### 9.2 Web app (port 3004)

```bash
pnpm --filter @ai-qa/web dev
```

- Next.js dev server. First request triggers compilation (~10–15 s), so an immediate `curl` may time out — that's normal.
- Uses `NEXT_PUBLIC_API_URL` from `.env`, falling back to `http://localhost:4000`.

Verify: open **http://localhost:3004** (should return HTTP 200).

### 9.3 Workers (test executors)

> ⚠️ **The worker does NOT load `.env` by itself** (it reads `process.env` directly and `tsx` doesn't auto-load env files). You must source the root `.env` first, or it will run without `DATABASE_URL`/`JWT_SECRET` and fail to decrypt credentials or reach the database.

```bash
set -a && source .env && set +a
pnpm --filter @ai-qa/workers dev
```

- Runs `tsx watch src/worker.ts` (hot-reload).
- Connects to Redis and consumes the `executions` queue with `PLAYWRIGHT_WORKER_CONCURRENCY` parallel Playwright sessions.

Verify — you should see:

```
{"service":"ai-qa-workers","status":"ready","queue":"executions","concurrency":2}
```

### 9.4 Optional services

**Admin UI (port 3005):**

```bash
pnpm --filter @ai-qa/admin dev     # http://localhost:3005
```

**Landing page (port 3010):**

```bash
pnpm --filter @ai-qa/landing dev   # http://localhost:3010
```

**Demo target app (port 4600)** — a dummy app the platform can run tests against:

```bash
node infrastructure/demo-app/server.cjs   # http://localhost:4600
```

### 9.5 Alternative: run everything with one command

```bash
pnpm dev    # = turbo run dev --parallel (api + web + workers + admin + landing)
```

Caveats:
- The **worker still needs env sourced first** (`set -a && source .env && set +a` before `pnpm dev`), since turbo doesn't inject `.env` either.
- It starts *all* apps; use the per-service commands in §9.1–9.3 if you only want the core app.

### 9.6 Connecting repositories (per-organization OAuth)

Repository connections use **each organization's own OAuth app** — there are no platform-level client credentials in `.env`. One credential set per org per provider, shared by all org members; only **organization admins** can manage it.

1. As an org admin, open **Settings → Connected accounts** and click **Connect** on a provider (e.g. GitHub).
2. A configuration form opens. It shows the **Redirect URI** you must register at the provider (copy button included):
   - GitHub: https://github.com/settings/developers → *New OAuth App*
   - GitLab: https://gitlab.com/-/user_settings/applications
   - Bitbucket: OAuth consumer (see the linked Atlassian docs in the form)
3. Paste the provider app's **Client ID** and **Client Secret** and save. The secret is encrypted (AES-256-GCM) in the database and is never displayed again.
4. The app then redirects to the provider to authorize your account. Connected accounts and the "OAuth app configured" status appear on the provider cards; admins can **Replace** or **Remove** the credentials there.

API endpoints backing this: `GET/PUT/DELETE /v1/repository-connections/credentials` (PUT/DELETE admin-only, audited). Adding a future integration (e.g. JIRA) reuses the same `IntegrationCredential` table — `provider` is a plain string, so no migration is needed.

---

## 10. First-run verification checklist

```bash
docker ps                         # postgres + redis: Up (healthy)
curl http://localhost:4000/v1/health   # {"status":"ok",...}
curl -I http://localhost:3004     # HTTP 200
```

Then in the browser:
1. Open http://localhost:3004 → sign up / sign in.
2. As an org admin, configure your OAuth app credentials per provider in Settings → Connected accounts (see §9.6) — connecting a repository fails without them.
3. Create a project and a test case.
4. Run a test → it should enqueue, the worker picks it up (watch its terminal), and results/artifacts appear in the UI.
5. If AI generation is configured (`OPENAI_API_KEY`), try generating a test.

---

## 11. Stopping everything

```bash
# Stop dev servers: Ctrl+C in each terminal (or kill the pnpm processes)

# Stop infrastructure (data is preserved):
docker compose -f infrastructure/compose/docker-compose.yml stop

# Start infrastructure again later:
docker compose -f infrastructure/compose/docker-compose.yml start
```

---

## 12. Troubleshooting

### 12.1 API compile errors: `Property 'X' does not exist on type ...` (TS2339)

**Cause:** stale generated Prisma Client after a schema change or branch switch.
**Fix:**
```bash
cd packages/database && pnpm exec prisma generate && cd ../..
# then restart the API (nest --watch won't notice node_modules changes)
```

### 12.2 API compile errors: `Cannot find module 'nodemailer'` (or any module)

**Cause:** new dependencies added by a merged branch; `node_modules` out of date.
**Fix:** `pnpm install` at the repo root, then restart the affected app.

### 12.3 `migrate deploy` fails: `enum label "..." already exists` (or similar duplicate-object errors)

**Cause:** migration-history drift — the database schema was previously synced with `db push` (or a migration was recorded as applied but physically missing), so history and reality disagree.
**Diagnosis (exact diff between live DB and migration history):**
```bash
docker exec compose-postgres-1 psql -U proofline -d postgres -c "CREATE DATABASE prisma_shadow;"
set -a && source .env && set +a
cd packages/database
pnpm exec prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-migrations prisma/migrations \
  --shadow-database-url "postgresql://proofline:proofline@localhost:5433/prisma_shadow"
```
- If the diff **only lists missing objects**, apply the printed SQL to the live DB (add `--script` to get plain SQL), then re-run the diff until it reports **"No difference detected."**
- Then mark migrations whose changes are already physically present as applied, and confirm:
  ```bash
  pnpm exec prisma migrate resolve --applied <migration_name>
  pnpm exec prisma migrate deploy    # should say "No pending migrations to apply."
  ```
- Clean up: `docker exec compose-postgres-1 psql -U proofline -d postgres -c "DROP DATABASE prisma_shadow;"`

Failed migrations are visible here:
```bash
docker exec compose-postgres-1 psql -U proofline -d proofline \
  -c "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name;"
```

**Variant — `migrate status` says "up to date" but the API still throws Prisma P2022 ("column … does not exist"):** the migration ledger claims migrations are applied while the physical DDL is missing (happens when a database was baselined or switched — e.g. after pointing `DATABASE_URL` at a fresh cloud database — without replaying DDL). `migrate deploy` is a no-op here. Repair by applying the missing DDL directly:
```bash
# 1) exact SQL between the live DB and the migration history
docker exec compose-postgres-1 psql -U proofline -d postgres -c "CREATE DATABASE prisma_shadow;"
set -a && source .env && set +a && cd packages/database
pnpm exec prisma migrate diff --from-url "$DATABASE_URL" --to-migrations prisma/migrations \
  --shadow-database-url "postgresql://proofline:proofline@localhost:5433/prisma_shadow" --script > /tmp/drift.sql
# 2) review /tmp/drift.sql (it may DROP stale tables/columns — that is the schema's intent), then apply:
pnpm exec prisma db execute --file /tmp/drift.sql --url "$DATABASE_URL"
# 3) if a NOT NULL column needs backfilling from existing rows, apply the original migration file instead:
pnpm exec prisma db execute --file prisma/migrations/<name>/migration.sql --url "$DATABASE_URL"
# 4) re-run step 1 until it reports "No difference detected."
```
Seen in practice: the Overview/dashboard API returning 500 because `Project` was missing the new `provider`/`repoFullName`/`ci*` columns after the master pull.

### 12.3b After pulling schema changes: API shows TypeScript errors, runtime 500s, or `P2022 "column … does not exist"`

When a pull changes `packages/database/prisma/schema.prisma`, the **generated Prisma Client**, your **node_modules** (workspace packages like `@ai-qa/test-dsl` get new exports), and the **database** must all be brought up to date — in this order:

```bash
pnpm install                                                        # 1. resync deps + lockfile
cd packages/database
pnpm exec prisma generate                                           # 2. regenerate the Prisma Client (must re-run AFTER install)
pnpm exec prisma migrate deploy                                     # 3. apply committed migrations to the DB
cd ../.. && cd packages/database
pnpm --filter "@ai-qa/contracts..." --filter "@ai-qa/test-dsl..." --filter "@ai-qa/domain..." \
  --filter "@ai-qa/model-provider..." run build                     # 4. rebuild workspace packages the API consumes
```

Then restart the API (`nest --watch` recompiles but the Prisma Client it loaded at boot is stale — a restart is required after `prisma generate`).

If step 3 fails with duplicate-object errors (e.g. `column "routeFixtures" … already exists`), the migration history itself is inconsistent (a duplicate migration was committed, or `db push` was used earlier). Resolve with the drift procedure in §12.3 above — in the documented case, a duplicate `20261017000000_env_route_fixtures` migration re-added an existing column and had to be removed with `migrate resolve --rolled-back <name>` + deleting its folder (coordinate with the team before deleting committed migrations).

If `migrate deploy` passes but runtime 500s remain (e.g. `Subscription.createdAt does not exist`), the migration history doesn't cover the schema — sync directly and verify emptiness:
```bash
pnpm exec prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://proofline:proofline@localhost:5433/prisma_shadow" --script
# review, then apply with `prisma db execute --file …`
```
Seen in practice after the Oct 19 pull: `Subscription.createdAt` missing → signup 500 → the web app redirected to signin because `/v1/auth/me` failed.

### 12.4 Web app doesn't respond right away (curl timeout / connection refused)

Next.js compiles pages on first request in dev mode (10–15 s). Wait a moment and retry; check the terminal for `✓ Ready`.

### 12.5 Worker starts but test executions stay queued forever

- Workers app not running (it's a separate process — see §9.3).
- Worker started **without sourcing `.env`** → it can't decrypt credentials; restart it per §9.3.
- Playwright browsers missing → run the step in §8.

### 12.6 Connect fails with "Your organization has not configured a … OAuth app yet"

Per-org OAuth is mandatory — there are no platform-level credentials. An **organization admin** must open Settings → Connected accounts, click Connect on that provider, and register the org's own OAuth app (client id + secret) as described in §9.6. Existing GitHub connections keep working until their tokens expire; Bitbucket/GitLab connections stop refreshing once the org's credentials are removed and must be reconnected.

### 12.7 Port already in use

Something else is on `4000 / 3004 / 5433 / 6380`. Find it: `lsof -i :<port>` (or `ss -ltnp | grep <port>`), stop it, or change `API_PORT` in `.env` / the `--port` flag in the app's `package.json` dev script.

### 12.8 `docker compose` errors / containers exited with code 255

Docker daemon isn't running or was restarted. Start Docker, then `docker compose -f infrastructure/compose/docker-compose.yml up -d` again — containers and their data volume come back intact.

### 12.9 Fresh-database reset (destroys all data)

```bash
docker compose -f infrastructure/compose/docker-compose.yml down -v   # -v deletes the data volume
docker compose -f infrastructure/compose/docker-compose.yml up -d
set -a && source .env && set +a && cd packages/database && pnpm exec prisma migrate deploy && cd ../..
```

---

## 13. Quick reference — full setup from zero on a new machine

```bash
# prerequisites: Docker running, Node 20+, corepack enabled
corepack prepare pnpm@10.30.1 --activate

cd agentic-qa
cp .env.example .env                 # then edit: JWT_SECRET, SUPERADMIN_PASSWORD
pnpm install

docker compose -f infrastructure/compose/docker-compose.yml up -d

cd packages/database && pnpm exec prisma generate && cd ..
set -a && source ../.env && set +a && pnpm exec prisma migrate deploy && cd ..
cd apps/workers && pnpm exec playwright install chromium && cd ../..

# terminal 1
pnpm --filter @ai-qa/api dev
# terminal 2
pnpm --filter @ai-qa/web dev
# terminal 3
set -a && source .env && set +a && pnpm --filter @ai-qa/workers dev

curl http://localhost:4000/v1/health   # {"status":"ok",...}
# open http://localhost:3004
```


## Starting the app
# 1. Postgres + Redis (skip if containers are still up):
` cd infrastructure/compose && docker compose up -d && cd ../.. `

# 2. Load environment variables — required before starting any service, because nothing auto-loads the root .env
`set -a && source .env && set +a`

# 3. API (port 4000) — one terminal:
` cd apps/api && pnpm dev `

 If it fails with Cannot find module '@ai-qa/...', the shared packages need a build (needed after a fresh install or edits to packages/*/src):

 ` pnpm --filter @ai-qa/contracts --filter @ai-qa/domain --filter @ai-qa/test-dsl --filter @ai-qa/model-provider build `

# 4. Web dashboard (port 3004, not 3000) — second terminal:
` cd apps/web && pnpm dev `

# 5. Worker + demo app — third terminal (worker must load the same env, and both must run from the repo root):
` set -a && source .env && set +a
pnpm --filter @ai-qa/workers dev &
node infrastructure/demo-app/server.cjs & `

# Closing the app

Services started in terminals: press Ctrl+C in each terminal (API, web, worker, demo app). They all handle SIGINT/SIGTERM and shut down cleanly.
Docker — from infrastructure/compose

` docker compose down        # stops containers; data in the postgres-data volume is kept
docker compose down -v     # also deletes all data (fresh DB next time) — destructive `