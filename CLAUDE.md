# CLAUDE.md

Project instructions for Claude Code in this repository.

See **[AGENTS.md](AGENTS.md)** for the working reference and
**[docs/llm/onboarding.md](docs/llm/onboarding.md)** for full onboarding.

## Must-follow rules

- **Nutrition is never invented.** Calorie/macro values are always computed by the
  deterministic engine (`apps/api/src/engine`) from the curated ingredient database.
  AI may draft recipe structure only; its output is validated and recomputed.
- **All user-facing text is i18n.** No English literals in `.tsx`/`.ts` files for
  buttons, labels, toasts, exception messages, or rendered enum labels. New strings
  land in both `apps/web/messages/en.json` AND `apps/web/messages/pl.json` in the
  same PR. New thrown exceptions get a stable `error:` code and a row in
  `messages.errors` — the catalogue-completeness Vitest
  (`apps/api/src/common/error-catalogue.test.ts`) enforces this. New ingredients
  / recipes in `data/*.json` ship with `en` and `pl` keys for every text field.
  Polish translations should be reviewed by a Polish-speaking maintainer before
  merge. **Adding a new locale** is a 3-step recipe documented in
  [docs/adr/0007-curated-vs-ai-translations.md](docs/adr/0007-curated-vs-ai-translations.md):
  extend `Locale` in `packages/shared/src/settings.ts`, drop in
  `apps/web/messages/<code>.json`, hand-translate `data/*.json` keys.
- **The API contract is `packages/shared`.** Add or change a Zod schema there before
  using it in `apps/api` or `apps/web`.
- **Determinism stays pure.** Calorie/macro/quantity logic goes in `apps/api/src/engine`
  as pure, unit-tested functions. Seed any randomness.
- **Verify before claiming done:** `npm run lint && npm run typecheck && npm test`.
  For UI changes, exercise the feature in a browser.
- **Commits:** Conventional Commits, signed, **no `Co-Authored-By` trailers**. Branch off
  `dev`, PR into `dev`.
- Confirm before risky actions (force push, branch/settings changes, deletes).
