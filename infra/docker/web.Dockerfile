# ── Diet App web image ────────────────────────────────────────────────────────
# Multi-stage, Alpine, non-root. Uses Next.js standalone output for a minimal
# runtime image. Build context is the repo root.

FROM node:24-alpine AS base
WORKDIR /app
# Upgrade the alpine ssl libs to pull the patched libcrypto3/libssl3
# (CVE-2026-45447, OpenSSL PKCS7_verify UAF).
RUN apk upgrade --no-cache libcrypto3 libssl3
# Match the host/CI npm pinned in package.json's packageManager field.
# Using `npm install -g` instead of corepack — npm's fetcher has built-in
# retries that corepack lacks, which matters on flaky build networks.
RUN npm install -g npm@11.17.0

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
# Next.js standalone bundle (server.js + a pruned node_modules).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
