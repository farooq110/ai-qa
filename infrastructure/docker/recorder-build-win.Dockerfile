# Recorder Windows installer builder — cross-compiles the NSIS setup from Linux.
#
# Unlike the AppImage baseline image, this container's own glibc does NOT matter:
# the artifact is a Windows executable. electron-builder downloads the Windows
# Electron distribution and its NSIS toolchain, but it runs rcedit.exe (which
# embeds the version/resource block into the exe) through Wine — so Wine lives
# INSIDE this image and the host machine needs nothing but Docker. Both the
# 32-bit (rcedit) and 64-bit loaders are installed.
FROM node:22-bookworm

RUN dpkg --add-architecture i386 \
  && apt-get update \
  && apt-get install -y --no-install-recommends wine wine32 wine64 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

WORKDIR /repo

# Dependencies first (cached layer): workspace manifests only.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/recorder/package.json apps/recorder/package.json

RUN pnpm install --frozen-lockfile --filter @ai-qa/recorder...

# Source + build (electron-builder downloads Windows Electron and produces the
# NSIS one-click, per-user installer).
COPY apps/recorder apps/recorder
RUN pnpm --filter @ai-qa/recorder exec electron-builder --win nsis

# Artifact is at /repo/apps/recorder/dist/ProoflineRecorder-Setup.exe
