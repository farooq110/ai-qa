#!/usr/bin/env bash
# Deploy the agentic-qa stack to the production server (Hostinger VPS).
# Usage: bash scripts/deploy.sh
# Reads DEPLOY_SSH_* from .env (or environment overrides — used by CI).
# Production secrets live ONLY in .env.production (local for first upload,
# then on the server); they are never committed.
set -euo pipefail
cd "$(dirname "$0")/.."

get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'; }
HOST="${DEPLOY_SSH_HOST:-$(get DEPLOY_SSH_HOST)}"
USER_="${DEPLOY_SSH_USER:-$(get DEPLOY_SSH_USER)}"
PORT="${DEPLOY_SSH_PORT:-$(get DEPLOY_SSH_PORT)}"
KEY="${DEPLOY_SSH_KEY_PATH:-$(get DEPLOY_SSH_KEY_PATH)}"
REMOTE="/opt/agentic-qa"

if [ -z "${HOST:-}" ] || [ -z "${KEY:-}" ]; then
  echo "ERROR: DEPLOY_SSH_HOST / DEPLOY_SSH_KEY_PATH not set (check .env)"; exit 1
fi
SSH_OPTS=(-i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o BatchMode=yes)

echo "==> Syncing source to $USER_@$HOST:$REMOTE"
ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "mkdir -p $REMOTE; command -v rsync >/dev/null" || { echo "ERROR: rsync is not installed on the server (apt-get install -y rsync)"; exit 1; }
# --delete removes files deleted in git (tar only adds/overwrites, so a removed app/page.tsx kept
# shadowing the marketing page). Excluded paths are never deleted on the server, which protects
# .env.production, node_modules, build output and artifacts. Preview first: add -n to the rsync flags.
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude='node_modules' --exclude='.git' --exclude='.next' \
  --exclude='dist' --exclude='.turbo' --exclude='coverage' \
  --exclude='/artifacts' --exclude='/deploy' --exclude='/docs' \
  --exclude='*.zip' --exclude='/.env' --exclude='.env.production' --exclude='.env.local' \
  ./ "$USER_@$HOST:$REMOTE/"

# First run: upload the production env file. Later runs skip if absent locally
# so CI never needs the secrets.
if [ -f .env.production ]; then
  scp -i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no -o BatchMode=yes .env.production "$USER_@$HOST:$REMOTE/.env.production"
fi

COMPOSE="docker compose -f $REMOTE/infrastructure/compose/docker-compose.prod.yml --env-file $REMOTE/.env.production"

# On any remote failure, print what the server saw. Otherwise CI only shows
# "exit code 1" and the real cause (a crashed migration, a missing env var) stays on the VPS.
diagnose() {
  echo; echo "==> FAILED: remote state"
  ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "cd $REMOTE && $COMPOSE ps -a; for s in api worker web admin; do echo; echo \"----- logs: \$s (last 60 lines)\"; $COMPOSE logs --no-color --tail=60 \$s 2>&1; done" || true
}

echo "==> Building images (first build takes several minutes)"
ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "cd $REMOTE && $COMPOSE build --pull" || { echo "ERROR: image build failed (output above)"; exit 1; }

echo "==> Starting services"
ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "cd $REMOTE && $COMPOSE up -d --wait --remove-orphans" || { diagnose; exit 1; }

echo "==> Health checks"
# "up --wait" returns once containers are running, but the api still has to run
# `prisma migrate deploy` before it listens. Until then Docker's port forward
# accepts and resets the connection (curl exit 56), so retry instead of checking once.
fail=0
for check in "api:8080:/v1/health" "web:3004:/" "admin:8081:/"; do
  IFS=: read -r name port path <<<"$check"
  code="none"
  for attempt in $(seq 1 24); do
    code=$(ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$port$path || true")
    [ "$code" = "200" ] && break
    sleep 5
  done
  if [ "$code" = "200" ]; then echo "$name: OK"; else echo "$name: FAILED (last HTTP code $code on 127.0.0.1:$port$path after 2 minutes)"; fail=1; fi
done
[ "$fail" = 0 ] || { diagnose; exit 1; }
ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "$COMPOSE ps --format '{{.Name}} {{.Status}}'"
echo "==> Deploy complete"
