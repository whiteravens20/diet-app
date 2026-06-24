# Security

Security documentation for the Diet App. The pre-release security gate is part of
[F100](../release/F100-prerelease-audit.md), re-run before every tag.

| Document | What it covers |
|---|---|
| [posture.md](./posture.md) | The control map — auth, sessions, CSRF/same-site, encryption at rest, headers, rate limits, AI prompt-injection. |
| [csp.md](./csp.md) | The Content-Security-Policy, why it ships Report-Only, and the promotion-to-enforcing checklist. |
| [accepted-risks.md](./accepted-risks.md) | Medium findings accepted (not fixed) with rationale + review dates. |

Report a vulnerability per [SECURITY.md](../../SECURITY.md).

## Sign-off log

Each release records a security sign-off across the named surfaces. Open
Criticals/Highs block the tag.

### Run 001 — 2026-06-24 (`dev`)

Static review + dependency audit across: auth, BYOK key handling, admin
Basic-Auth, reviewer cookie, all `/api/*` controllers, `data/` file writers,
gh-mode ship runner, USDA importer, AI prompt construction.

- **Dependencies:** `npm audit` (prod + full tree) → **0 vulnerabilities**.
- **Crypto / secrets:** AES-256-GCM at rest for BYOK keys + PII; peppered
  passwords; keyed-HMAC equality lookups — **pass**.
- **Admin Basic-Auth:** constant-time, fail-closed — **pass**.
- **Reviewer session:** `httpOnly` + `sameSite=lax` signed cookie — **pass**.
- **Ship runner:** `spawnSync('git', [args])`, no shell — **pass**.
- **AI prompts:** admin-only, closed catalogue, deterministic re-validation —
  **pass**.
- **Input validation:** Zod on every controller, no raw `req.body` — **pass**.
- **Transport headers:** added this run (enforced static set + Report-Only CSP) —
  **pass with follow-up** (promote CSP, see [csp.md](./csp.md)).
- **Open Critical/High:** none.

Two Mediums accepted — see [accepted-risks.md](./accepted-risks.md). No runtime
DAST/fuzzing this run (tracked as a future gate item).
