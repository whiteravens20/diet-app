# ── Diet App API (+ worker) image ─────────────────────────────────────────────
# Multi-stage, Alpine, non-root. The same image runs the HTTP API and the BullMQ
# worker — the compose service overrides the command for the worker.
# Build context is the repo root.

FROM node:24-alpine AS base
WORKDIR /app
# Prisma needs OpenSSL at build and runtime.
RUN apk add --no-cache openssl

# ── deps + build ──────────────────────────────────────────────────────────────
FROM base AS build
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# `ignore-scripts` is on (see .npmrc) — Prisma is generated explicitly below.
RUN npm ci
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY data data
RUN npm run build --workspace @diet-app/shared \
 && npm run db:generate --workspace @diet-app/api \
 && npm run build --workspace @diet-app/api

# ── runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
# prisma.config.ts is required by the Prisma CLI for `migrate deploy` at runtime.
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/
COPY --from=build /app/data ./data
USER node
EXPOSE 4000
# Default: HTTP API. The worker service overrides this with dist/worker.js.
CMD ["node", "apps/api/dist/main.js"]
