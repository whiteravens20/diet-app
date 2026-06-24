# Accepted security risks

The F100 release gate requires every Medium-severity finding that is **accepted
rather than fixed** to be recorded here with a rationale, a compensating control
and a review date. Criticals and Highs are never accepted — they block the tag.

See the full findings in
[`docs/release/F100-prerelease-audit.md`](../release/F100-prerelease-audit.md).

| ID | Finding | Severity | Why accepted | Compensating control | Review by | Owner |
|---|---|---|---|---|---|---|
| AR-2 | Content-Security-Policy ships in **Report-Only** mode, not enforcing. | 🟡 Medium | Live browser QA (2026-06-24) confirmed two blockers to enforcement: ~11 per-render inline Next streaming scripts (need a per-request nonce, not hashes) and one bundle chunk that uses `eval` (needs `'unsafe-eval'` or removing the source). Promoting requires a nonce middleware + that dependency fix + cross-surface QA — out of scope for a low-risk pass. | All other security headers (HSTS, nosniff, frame-ancestors `'none'`, Referrer-Policy, Permissions-Policy) are **enforced**; CSP Report-Only still surfaces violations; the verified promotion checklist is in [`csp.md`](./csp.md). | 2026-09-30 | maintainer |

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
