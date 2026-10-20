# Recorder AppImage builder — old-glibc baseline for cross-distro compatibility.
# Debian 11 (bullseye) ships glibc 2.31, so the produced AppImage runs on any
# distro with glibc >= 2.31 (Ubuntu 20.04+, Debian 11+, Fedora 34+, Arch, RHEL 9).
# Building on a newer host would silently raise the glibc floor and break older distros.
FROM node:22-bullseye

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

WORKDIR /repo

# Dependencies first (cached layer): workspace manifests only.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/recorder/package.json apps/recorder/package.json

RUN pnpm install --frozen-lockfile --filter @ai-qa/recorder...

# Source + build (electron-builder downloads Electron and produces the AppImage).
COPY apps/recorder apps/recorder
RUN pnpm --filter @ai-qa/recorder exec electron-builder --linux AppImage

# Artifact is at /repo/apps/recorder/dist/ProoflineRecorder.AppImage
