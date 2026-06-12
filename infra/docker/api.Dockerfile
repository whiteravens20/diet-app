# ── Diet App API (+ worker) image ─────────────────────────────────────────────
# Multi-stage, Alpine, non-root. The same image runs the HTTP API and the BullMQ
# worker — the compose service overrides the command for the worker.
# Build context is the repo root.

FROM node:24-alpine AS base
WORKDIR /app
# Prisma needs OpenSSL at build and runtime.
RUN apk add --no-cache openssl
# Match the host/CI npm pinned in package.json's packageManager field. Avoids
# split-brain between the npm shipped with node:24-alpine and the project pin.
# Using `npm install -g` instead of corepack — npm's fetcher has built-in
# retries that corepack lacks, which matters on flaky build networks.
RUN npm install -g npm@11.16.0

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
# src is needed by prisma/seed.ts, which imports the engine for deterministic
# recipe nutrition. It is also the input compiled into dist.
COPY --from=build /app/apps/api/src ./apps/api/src
COPY --from=build /app/data ./data
# Create the gitignored instance-data sidecar dir owned by the runtime user.
# A Docker named volume inherits ownership from the directory that exists at
# its mount path in the image; without this the volume (and a bind-mount
# mountpoint) defaults to root:root and the local-mode ship runner — which runs
# as `node` — gets EACCES writing its backup files (ingredient-overrides.json,
# recipes/<batch>.json).
RUN mkdir -p /app/instance-data/recipes && chown -R node:node /app/instance-data
USER node
EXPOSE 4000
# Default: HTTP API. The worker service overrides this with dist/worker.js.
CMD ["node", "apps/api/dist/main.js"]
