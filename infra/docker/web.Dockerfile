# ── Diet App web image ────────────────────────────────────────────────────────
# Multi-stage, Alpine, non-root. Uses Next.js standalone output for a minimal
# runtime image. Build context is the repo root.
#
# The base image is pinned by version and digest: the digest is what gets
# pulled, the version says what it is. Dependabot moves both
# (.github/dependabot.yml).

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
WORKDIR /app
# Upgrade the alpine ssl libs to pull the patched libcrypto3/libssl3
# (CVE-2026-45447, OpenSSL PKCS7_verify UAF).
RUN apk upgrade --no-cache libcrypto3 libssl3

# ── deps + build ──────────────────────────────────────────────────────────────
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
# The `/api/*` proxy target is baked into the build (Next.js rewrites are
# resolved at build time). Inside Compose this is the `api` service address.
ARG API_PROXY_URL=http://api:4000
ENV API_PROXY_URL=$API_PROXY_URL
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm ci
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace @diet-app/shared \
 && npm run build --workspace @diet-app/web

# ── runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# No package manager ships. The container starts plain `node`, so npm, corepack
# and yarn are build-time tools here; each carries a dependency tree of its own
# that an image scan reads like the app's.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* /root/.npm
# Next.js standalone bundle (server.js + a pruned node_modules).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
