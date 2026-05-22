# Security Policy

## Reporting a Vulnerability

Please report security issues **privately**. Do not open a public issue.

- Use [GitHub Security Advisories](https://github.com/whiteravens20/diet-app/security/advisories/new), or
- email the maintainer (see the GitHub profile of `@pavlojs`).

Expect an acknowledgement within 72 hours. Please allow a reasonable window for a fix
before public disclosure.

## Supported Versions

Until the first stable release, only the `main` branch receives security fixes.

## Security Model & Checklist

Diet App stores **personal health-adjacent data** (age, weight, dietary preferences,
allergens) and **user-supplied AI API keys**. The following controls apply.

### Authentication & sessions

- [x] Passwords hashed with bcrypt (configurable cost, default 12).
- [x] Short-lived JWT access tokens + rotating refresh tokens.
- [x] Refresh tokens are revocable; password reset invalidates all sessions.
- [x] Password reset uses single-use, time-limited, hashed tokens.

### AI API key storage

- [x] Per-user provider keys encrypted at rest with **AES-256-GCM**.
- [x] Encryption key supplied via `AI_KEY_ENCRYPTION_SECRET` (env, never in DB).
- [x] Keys decrypted only in-process at call time; never logged, never returned to the
      client (write-only field — UI shows a masked placeholder).

### Authorization & data isolation

- [x] Every profile/plan/list query is scoped to the authenticated user.
- [x] Role-based access control for admin-only provider defaults.
- [x] All input validated with Zod schemas shared between client and server.

### Anti-abuse

- [x] Per-IP and per-user rate limiting on all endpoints; stricter limits on AI and
      plan-generation routes — **active even when Turnstile is disabled**.
- [x] Optional Cloudflare Turnstile on login, registration, password reset and
      anonymous AI-heavy endpoints; fully env-gated for key-free self-hosting.

### AI safety

- [x] AI output passes a deterministic validation layer: unknown ingredients are
      rejected or mapped to approved substitutes; all nutrition is recomputed from the
      curated database.
- [x] AI can never write nutrition facts, ignore allergens, or silently break the
      calorie target — deltas are always surfaced.

### Logging & privacy

- [x] Logs exclude passwords, tokens, API keys and raw health data.
- [x] `audit_logs` records security-relevant actions without sensitive payloads.

### Supply chain & containers

- [x] `.npmrc` with `ignore-scripts` and a release-age quarantine.
- [x] Multi-stage, non-root, Alpine-based Docker images.
- [x] CodeQL, `npm audit`, signature verification and Trivy scans in CI.

## Out of Scope

- Compromised client devices or malicious browser extensions.
- Sustained DDoS — deploy behind a CDN/WAF for that threat model.
- The security of third-party AI providers the user chooses to BYOK.
