#!/usr/bin/env bash
#
# Upload Proofline Recorder installers from apps/recorder/dist to S3,
# into the bucket's WebViewRecorder/ folder.
#
# Usage:
#   ./scripts/upload-recorder-installers.sh              # same as "all"
#   ./scripts/upload-recorder-installers.sh all          # check + upload all three platforms
#   ./scripts/upload-recorder-installers.sh windows      # only ProoflineRecorder-Setup.exe
#   ./scripts/upload-recorder-installers.sh linux        # only ProoflineRecorder.AppImage
#   ./scripts/upload-recorder-installers.sh mac          # only ProoflineRecorder.dmg
#
# For every selected installer, the Node uploader (scripts/upload-installer.mjs):
#   - checks whether the file already exists in s3://<bucket>/WebViewRecorder/,
#   - replaces an existing object with the latest local version,
#   - always uploads the local file from apps/recorder/dist.
#
# Configuration (first non-empty wins): real AWS_* environment variables, then
# the repo root .env file:
#   AWS_S3_BUCKET_NAME  (required — no fallback)
#   AWS_S3_REGION       (optional, default us-east-1)
#   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY   OR no keys at all — then the AWS
#   credential chain is used (~/.aws/credentials via `aws configure`, AWS_PROFILE,
#   container/instance roles).
#
# Exit codes: 0 = every selected upload succeeded, 1 = bad usage or upload failure.

set -euo pipefail

PLATFORM="${1:-all}"

case "$PLATFORM" in
  all|windows|linux|mac) ;;
  *)
    echo "Usage: $0 [all|windows|linux|mac]"
    echo ""
    echo "  all      upload (check + replace) installers for all three platforms"
    echo "  windows  upload only ProoflineRecorder-Setup.exe"
    echo "  linux    upload only ProoflineRecorder.AppImage"
    echo "  mac      upload only ProoflineRecorder.dmg"
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT/apps/recorder/dist"
ENV_FILE="$ROOT/.env"

# Read one KEY=VALUE from the root .env (last assignment wins; "export " prefix,
# surrounding quotes, and trailing inline comments are stripped). Display only —
# the Node uploader re-resolves everything and remains the source of truth.
env_value() {
  local key="$1" line value
  [ -f "$ENV_FILE" ] || { printf ''; return; }
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed -E -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
                                          -e 's/^"([^"]*)".*$/\1/' -e "s/^'([^']*)'.*$/\1/" \
                                          -e 's/[[:space:]]+#.*$//')"
  printf '%s' "$value"
}

# Which local files this run will consider (mirrors the Node uploader's mapping).
declare -A INSTALLERS=(
  [linux]="ProoflineRecorder.AppImage"
  [windows]="ProoflineRecorder-Setup.exe"
  [mac]="ProoflineRecorder.dmg"
)

if [ "$PLATFORM" = "all" ]; then
  SELECTED=(linux windows mac)
else
  SELECTED=("$PLATFORM")
fi

# ── Pre-flight: what the uploader will authenticate with ────────────────────
BUCKET="${AWS_S3_BUCKET_NAME:-$(env_value AWS_S3_BUCKET_NAME)}"

echo "Proofline Recorder installer upload — target: s3://${BUCKET:-<AWS_S3_BUCKET_NAME not set>}/WebViewRecorder/"
if [ -z "$BUCKET" ]; then
  if [ -f "$ENV_FILE" ]; then
    echo "  ⚠️  $ENV_FILE exists but does not set AWS_S3_BUCKET_NAME — fill in the \"AWS S3 CONFIG\" section."
  else
    echo "  ⚠️  $ENV_FILE not found — copy .env.example to .env and fill in the \"AWS S3 CONFIG\" section."
  fi
fi

if [ -f "$ENV_FILE" ]; then
  ENV_KEYS="$(env_value AWS_ACCESS_KEY_ID)"
  CRED_SRC=""
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && CRED_SRC="environment"
  [ -n "$ENV_KEYS" ] && CRED_SRC="${CRED_SRC:+$CRED_SRC + }.env"
  if [ -n "$CRED_SRC" ]; then
    echo "  Credentials: explicit AWS keys ($CRED_SRC)"
  elif [ -f "${HOME}/.aws/credentials" ] || [ -f "${HOME}/.aws/config" ]; then
    echo "  Credentials: no AWS keys in .env — using the AWS credential chain (~/.aws present)"
  else
    echo "  Credentials: ⚠️  no AWS keys in .env and no ~/.aws/credentials — the upload will fail."
    echo "               Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in .env, or run: aws configure"
  fi
else
  echo "  Env file:    $ENV_FILE — not found (using environment variables only)"
fi
echo "Local installers dir: $DIST_DIR"
echo ""
for plat in "${SELECTED[@]}"; do
  file="${INSTALLERS[$plat]}"
  if [ -f "$DIST_DIR/$file" ]; then
    size="$(du -h "$DIST_DIR/$file" | cut -f1)"
    echo "  [$plat] $file — found locally ($size)"
  else
    echo "  [$plat] $file — NOT FOUND locally (build it first: pnpm --filter @ai-qa/recorder dist)"
  fi
done
echo ""

# Delegate to the Node uploader: existence check in S3 + replace with the local file.
exec node "$ROOT/scripts/upload-installer.mjs" "$PLATFORM"
