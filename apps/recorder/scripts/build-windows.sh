#!/usr/bin/env bash
# Cross-builds the Windows installer (ProoflineRecorder-Setup.exe) from any
# Linux machine with Docker — no Windows host and no Wine install required
# (electron-builder's NSIS toolchain runs natively on Linux; see
# infrastructure/docker/recorder-build-win.Dockerfile). Run from the repo root:
#   ./apps/recorder/scripts/build-windows.sh [output-dir]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/apps/recorder/dist}"

IMAGE="proofline-recorder-build-win:latest"
docker build -f "$REPO_ROOT/infrastructure/docker/recorder-build-win.Dockerfile" -t "$IMAGE" "$REPO_ROOT"

CONTAINER=$(docker create "$IMAGE")
mkdir -p "$OUTPUT_DIR"
docker cp "$CONTAINER:/repo/apps/recorder/dist/ProoflineRecorder-Setup.exe" "$OUTPUT_DIR/ProoflineRecorder-Setup.exe"
docker rm "$CONTAINER" >/dev/null

echo "Built: $OUTPUT_DIR/ProoflineRecorder-Setup.exe"
echo "Installers are unsigned — Windows SmartScreen will warn on first run (More info -> Run anyway)."
