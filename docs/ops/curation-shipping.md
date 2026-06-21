# Curation Queue — Shipping & Backup Guide

How approved drafts leave the admin curation queue (`/admin/curation`) and
where they end up. Pick the mode per ship action; **modes are not
mutually exclusive** — the same instance can stay local today, push to a
private backup repo next month, and migrate to a new server the month
after. The on-disk shape is identical across all three, so nothing locks
in.

## TL;DR

| You are… | Use mode | Why |
|---|---|---|
| A self-hoster with one instance | `local` (default) | Approved rows hit the DB immediately; sidecar JSON is a portable backup. |
| A self-hoster who wants off-box backup | `local` + private git mirror of `INSTANCE_DATA_DIR` | No app change — just `git push` the sidecar dir to a private remote. |
| A self-hoster running a private fork | `upstream-pr` pointing at your fork | Each ship opens a PR you review and merge into your own `main`. |
| The canonical-repo maintainer | `upstream-pr` pointing at `whiteravens20/diet-app` | Ships baseline updates for everyone. |
| Anyone moving to a fresh server | `zip` once + import on the new box | Universal, no remote required. |

The canonical curated baseline (`data/recipes.json`,
`data/ingredients.json`) always comes from the repo and re-seeds on
every `POST /api/admin/db/update`. Local-shipped rows layer on top via
`source = MANUAL`, so they survive every re-seed.

## The three modes

### `local` (default)

- Approved rows land directly in the live DB tables (`Recipe`,
  `RecipeTranslation`, `IngredientTranslation` …) with `source =
  MANUAL`.
- A sidecar JSON file is written under `INSTANCE_DATA_DIR` matching the
  on-disk shape of `data/recipes/<batchId>.json` and
  `data/ingredient-overrides.json`.
- `INSTANCE_DATA_DIR` is **gitignored in this repo by convention** —
  the directory is yours, not the project's. Mount it as a Docker
  volume so it survives container rebuilds.

The sidecar dir IS the backup. You don't need to enable anything else
to be safe locally.

### `upstream-pr`

- Uses `gh` CLI to branch from `SHIP_UPSTREAM_BASE_BRANCH` on
  `SHIP_UPSTREAM_REMOTE`, write the same JSON files into `data/recipes/`
  + `data/ingredient-overrides.json`, commit, push, open a PR.
- Disabled by default (`SHIP_UPSTREAM_ENABLED=false`). The admin UI
  hides the mode until the flag is on AND `gh` is on `PATH` with a
  valid token.
- **Important:** `SHIP_UPSTREAM_REMOTE` is whatever remote you have
  configured locally, not necessarily upstream. Pointing it at your
  own private fork is a fully supported flow (see scenario 2 below).
  Pointing it at `whiteravens20/diet-app` is reserved for the
  maintainer's clone.

### `zip`

- Bundles the approved rows into a one-shot signed download (10-min
  TTL). Always available, no remote required, no env vars.
- "Mark shipped" is a separate POST — downloading the zip does not flip
  rows to `SHIPPED`, so an accidental click is recoverable.

## Scenarios

### 1. Start local, stay local

Default behaviour. Nothing to configure beyond `INSTANCE_DATA_DIR`:

```env
INSTANCE_DATA_DIR=instance-data
SHIP_UPSTREAM_ENABLED=false
```

Mount `./instance-data` as a Docker volume on `api` and `worker`.
Approved rows hit the DB on every ship; the sidecar JSON accumulates
in the volume. **Back up that volume the way you back up Postgres** —
that single dir is enough to rebuild your custom catalogue on a fresh
instance.

### 2. Local now, add a private git backup later

Two no-app-change options:

**Option A — sync the dir to a private remote yourself**

```bash
cd instance-data
git init && git remote add backup git@github.com:you/my-diet-app-data.git
git add . && git commit -m "snapshot" && git push -u backup main
```

Add a host cron / systemd timer to repeat. The app doesn't know or
care; it just keeps writing files.

**Option B — turn on `upstream-pr` pointed at your fork**

```env
SHIP_UPSTREAM_ENABLED=true
SHIP_UPSTREAM_REMOTE=mybackup        # a remote on the container's git checkout
SHIP_UPSTREAM_BASE_BRANCH=main
DRAFT_SHIP_GH_TOKEN=ghp_…            # PAT with repo scope on your fork
```

Now the admin UI surfaces "Open PR" as a mode option. Each ship opens
a PR against your fork; merging is your call. The local-DB write
still happens — `upstream-pr` is **additive**, not a replacement, so
you keep the immediate availability of local mode AND get a reviewable
audit trail in git.

### 3. Migrate to a new server

The portable artefact is `INSTANCE_DATA_DIR` (or a clone of your
private backup repo from scenario 2). On the new server:

```bash
# 1. Bring your custom rows over
rsync -a old-server:/srv/diet-app/instance-data/ ./instance-data/
#    or: git clone git@github.com:you/my-diet-app-data.git instance-data

# 2. Boot the new stack with the same INSTANCE_DATA_DIR pointing at it
cp .env.example .env       # then set INSTANCE_DATA_DIR=instance-data
docker compose --env-file .env -f infra/docker-compose.yml up -d --build

# 3. Apply the canonical baseline + your overrides
#    /admin → Update Database — this seeds data/*.json AND globs
#    instance-data/recipes/*.json + instance-data/ingredient-overrides.json
```

The seeder treats the sidecar files the same way it treats
`data/recipes/<batchId>.json` — globbed in, upserted, written as
`source = MANUAL` translations. Re-seeds wipe `CURATED_JSON` rows but
leave `MANUAL` alone, so your imported rows stick.

### 4. Maintainer flow — push to canonical

Only on the maintainer's clone of `whiteravens20/diet-app`:

```env
SHIP_UPSTREAM_ENABLED=true
SHIP_UPSTREAM_REMOTE=origin
SHIP_UPSTREAM_BASE_BRANCH=main
DRAFT_SHIP_GH_TOKEN=ghp_…
DRAFT_SHIP_GIT_AUTHOR_NAME="Pavlo …"
DRAFT_SHIP_GIT_AUTHOR_EMAIL="…"
```

Ships open PRs against `main` for review like any other commit.
Reviewers vet the JSON; merging causes the next `db:seed` to pick up
the rows as `CURATED_JSON`.

## Env reference

| Variable | Default | Purpose |
|---|---|---|
| `INSTANCE_DATA_DIR` | `instance-data` | Where `local` mode writes sidecar JSON. Mount as a Docker volume so it survives rebuilds. Gitignored. |
| `SHIP_DEFAULT_MODE` | `local` | Preselected mode in the admin UI (`local` / `upstream-pr` / `zip`). The API rejects modes the operator hasn't opted into. |
| `SHIP_UPSTREAM_ENABLED` | `false` | Master switch for the `upstream-pr` mode. Off by default. |
| `SHIP_UPSTREAM_REMOTE` | `origin` | Git remote `upstream-pr` pushes to. Point at your private fork for backup, or `origin` if maintaining canonical. |
| `SHIP_UPSTREAM_BASE_BRANCH` | `main` | Base branch for the PR. |
| `DRAFT_SHIP_GH_TOKEN` | — | PAT with `repo` scope. Required when `SHIP_UPSTREAM_ENABLED=true`. |
| `DRAFT_SHIP_GIT_AUTHOR_NAME` / `_EMAIL` | — | Commit author identity for `upstream-pr`. |

`zip` mode reads no env — it's always available as the universal
fallback. `local` mode reads only `INSTANCE_DATA_DIR`.

## Invariants worth remembering

- **The deterministic engine owns nutrition.** Shipping a draft never
  invents macros; the engine recomputes from the curated ingredient DB
  on every PATCH and on every seed. See
  [adr/0008-curation-queue.md](../adr/0008-curation-queue.md).
- **`source = MANUAL` survives re-seeds.** The seeder's wipe at the
  start of each translation upsert only touches `CURATED_JSON` rows.
  Your `local`-shipped rows are safe across `npm run db:seed` and
  `POST /api/admin/db/update`.
- **No mode is a one-way door.** Switching `SHIP_DEFAULT_MODE`,
  enabling `SHIP_UPSTREAM_ENABLED`, or moving `INSTANCE_DATA_DIR` are
  all reversible env edits — the underlying data is the same JSON
  shape end-to-end.
