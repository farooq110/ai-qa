# Web app (dashboard) — Next.js standalone output
FROM node:22-slim AS build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Where the user-docs app lives for /help rewrites (user-docs container in prod)
ARG HELP_DOCS_URL
ENV HELP_DOCS_URL=$HELP_DOCS_URL
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@ai-qa/web..." run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
ENV PORT=3004 HOSTNAME=0.0.0.0 NODE_ENV=production
EXPOSE 3004
CMD ["node", "apps/web/server.js"]
