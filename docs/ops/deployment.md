# Deployment

Docker-first and self-host-friendly: local, LAN-only, or cloud. No vendor lock-in.

## Images

| Image | Dockerfile | Notes |
|---|---|---|
| `diet-app-api` | `infra/docker/api.Dockerfile` | Multi-stage, Alpine, non-root. Runs the API; the worker reuses it with `node apps/api/dist/worker.js`. |
| `diet-app-web` | `infra/docker/web.Dockerfile` | Multi-stage; Next.js standalone output. |

Build context is the repo root. Both are built and tagged by the `release.yml` workflow
on a `vX.Y.Z` tag and pushed to GHCR with provenance + SBOM.

## Compose files

| File | Purpose |
|---|---|
| `infra/docker-compose.yml` | Production-like stack: web, api, worker, postgres, redis. |
| `infra/docker-compose.dev.yml` | Just Postgres + Redis — run the apps on the host with HMR. |
| `infra/docker-compose.gpu.yml` | Overlay giving Ollama NVIDIA GPU access. |

Profiles gate optional services: `--profile ollama` (local AI), `--profile proxy` (Traefik).

## Quick start

```bash
cp .env.example .env            # then edit secrets — incl. ADMIN_PASSWORD
docker compose -f infra/docker-compose.yml up -d --build
```

The `db-init` one-shot service applies pending Prisma migrations before `api`
and `worker` start, then exits. **The curated ingredient/recipe database is
not seeded automatically** — boot would otherwise stall for minutes loading
~7 k ingredients × ~30 k composed recipes. Populate it on first run via the
admin panel:

1. Browse to `http://localhost:3000/admin`, sign in with `ADMIN_USER` / `ADMIN_PASSWORD`.
2. (Optional) On the host, fetch USDA whole foods:
   `FDC_API_KEY=<key> FDC_DATA_TYPES='Foundation,SR Legacy' npm run import:usda`.
   This writes `data/ingredients.generated.json` — without it only the hand-
   curated baseline (~55 ingredients) is available.
3. Click **Update Database**. Subsequent edits or re-imports show
   "update available" via a sha256 of `data/*.json` stored in `SeedMeta`.

CLI alternative: `docker compose ... exec api npm run db:seed -w apps/api`.

Web → `:3000`, API → `:4000/api`, health → `:4000/api/health`.

## Development

```bash
docker compose -f infra/docker-compose.dev.yml up -d   # Postgres + Redis
npm install && npm run db:migrate
npm run dev                                            # web + api with HMR
```

Same first-run rule: populate the DB from `/admin` (or run `npm run db:seed`).

## Reverse proxy

`--profile proxy` starts Traefik (`infra/traefik/`), routing `/` → web and `/api` → api on
one entrypoint. For TLS, add a `websecure` entrypoint and a cert resolver. Traefik is
optional — any reverse proxy works; expose only the proxy port publicly.

## Ollama / GPU

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.gpu.yml \
  --profile ollama up -d
docker compose exec ollama ollama pull llama3.1:8b
```

Set `AI_DEFAULT_PROVIDER=ollama` and `OLLAMA_BASE_URL=http://ollama:11434`. GPU mode needs
the NVIDIA Container Toolkit on the host.

## Production notes

- Set strong `JWT_*` secrets and a 64-hex `AI_KEY_ENCRYPTION_SECRET` (`openssl rand`).
- Persisted volumes: `postgres-data`, `redis-data`, `ollama-models`.
- Health checks are defined for every long-running service.
- Run `db:migrate` (not `migrate dev`) on deploy; back up the Postgres volume.
- Bind published ports to a private interface in LAN-only deployments.
