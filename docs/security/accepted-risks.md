# Accepted security risks

The F100 release gate requires every Medium-severity finding that is **accepted
rather than fixed** to be recorded here with a rationale, a compensating control
and a review date. Criticals and Highs are never accepted — they block the tag.

See the full findings in
[`docs/release/F100-prerelease-audit.md`](../release/F100-prerelease-audit.md).

| ID | Finding | Severity | Why accepted | Compensating control | Review by | Owner |
|---|---|---|---|---|---|---|
| AR-2 | Content-Security-Policy ships in **Report-Only** mode, not enforcing. | 🟡 Medium | Live browser QA (2026-06-24) confirmed two blockers to enforcement: ~11 per-render inline Next streaming scripts (need a per-request nonce, not hashes) and one bundle chunk that uses `eval` (needs `'unsafe-eval'` or removing the source). Promoting requires a nonce middleware + that dependency fix + cross-surface QA — out of scope for a low-risk pass. | All other security headers (HSTS, nosniff, frame-ancestors `'none'`, Referrer-Policy, Permissions-Policy) are **enforced**; CSP Report-Only still surfaces violations; the verified promotion checklist is in [`csp.md`](./csp.md). | 2026-09-30 | maintainer |
| AR-3 | The admin **"pull overrides from a repo"** flow (`POST /api/admin/drafts/ship/current-overrides/pull`) accepts a full `http(s)://` URL and fetches it server-side without an internal-host check, so an admin can point it at an internal address. | 🟡 Medium | The route is behind `BasicAuthGuard` (admin-only), is opt-in per request, and parses the response strictly as an `ingredient-overrides.json` (Zod-validated) — it returns no raw body to the caller. For a single-operator self-host the admin already controls the host. | Admin Basic-Auth gate; 15 s fetch timeout; the response is never echoed back, only applied as `MANUAL` translations for slugs this instance already has. | 2026-09-30 | maintainer |
| AR-4 | When an operator sets `OLLAMA_USER_POLICY=public`, a user-supplied Ollama host that is a **public DNS name resolving to a private IP** (DNS-rebinding) is not caught by the host-literal guard. | 🟡 Medium | `public` is an explicit, non-default opt-in (default is `allowlist`, which closes this). Full prevention needs resolve-and-pin at dial time. A poisoned response is still re-validated + recomputed by the deterministic engine, and the request carries only that user's own prompt. | Default `allowlist` mode is unaffected (host/port pinned); IP-literal private ranges and single-label/`.local`/`.internal` hosts are blocked even in `public`; the Ollama adapter has a 60 s timeout; rate limiting bounds abuse. See [`apps/api/src/ai/ollama-url.ts`](../../apps/api/src/ai/ollama-url.ts). | 2026-09-30 | maintainer |

> When a row is fixed, delete it (or move it to a "Resolved" note with the
> commit that closed it). An empty table is the goal at tag time.

## Resolved

- **AR-1 — direct `process.env` reads outside `config/`** (was 🟡 Medium).
  Fixed: the Prisma adapter, BYOK provider-key fallbacks and the USDA importer now
  resolve config through `ConfigService`; `FDC_*` and `SEED_DATA_DIR` were added to
  `config/env.ts`. The remaining reads (the `git`/`gh` subprocess `...process.env`
  spread and the non-DI `data-hash.ts` path helper) are legitimate plumbing,
  annotated inline, and an ESLint `no-restricted-syntax` rule now bans new
  `process.env` reads in `apps/api/src`.
