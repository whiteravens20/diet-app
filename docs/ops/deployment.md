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
cp .env.example .env            # then edit secrets
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml exec api npm run db:migrate -w apps/api
docker compose -f infra/docker-compose.yml exec api npm run db:seed     -w apps/api
```

Web → `:3000`, API → `:4000/api`, health → `:4000/api/health`.

## Development

```bash
docker compose -f infra/docker-compose.dev.yml up -d   # Postgres + Redis
npm install && npm run db:migrate && npm run db:seed
npm run dev                                            # web + api with HMR
```

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
