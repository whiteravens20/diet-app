# Security — Diet App

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/whiteravens20/diet-app/security/advisories/new). Please do not open a public issue, discussion or pull request for a security bug.

Include the version or commit you tested, the steps that reproduce the problem and the impact you expect. You will get a first reply within a week. A confirmed issue is fixed on the `dev` branch, and the advisory credits you unless you ask otherwise.

## Supported versions

Diet App has no release yet and is not production ready. Until the first release, security fixes land on the `dev` branch only.

## Security checklist

What the code guarantees today, and what it deliberately does not protect against. Diet App stores personal health-adjacent data (age, weight, dietary preferences, allergens) and the AI provider keys its users supply.

### Authentication and Sessions

- [x] Passwords hashed with bcrypt (cost configurable, 12 by default) after an HMAC-SHA256 pepper
- [x] Login runs the hash comparison for an unknown account too, so response time does not reveal whether an e-mail is registered
- [x] Short-lived JWT access tokens (15 minutes by default) and rotating refresh tokens
- [x] Refresh tokens stored hashed and revocable — rotated on use, revoked on logout and on password reset
- [x] Password-reset, e-mail-verification and e-mail-change tokens are single-use, time-limited and stored hashed
- [x] A password-reset link is never written to the log in production; without SMTP it is logged outside production only
- [x] Reviewer sessions use their own signed cookie (`httpOnly`, `SameSite=Lax`, `Secure` behind HTTPS); a reviewer token is rejected as a user access token

### Data at Rest

- [x] E-mail addresses encrypted with AES-256-GCM; lookups go through a keyed HMAC-SHA256 blind index, never the plaintext
- [x] Per-user AI provider keys encrypted with AES-256-GCM under `AI_KEY_ENCRYPTION_SECRET`, which lives in the environment, never in the database
- [x] Provider keys decrypted in-process at call time only — never logged, never returned to the client
- [x] Independent keys for encryption, blind indexing and the password pepper, derived with HKDF from one configured secret

### Authorization and Data Isolation

- [x] Every profile, plan, shopping-list, favourite and inventory query is scoped to the authenticated user
- [x] A recipe referenced from a plan or a favourite set must be one the user may see — curated, or their own
- [x] Admin panel and `/api/admin/*` behind HTTP Basic Auth with timing-safe comparison; closed when `ADMIN_PASSWORD` is unset or left at its placeholder
- [x] All input validated with Zod schemas shared between client and server

### Anti-Abuse

- [x] Rate limiting on every endpoint, active whether or not Turnstile is on
- [x] Tighter limits on authentication, AI, plan-generation, reviewer-login and admin generation routes
- [x] Cloudflare Turnstile integration (optional) on login, registration and password reset — fails closed when enabled without a secret key
- [x] Outbound probes of an AI provider carry a 10-second timeout

### Server-Side Request Forgery

- [x] A user-supplied Ollama address is checked against the operator's policy (`OLLAMA_USER_POLICY`: `off`, `allowlist` by default, or `public`) when it is saved, when it is tested and again when it is dialled
- [x] In `public` mode, private, loopback, link-local and carrier-grade NAT addresses are refused, for IPv4 and IPv6

### HTTP Surface

- [x] API responses carry a Content-Security-Policy that loads nothing and forbids framing
- [x] Security headers on the API and the web: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy
- [x] CORS restricted to `APP_URL`
- [x] Swagger UI and the OpenAPI document are off in production unless `SWAGGER_ENABLED` is set
- [x] Unhandled errors return a generic response without a stack trace

### AI Safety

- [x] AI output passes a deterministic validation layer — unknown ingredients are rejected or mapped to approved substitutes, and all nutrition is recomputed from the curated database
- [x] AI never writes nutrition facts; the app works with no AI key at all

### Container Security

- [x] One multi-stage, Alpine-based image, running as a non-root user
- [x] No package manager in the image
- [x] Base image pinned by version and digest
- [x] Install scripts off in the image build, except Prisma's engine download

### Supply Chain

- [x] 7-day dependency quarantine — Dependabot `cooldown: default-days: 7` on every ecosystem, so a freshly published version is never proposed. Security advisories are exempt and land immediately.
- [x] `.npmrc` with `ignore-scripts=true` and `min-release-age=7` as the client-side backstop for manual installs
- [x] Registry signatures verified in CI (`npm audit signatures`)
- [x] `npm audit`, Trivy (repository and image), CodeQL and dependency review in CI
- [x] GitHub Actions pinned to commit SHAs and checked against their tags on every run

### What This Does NOT Protect Against

| Threat vector | Why it is out of scope |
|---|---|
| Compromised client device or malicious browser extension | Session tokens and everything the user sees live in the browser; malware or an extension can read them |
| Content injection in the web app | The web pages' Content-Security-Policy is sent report-only and is not enforced yet |
| Third-party AI providers | Prompts, and the data in them, go to the provider the user chose; its security and retention are outside the app |
| A malicious or compromised admin | The admin account can change curated data and make the server fetch a URL of its choice |
| The operator's deployment | TLS termination and network exposure belong to the reverse proxy in front of the stack |
| Sustained DDoS | Rate limiting covers casual abuse; deploy behind a CDN or WAF for sustained attacks |
