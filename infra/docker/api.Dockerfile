# ── Diet App API (+ worker) image ─────────────────────────────────────────────
# Multi-stage, Alpine, non-root. The same image runs the HTTP API and the
# scheduled-tasks worker — the compose service overrides the command for the
# worker. Build context is the repo root.
#
# The base image is pinned by version and digest: the digest is what gets
# pulled, the version says what it is. Dependabot moves both
# (.github/dependabot.yml).

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
WORKDIR /app
# Prisma needs OpenSSL at build and runtime. Upgrade the alpine ssl libs to pull
# the patched libcrypto3/libssl3 (CVE-2026-45447, OpenSSL PKCS7_verify UAF).
RUN apk add --no-cache openssl \
 && apk upgrade --no-cache libcrypto3 libssl3 openssl

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
# No package manager ships. The container starts plain `node` and Compose runs
# migrations through the Prisma CLI binary, so npm, corepack and yarn are
# build-time tools here; each carries a dependency tree of its own that an
# image scan reads like the app's.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* /root/.npm
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
