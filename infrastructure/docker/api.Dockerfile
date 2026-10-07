# API control plane — full workspace install (prune can be added later)
FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
WORKDIR /repo

COPY . .
# openssl CLI is required for prisma generate to detect debian-openssl-3.0.x correctly;
# hoisting collapses multiple @prisma/client instances under pnpm into one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && printf 'public-hoist-pattern[]=*prisma*\npublic-hoist-pattern[]=@prisma/*\n' > .npmrc

RUN pnpm install --frozen-lockfile \
 && pnpm --filter @ai-qa/database generate \
 && pnpm --filter "@ai-qa/api..." run build

# Apply migrations then start (bootstrap.service seeds superadmin/plans on boot)
EXPOSE 4000
CMD ["sh", "-c", "pnpm --filter @ai-qa/database exec prisma migrate deploy && node apps/api/dist/main.js"]
