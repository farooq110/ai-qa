# User docs (Fumadocs) — mounted under the main domain at /help via nginx.
FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
WORKDIR /repo

COPY . .
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && printf 'public-hoist-pattern[]=*prisma*\npublic-hoist-pattern[]=@prisma/*\n' > .npmrc

RUN pnpm install --frozen-lockfile \
 && pnpm --filter @ai-qa/user-docs build

# Served on :3020; nginx proxies prooflineqa.com/help/* to this container.
ENV PORT=3020 HOSTNAME=0.0.0.0 NODE_ENV=production
EXPOSE 3020
CMD ["node", "apps/user-docs/.next/standalone/apps/user-docs/server.js"]
