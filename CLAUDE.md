# CLAUDE.md

Project instructions for Claude Code in this repository.

See **[AGENTS.md](AGENTS.md)** for the working reference and
**[docs/llm/onboarding.md](docs/llm/onboarding.md)** for full onboarding.

## Must-follow rules

- **Nutrition is never invented.** Calorie/macro values are always computed by the
  deterministic engine (`apps/api/src/engine`) from the curated ingredient database.
  AI may draft recipe structure only; its output is validated and recomputed.
- **The API contract is `packages/shared`.** Add or change a Zod schema there before
  using it in `apps/api` or `apps/web`.
- **Determinism stays pure.** Calorie/macro/quantity logic goes in `apps/api/src/engine`
  as pure, unit-tested functions. Seed any randomness.
- **Verify before claiming done:** `npm run lint && npm run typecheck && npm test`.
  For UI changes, exercise the feature in a browser.
- **Commits:** Conventional Commits, signed, **no `Co-Authored-By` trailers**. Branch off
  `dev`, PR into `dev`.
- Confirm before risky actions (force push, branch/settings changes, deletes).
