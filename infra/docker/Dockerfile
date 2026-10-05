# ── Diet App image ────────────────────────────────────────────────────────────
# One image, several roles. It holds the built API (with the scheduled-tasks
# worker and the Prisma CLI that runs migrations) and the built web front-end.
# Compose starts one container per role from it, each with its own command:
#
#   api      node apps/api/dist/main.js                    (the default)
#   worker   node apps/api/dist/worker.js
#   db-init  /app/node_modules/.bin/prisma migrate deploy   (in /app/apps/api)
#   web      node /web/apps/web/server.js
#
# One image means one tag to pull and pin: the web and the API it talks to can
# never be from different versions. Multi-stage, Alpine, non-root. Build
# context is the repo root.
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

# ── build: everything, with dev dependencies ──────────────────────────────────
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
# The `/api/*` proxy target is baked into the web build (Next.js rewrites are
# resolved at build time). Inside Compose this is the `api` service address.
ARG API_PROXY_URL=http://api:4000
ENV API_PROXY_URL=$API_PROXY_URL
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Install scripts stay off, as .npmrc sets them for every other install.
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
COPY data data
RUN npm run build --workspace @diet-app/shared \
 && npm run db:generate --workspace @diet-app/api \
 && npm run build --workspace @diet-app/api \
 && npm run build --workspace @diet-app/web

# ── api-deps: what the API needs to run, and nothing it only needs to build ───
# The web brings its own traced modules in the Next.js standalone bundle, so
# this tree is the API workspace alone. The Prisma CLI and tsx are production
# dependencies of the API: migrations and the seed run inside the shipped
# image. Install scripts stay off here too, with one exception run by name:
# Prisma's, which downloads the schema engine that `migrate deploy` needs.
FROM base AS api-deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @diet-app/api --ignore-scripts \
 && npm rebuild @prisma/engines
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/
RUN npm run db:generate --workspace @diet-app/api

# ── runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# No package manager ships. Every role starts plain `node` or the Prisma CLI
# binary, so npm, corepack and yarn are build-time tools here; each carries a
# dependency tree of its own that an image scan reads like the app's.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* /root/.npm

# API, worker and migrations live under /app.
COPY --from=api-deps /app/node_modules ./node_modules
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

# The web front-end lives under /web: the Next.js standalone bundle (server.js
# and its own pruned node_modules), kept apart from the API's modules.
COPY --from=build /app/apps/web/.next/standalone /web
COPY --from=build /app/apps/web/.next/static /web/apps/web/.next/static
COPY --from=build /app/apps/web/public /web/apps/web/public

USER node
EXPOSE 4000 3000
# Default: HTTP API. The other roles override the command.
CMD ["node", "apps/api/dist/main.js"]
