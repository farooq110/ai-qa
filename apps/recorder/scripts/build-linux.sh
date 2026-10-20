#!/usr/bin/env bash
# Builds the Linux AppImage inside the old-glibc baseline container (Debian 11 /
# glibc 2.31) so the artifact runs across distros. Run from the repo root:
#   ./apps/recorder/scripts/build-linux.sh [output-dir]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/apps/recorder/dist}"

IMAGE="proofline-recorder-build:latest"
docker build -f "$REPO_ROOT/infrastructure/docker/recorder-build.Dockerfile" -t "$IMAGE" "$REPO_ROOT"

CONTAINER=$(docker create "$IMAGE")
mkdir -p "$OUTPUT_DIR"
docker cp "$CONTAINER:/repo/apps/recorder/dist/ProoflineRecorder.AppImage" "$OUTPUT_DIR/ProoflineRecorder.AppImage"
docker rm "$CONTAINER" >/dev/null
chmod +x "$OUTPUT_DIR/ProoflineRecorder.AppImage"

echo "Built: $OUTPUT_DIR/ProoflineRecorder.AppImage"
echo "Max supported glibc baseline: 2.31 (Ubuntu 20.04+, Debian 11+, Fedora 34+, Arch, RHEL 9)."
