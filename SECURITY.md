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
- [x] An access token holds the account's id and nothing else about the account; every signed token is made with one fixed algorithm and says what it is for, and a reader asks for both
- [x] Refresh tokens stored hashed and revocable — rotated on use, revoked on logout and on password reset
- [x] Password-reset, e-mail-verification and e-mail-change tokens are single-use, time-limited and stored hashed
- [x] A password-reset link is never written to the log in production; without SMTP it is logged outside production only
- [x] Optional two-step sign-in for accounts and for the administrator: a code from an authenticator app (RFC 6238) after the password. The secret is encrypted at rest and bound to its owner, and a code is accepted once
- [x] Wrong codes are counted with the account, wherever they come from and across restarts: after five in a row the next one waits, half a minute at first and twice as long after each further one, up to a day. Codes for one account are looked at one after another, so sending many at once is no way around the count
- [x] Ten single-use recovery codes per account, kept as keyed hashes; a password reset by mail does not remove the second step
- [x] A session of an account with two-step sign-in counts only if it passed the second step; switching it on ends every session that did not
- [x] The account is told by mail when two-step sign-in is switched on or off, when a recovery code is used, and when somebody who knows the password gets the code wrong five times in a row
- [x] Reviewer sessions use their own signed cookie (`httpOnly`, `SameSite=Strict`, `Secure` behind HTTPS); a reviewer token is rejected as a user access token, and an access token as a reviewer session

### Data at Rest

- [x] E-mail addresses encrypted with AES-256-GCM; lookups go through a keyed HMAC-SHA256 blind index, never the plaintext
- [x] A stored ciphertext is bound to the account it belongs to and to the kind of value it is: copied into another row or another column it does not open. The authentication tag has one fixed length
- [x] Per-user AI provider keys encrypted with AES-256-GCM under `AI_KEY_ENCRYPTION_SECRET`, which lives in the environment, never in the database
- [x] Provider keys decrypted in-process at call time only — never logged, never returned to the client
- [x] Independent keys for encryption, blind indexing and the password pepper, derived with HKDF from one configured secret

### Authorization and Data Isolation

- [x] Every profile, plan, shopping-list, favourite and inventory query is scoped to the authenticated user
- [x] A recipe referenced from a plan or a favourite set must be one the user may see — curated, or their own
- [x] Admin panel and `/api/admin/*` behind a session the administrator signs in for once: an `httpOnly`, `SameSite=Strict` cookie limited to the admin routes, signed with a key of its own, good for eight hours, and ended early by a change of the credentials or by "end every admin session". The password is compared in constant time and travels with no later request; closed when `ADMIN_PASSWORD` is unset or left at its placeholder
- [x] Requests that change something with an administrator's or a reviewer's session, and their sign-ins, are taken only from the application's own pages (`Origin`)
- [x] Reviewer sessions end for good when the reviewer password changes or the panel is closed
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
- [x] Pages carry an enforced Content-Security-Policy with a value made for each response: only the application's own scripts run, no script makes code from text, and nothing is loaded from or sent to another site
- [x] What a browser blocks under that policy is reported to the API, which counts it in its log
- [x] Security headers on the API and the web: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and HSTS where the instance's address is https
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
- [x] OS packages brought up to date at every build of the image, not left as the base image had them
- [x] Install scripts off in the image build, except Prisma's engine download

### Supply Chain

- [x] 7-day dependency quarantine — Dependabot `cooldown: default-days: 7` on every ecosystem, so a freshly published version is never proposed. Security advisories are exempt and land immediately.
- [x] `.npmrc` with `ignore-scripts=true` and `min-release-age=7` as the client-side backstop for manual installs
- [x] Registry signatures verified in CI (`npm audit signatures`)
- [x] `npm audit`, Trivy (repository and image), CodeQL and dependency review in CI
- [x] GitHub Actions pinned to commit SHAs and checked against their tags on every run

### What This Does NOT Protect Against

| Threat vector                                            | Why it is out of scope                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Compromised client device or malicious browser extension | Session tokens and everything the user sees live in the browser; malware or an extension can read them           |
| Content injection in the web app                         | The web pages' Content-Security-Policy is sent report-only and is not enforced yet                               |
| Third-party AI providers                                 | Prompts, and the data in them, go to the provider the user chose; its security and retention are outside the app |
| A malicious or compromised admin                         | The admin account can change curated data and make the server fetch a URL of its choice                          |
| The operator's deployment                                | TLS termination and network exposure belong to the reverse proxy in front of the stack                           |
| Sustained DDoS                                           | Rate limiting covers casual abuse; deploy behind a CDN or WAF for sustained attacks                              |
