# Environment Variable Reference

Run `sh scripts/init-env.sh`: it writes `.env` from [`.env.example`](../../.env.example)
with the three secrets generated. The API validates every variable at boot
([`apps/api/src/config/env.ts`](../../apps/api/src/config/env.ts)) — a malformed
environment fails fast with a clear message.

Two rules apply to every variable:

- **A blank value means "not set".** `KEY=` uses the default; it is never read as an
  empty string.
- **Secrets must be secret.** The API refuses to start when `JWT_ACCESS_SECRET`,
  `AI_KEY_ENCRYPTION_SECRET`, `DATA_ENCRYPTION_SECRET` (and the optional
  `REVIEWER_SESSION_SECRET`, `SHIP_DOWNLOAD_TOKEN_SECRET`) are a template placeholder,
  too short, or made of a few repeated characters, or when two purposes share one value.

## Core
| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `production` / `test`. |
| `APP_URL` | `http://localhost:3000` | Public web origin (CORS, links). |
| `API_URL` | `http://localhost:4000` | Public API origin. |
| `WEB_PORT` / `API_PORT` | `3000` / `4000` | Host port bindings. |
| `SWAGGER_ENABLED` | on in development, off in production | Interactive API documentation at `/api/docs`. `true` or `false` decides for both. |
| `SEED_DATA_DIR` | the repository's `data/` | Where the curated data is read from. Set only for a non-standard layout. |

## Database
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | — | Postgres credentials. |
| `DATABASE_URL` | — | Full Postgres connection string. |

## Auth
| `JWT_ACCESS_SECRET` | — | Signs user access tokens. 32+ random characters (`openssl rand -hex 32`); the API refuses to start on a blank, short or template value. |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `900` / `2592000` | Token lifetimes (seconds). |
| `PASSWORD_HASH_ROUNDS` | `12` | bcrypt cost factor (8–15). |
| `DATA_ENCRYPTION_SECRET` | — | **64 hex chars.** Master secret: encrypts stored e-mail addresses and peppers password hashes. Changing it makes existing accounts unreadable: set it once and back it up with the database. |
| `REVIEWER_SESSION_SECRET` | derived from `DATA_ENCRYPTION_SECRET` | Signs the translation-reviewer cookie. Set a value of its own to rotate reviewer sessions separately. |

## AI
| `AI_KEY_ENCRYPTION_SECRET` | — | **64 hex chars** — AES-256-GCM key for user API keys. |
| `AI_DEFAULT_PROVIDER` | `ollama` | Admin default: `openai`/`anthropic`/`openrouter`/`ollama`. |
| `AI_DEFAULT_MODEL` | `llama3.1:8b` | Default model id. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | — | Optional admin keys. |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama instance URL. |
| `OLLAMA_USER_POLICY` | `allowlist` | Whether a user may point their own Ollama configuration at a host: `off` (never, not even at `OLLAMA_BASE_URL`), `allowlist` (only the host of `OLLAMA_BASE_URL` and `OLLAMA_ALLOWED_HOSTS`), `public` (any host that is not internal, private, loopback or reserved; the addresses the name resolves to are checked again when the connection is made). A user's configuration that points at `OLLAMA_BASE_URL` uses the operator's instance, so its calls count against the monthly limits below. A redirect from an Ollama server is never followed: configure the address it finally answers on. |
| `OLLAMA_ALLOWED_HOSTS` | — | Comma-separated `host` or `host:port` entries added to the allowlist. |
| `AI_ADMIN_USER_MONTHLY_LIMIT` | `40` | AI calls per user in a rolling 30 days when the operator's provider is used. Only calls the provider completed are counted: an error, a refused connection or a timeout costs the user nothing. `0` denies that mode. Users with their own key are not counted. |
| `AI_ADMIN_INSTANCE_MONTHLY_LIMIT` | `1000` | AI calls of all users together on the operator's provider in a rolling 30 days. This is the number that bounds the operator's bill, however many accounts are registered; once it is reached the provider is closed to everyone until calls age out, and users are told so. Counted like the per-user limit. |
| `FDC_API_KEY` | `DEMO_KEY` | USDA importer key — see [ops/deployment.md](deployment.md). |
| `FDC_DATA_TYPES` | `Foundation` | Comma-separated FDC dataTypes. Default ≈ 340 clean generic foods. Adding `SR Legacy` swells the corpus to ~7 k, but most additions are brand SKUs or hyper-specific cuts that pollute template-generated recipes — see [data/README.md](../../data/README.md#choosing-fdc_data_types). |

## Admin
| `ADMIN_USER` | `admin` | Basic-auth username for `/admin` + `/api/admin/*`. |
| `ADMIN_PASSWORD` | `` *(empty)* | Required to enable the panel. Empty or `CHANGE_ME_IMMEDIATELY` → every admin route returns 403 (fail-closed). |

## Anti-abuse
| `TURNSTILE_ENABLED` | `false` | Enable Cloudflare Turnstile. |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | — | Required only when enabled. |
| `RATE_LIMIT_WINDOW` | `60` | Rate-limit window (seconds), applies to every endpoint. |
| `RATE_LIMIT_MAX` | `120` | Requests per window and route, global default. Counted against the signed-in user, or against the client's address for a request without a sign-in. AI + plan-generation routes carry fixed tighter per-route limits (recipe draft 10, recipe submission 10, plan (re)generate 20, AI swap 30, ingredient swap 30, provider test 20/min) that are not operator-tunable. Sign-in and the other credential routes are limited per account or per token, see [deployment](deployment.md#rate-limits). |
| `TRUST_PROXY` | — | Whose word is taken for a client's address. Blank: the address of the connection, which behind the web server or a reverse proxy is the same for everybody. A number: that many reverse proxies stand in front of the app and their `X-Forwarded-For` is believed (`1` for one Traefik, Caddy or nginx). A list: the proxies' addresses or networks (`10.0.0.0/8,172.16.0.0/12`, or `loopback`, `linklocal`, `uniquelocal`). Set it only when the proxy is there and the app cannot be reached around it. `true` is refused. See [deployment](deployment.md#reverse-proxy). |

## Email (optional)
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | — | SMTP for mail. Unset → no mail is sent and the web app does not offer password reset. A reset requested straight from the API is logged outside production and dropped in production. |
| `SMTP_FROM` | `no-reply@diet-app.local` | From address. |

## Curation queue shipping
See [curation-shipping.md](curation-shipping.md) for the three ship modes.

| Variable | Default | Purpose |
|---|---|---|
| `INSTANCE_DATA_DIR` | `instance-data` | Where the local ship mode writes its backup of approved drafts. Private to the instance. |
| `SHIP_UPSTREAM_ENABLED` | `false` | Offer the "open a pull request" ship mode. Also needs a token and the `gh` binary. |
| `SHIP_UPSTREAM_REMOTE` / `SHIP_UPSTREAM_BASE_BRANCH` | `origin` / `main` | The git remote and branch a ship opens its pull request against. |
| `SHIP_UPSTREAM_GH_TOKEN` | — | Token the `gh` CLI uses to push and open the pull request. |
| `SHIP_UPSTREAM_GIT_AUTHOR_NAME` / `SHIP_UPSTREAM_GIT_AUTHOR_EMAIL` | — | Author of the commits a ship creates. |
| `SHIP_DOWNLOAD_TOKEN_SECRET` | derived from `DATA_ENCRYPTION_SECRET` | Signs the one-shot link of a bundle download. |
| `OVERRIDES_PULL_SOURCE` | `whiteravens20/diet-app` | Default repository (`owner/repo[@branch]`) or raw URL the admin panel pulls ingredient name overrides from. |
| `OVERRIDES_PULL_TOKEN` | `SHIP_UPSTREAM_GH_TOKEN` | Token for pulling from a private GitHub repository. Sent to GitHub hosts only. |

## What the instance publishes
Served by `GET /api/config` and read by the web app at run time.

| Variable | Default | Purpose |
|---|---|---|
| `SUPPORT_URL` | the project's page | Where the footer's "Support us" link points. |
| `OPERATOR_CONTACT` | *(none)* | E-mail address of whoever runs the instance, shown on the terms page. |
| `APP_VERSION` | the package version | Version label in the footer. |

## Web
| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | *(unset)* | Build-time. Leave unset: the browser then calls the API through the web app's own `/api` proxy. Set it only to make the browser call the API at another origin. |

Never commit `.env`. Generate a single secret with `openssl rand -hex 32`.
