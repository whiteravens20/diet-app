# ADR 0004 — ESLint pinned to 9.x

**Status:** accepted · 2026-05

## Context

The versioning policy targets newest-stable. ESLint 10 is the newest major. However
`eslint-config-next@16` and its plugin chain (`eslint-plugin-react` et al.) target the
ESLint 9 API; under ESLint 10 the web lint crashes (`scopeManager.addGlobals is not a
function`). The `min-release-age` npm setting was also dropped — it broke resolution of
the newest releases with the current npm (see `.npmrc`).

## Decision

Pin **ESLint to `^9.39.4`** across every workspace (root, `apps/api`, `apps/web`,
`packages/shared`). All other dependencies remain newest-stable.

## Rationale

The versioning policy explicitly allows falling back one major when a newest major has a
known ecosystem-breaking gap. The Next.js ESLint plugin chain not yet supporting ESLint
10 is exactly that gap. ESLint 9 is current, supported and compatible with
`typescript-eslint@8` and `eslint-config-next@16`.

## Consequences

- Revisit when `eslint-config-next` supports ESLint 10.
- `apps/web` uses the native flat config exported by `eslint-config-next`; `apps/api` and
  `packages/shared` re-export the root `typescript-eslint` flat config.
