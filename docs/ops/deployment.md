# Deployment

Docker-first and self-host-friendly: local, LAN-only, or cloud. No vendor lock-in.

## Image

There is one image, `diet-app`, built from `infra/docker/Dockerfile`: multi-stage,
Alpine, non-root, with no package manager inside. Every service runs from it and
differs only by its command, so one tag pins the whole application and the web can
never be from a different version than the API it talks to.

| Role | Command |
|---|---|
| API | `node apps/api/dist/main.js` (the image's default) |
| Scheduled-tasks worker | `node apps/api/dist/worker.js` |
| Migrations (`db-init`) | `/app/node_modules/.bin/prisma migrate deploy`, in `/app/apps/api` |
| Web front-end | `node /web/apps/web/server.js` (Next.js standalone output) |

Build context is the repo root. The `release.yml` workflow builds the image on a
`vX.Y.Z` tag and pushes it to GHCR with provenance + SBOM; it is disabled while the
project is in development.

## Compose files

| File | Purpose |
|---|---|
| `infra/docker-compose.yml` | Production-like stack: web, api, worker, postgres. |
| `infra/docker-compose.dev.yml` | Just Postgres — run the apps on the host with HMR. |
| `infra/docker-compose.gpu.yml` | Overlay giving Ollama NVIDIA GPU access. |

Profiles gate optional services: `--profile ollama` (local AI), `--profile proxy` (Traefik).

## Quick start

```bash
sh scripts/init-env.sh          # writes .env with freshly generated secrets
#                                 then set ADMIN_PASSWORD in it
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
```

> **Why `--env-file .env`?** The compose file lives in `infra/`, so Compose looks
> for its interpolation `.env` in `infra/` — not the repo root. Without the flag,
> every `${VAR:-default}` in the compose file (`WEB_PORT`, `API_PORT`,
> `POSTGRES_*`, `IMAGE_TAG`) silently falls back to its default and any non-default
> override in your root `.env` is ignored. (Runtime secrets still load via
> `env_file:`; this only affects `${...}` placeholders.) See the header comment in
> [`infra/docker-compose.yml`](../../infra/docker-compose.yml) for the full
> explanation.

The `db-init` one-shot service applies pending Prisma migrations before `api`
and `worker` start, then exits. **The curated ingredient/recipe database is
not seeded automatically** — boot would otherwise stall for minutes loading
~7 k ingredients × ~30 k composed recipes. Populate it on first run via the
admin panel:

1. Browse to `http://localhost:3000/admin`, sign in with `ADMIN_USER` / `ADMIN_PASSWORD`.
2. (Optional) On the host, fetch USDA whole foods:
   `FDC_API_KEY=<key> npm run import:usda` (defaults to **Foundation**, ~340
   generic foods). Writes `data/ingredients.generated.json` — without it only the
   hand-curated baseline (~55 ingredients) is available. `FDC_DATA_TYPES` can
   include `SR Legacy` for the full ~7 k corpus, but see
   [data/README.md](../../data/README.md#choosing-fdc_data_types) for why that
   is rarely worth it.
3. Click **Update Database**. Subsequent edits or re-imports show
   "update available" via a sha256 of `data/*.json` stored in `SeedMeta`.

CLI alternative (the image ships no npm, so the seed runs through its binary):
`docker compose ... exec -w /app/apps/api api /app/node_modules/.bin/tsx prisma/seed.ts`.

Web → `:3000`, API → `:4000/api`, health → `:4000/api/health`.

## Development

```bash
docker compose -f infra/docker-compose.dev.yml up -d   # Postgres
npm install && npm run db:migrate
npm run dev                                            # web + api with HMR
```

Same first-run rule: populate the DB from `/admin` (or run `npm run db:seed`).

## Reverse proxy

`--profile proxy` starts Traefik (`infra/traefik/`), routing `/` → web and `/api` → api on
one entrypoint. For TLS, add a `websecure` entrypoint and a cert resolver. Traefik is
optional — any reverse proxy works; expose only the proxy port publicly.

A request that asks an AI model can take up to 60 seconds before the API answers (see
[AI model recommendations](ai-models.md#limits-on-every-request)). Give the proxy a read
timeout above that — 90 seconds matches the web front-end's own. Traefik has none by
default; nginx stops at 60 seconds unless `proxy_read_timeout` is raised.

### Telling the API who the client is

The API never sees a visitor's own connection: requests reach it from the web server, or
from the reverse proxy. Left alone it therefore takes every visitor for one client. The
visitor's address arrives in the `X-Forwarded-For` header, which the API believes only
when told to, because without a proxy in front anybody can write that header themselves.

1. Put a reverse proxy in front and make sure the app cannot be reached around it. With
   `docker-compose.prod.yml` the web port is bound to `127.0.0.1` for exactly this; with
   `--profile proxy`, publish only Traefik's port.
2. Let the proxy write the header. Traefik and Caddy do so on their own. nginx needs
   `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
3. Set `TRUST_PROXY=1` in `.env` and restart the API. With a CDN or a second proxy in
   front of the first, count that one too: `TRUST_PROXY=2`.

Never set `TRUST_PROXY` on an instance whose web or API port is reachable directly: a
visitor could then claim any address, and with it somebody else's allowance.

### Rate limits

Every route is limited, and a request is counted against the most specific thing that
is known about its sender:

| Request | Counted against | Limit |
|---|---|---|
| With a valid sign-in | The user | `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW` and route; less on AI routes |
| Sign-in | The account being signed in to | 10 a minute |
| Password-reset request | The address the reset is for | 5 in 15 minutes |
| Token refresh, sign-out, links from mails | The token presented | 10 a minute |
| Changing the password or address, deleting the account | The user | 5 a minute each |
| Creating an account, everything else without a sign-in | The client's address | 10 a minute for sign-up, otherwise `RATE_LIMIT_MAX` |
| Health and public configuration | Not limited | |

So wrong passwords for one account slow down that account's sign-in and nobody else's,
whether or not `TRUST_PROXY` is set. What is counted against the address is only as good
as the address: without `TRUST_PROXY` it is one allowance for the whole instance, and
sign-ups, for example, stop for everybody once ten were tried in a minute.

## Ollama / GPU

```bash
docker compose --env-file .env \
  -f infra/docker-compose.yml -f infra/docker-compose.gpu.yml \
  --profile ollama up -d
docker compose exec ollama ollama pull llama3.1:8b
```

Set `AI_DEFAULT_PROVIDER=ollama` and `OLLAMA_BASE_URL=http://ollama:11434`. GPU mode needs
the NVIDIA Container Toolkit on the host.

## Anti-abuse (Turnstile)

Cloudflare Turnstile is **optional** and **off by default** (`TURNSTILE_ENABLED=false`);
rate limiting protects the auth endpoints regardless. To turn it on, set all three:

```env
TURNSTILE_ENABLED=true
TURNSTILE_SITE_KEY=0x...      # public — served to the browser via GET /api/config
TURNSTILE_SECRET_KEY=0x...    # secret — stays on the server
```

The widget then renders on **Register, Login, and Forgot-password**; the front-end
reads the site key from `/api/config` at runtime, so no web rebuild is needed to
flip it. With `TURNSTILE_ENABLED=true` but the keys missing, verification
fails closed (every submit is rejected).

## Email (SMTP)

Email is **optional**. "Configured" means **`SMTP_HOST` is set**:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587                 # 465 = implicit TLS; 587/25 = STARTTLS
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=no-reply@your-domain
```

Behaviour switches on whether SMTP is configured:

| Action | SMTP configured | SMTP blank |
|---|---|---|
| Register | account starts **unverified** + a confirmation email is sent | account is **auto-verified** at creation (nothing to verify against) |
| Forgot password | reset link is **emailed** | **not available** — the sign-in page has no link and the reset page says so. A request sent straight to the API is still accepted: outside production its link is **logged to the api stdout**, in production nothing is logged |
| Change password (in Settings) | applies immediately + a "password changed" **notice email** | applies immediately, no email |
| **Change email** (in Settings) | confirmation link emailed to the **new** address; change lands on confirm | **not available** — the option is hidden |

Changing the account email is the one action gated entirely on SMTP. All confirmation
links expire after 1 hour.

## Production notes

- Set strong `JWT_*` secrets and a 64-hex `AI_KEY_ENCRYPTION_SECRET` (`openssl rand`).
- Persisted volumes: `postgres-data`, `ollama-models`.
- PostgreSQL, the API and the web front-end have health checks; the API's fails when it cannot reach the database. The worker has none: Docker restarts it when its process exits.
- Run `db:migrate` (not `migrate dev`) on deploy; back up the Postgres volume.
- Bind published ports to a private interface in LAN-only deployments.

### Server clock

Rolling-window features (e.g. the monthly AI quota, refresh-token TTLs,
password-reset expiry) anchor on **the database's `NOW()`**, not the api
container's wall clock — Postgres is the single source of truth for "now",
so a drifting api container can't expire a user's quota early or late. The
only requirement is that **Postgres itself runs on a sane clock**:

- The official `postgres:*` image inherits the host's clock. Make sure the
  Docker host runs NTP (`systemd-timesyncd`, `chrony`, etc.).
- All `TIMESTAMP` columns store UTC. Don't set `TZ=` on the `postgres`
  service unless you understand the consequences for `NOW()` vs.
  `CURRENT_TIMESTAMP` — leave it default (`UTC`).
- The web client renders rolling-window times via `Intl.DateTimeFormat`, so
  the user always sees their browser-local time.
