# Admin console — Next.js standalone output
FROM node:22-slim AS build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @ai-qa/admin build

FROM node:22-slim
WORKDIR /app
COPY --from=build /repo/apps/admin/.next/standalone ./
COPY --from=build /repo/apps/admin/.next/static ./apps/admin/.next/static
ENV PORT=3005 HOSTNAME=0.0.0.0 NODE_ENV=production
EXPOSE 3005
CMD ["node", "apps/admin/server.js"]
