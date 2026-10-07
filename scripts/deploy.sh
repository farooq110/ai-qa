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
ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "mkdir -p $REMOTE"
tar czf - \
  --exclude='node_modules' --exclude='.git' --exclude='.next' \
  --exclude='dist' --exclude='.turbo' --exclude='coverage' \
  --exclude='./artifacts' --exclude='./deploy' --exclude='./docs' \
  --exclude='*.zip' --exclude='./.env' --exclude='.env.production' --exclude='.env.local' \
  -C . . | ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "tar xzf - -C $REMOTE"

# First run: upload the production env file. Later runs skip if absent locally
# so CI never needs the secrets.
if [ -f .env.production ]; then
  scp -i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no -o BatchMode=yes .env.production "$USER_@$HOST:$REMOTE/.env.production"
fi

echo "==> Building images (first build takes several minutes)"
ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "cd $REMOTE \
  && docker compose -f infrastructure/compose/docker-compose.prod.yml --env-file .env.production build --pull \
  && docker compose -f infrastructure/compose/docker-compose.prod.yml --env-file .env.production up -d --wait --remove-orphans"

echo "==> Health checks"
sleep 5
ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "\
  curl -sf http://127.0.0.1:8080/v1/health >/dev/null && echo 'api: OK' \
  && curl -sf http://127.0.0.1:3004/ >/dev/null && echo 'web: OK' \
  && curl -sf http://127.0.0.1:8081/ >/dev/null && echo 'admin: OK' \
  && docker compose -f $REMOTE/infrastructure/compose/docker-compose.prod.yml --env-file $REMOTE/.env.production ps --format '{{.Name}} {{.Status}}'"
echo "==> Deploy complete"
