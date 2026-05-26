# Environment Variable Reference

Copy [`.env.example`](../../.env.example) to `.env`. The API validates every variable at
boot ([`apps/api/src/config/env.ts`](../../apps/api/src/config/env.ts)) — a malformed
environment fails fast with a clear message.

## Core
| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `production` / `test`. |
| `APP_URL` | `http://localhost:3000` | Public web origin (CORS, links). |
| `API_URL` | `http://localhost:4000` | Public API origin. |
| `WEB_PORT` / `API_PORT` | `3000` / `4000` | Host port bindings. |

## Database & cache
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | — | Postgres credentials. |
| `DATABASE_URL` | — | Full Postgres connection string. |
| `REDIS_URL` | `redis://redis:6379` | Redis (cache + BullMQ). |

## Auth
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | — | 32+ random bytes each (`openssl rand -hex 32`). |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `900` / `2592000` | Token lifetimes (seconds). |
| `PASSWORD_HASH_ROUNDS` | `12` | bcrypt cost factor (8–15). |

## AI
| `AI_KEY_ENCRYPTION_SECRET` | — | **64 hex chars** — AES-256-GCM key for user API keys. |
| `AI_DEFAULT_PROVIDER` | `ollama` | Admin default: `openai`/`anthropic`/`openrouter`/`ollama`. |
| `AI_DEFAULT_MODEL` | `llama3.1:8b` | Default model id. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | — | Optional admin keys. |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama instance URL. |
| `FDC_API_KEY` | `DEMO_KEY` | USDA importer key — see [ops/deployment.md](deployment.md). |
| `FDC_DATA_TYPES` | `Foundation` | Comma-separated FDC dataTypes. `Foundation,SR Legacy` for the full ~8 k corpus (requires a real `FDC_API_KEY`). |

## Admin (F16)
| `ADMIN_USER` | `admin` | Basic-auth username for `/admin` + `/api/admin/*`. |
| `ADMIN_PASSWORD` | `` *(empty)* | Required to enable the panel. Empty or `CHANGE_ME_IMMEDIATELY` → every admin route returns 403 (fail-closed). |

## Anti-abuse
| `TURNSTILE_ENABLED` | `false` | Enable Cloudflare Turnstile. |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | — | Required only when enabled. |
| `RATE_LIMIT_WINDOW` | `60` | Rate-limit window (seconds). |
| `RATE_LIMIT_MAX` | `120` | Requests/window/IP, general endpoints. |
| `RATE_LIMIT_AI_MAX` | `20` | Requests/window/user, AI + plan generation. |

## Email (optional)
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | — | SMTP for password reset. Unset → reset links log to stdout (dev). |
| `SMTP_FROM` | `no-reply@diet-app.local` | From address. |

## Web
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | API origin baked into the web client. |

Never commit `.env`. Generate secrets with `openssl rand -hex 32`.
