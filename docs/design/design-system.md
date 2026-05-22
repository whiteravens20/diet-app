# Design System

A premium, calm, health-forward SaaS aesthetic. Tokens are defined once in
[`apps/web/src/app/globals.css`](../../apps/web/src/app/globals.css) and consumed through
Tailwind v4.

## Foundations

- **Colour** — OKLCH ramps for perceptual consistency. An emerald-forward brand
  (`--primary`) with a teal accent. Full light + dark palettes; dark mode via a `.dark`
  class managed by `next-themes`. Semantic tokens only (`--background`, `--card`,
  `--muted`, `--border`, `--primary`, `--destructive`, …) — components never hard-code hex.
- **Typography** — Geist (variable, `next/font`). Tight tracking on headings; relaxed,
  muted body copy. Scale: 12 / 14 / 16 / 20 / 24 / 32 / 48.
- **Spacing & radius** — 4px base grid. `--radius` 0.85rem with `sm`/`md`/`lg` steps —
  generous, soft corners.
- **Elevation** — subtle: a hairline `border` plus a soft `shadow-sm`. No heavy shadows.

## Components

Located in `apps/web/src/components/ui` and `apps/web/src/components`:

| Component | Role |
|---|---|
| `Button` (+ `buttonVariants`) | `primary` / `outline` / `ghost` / `destructive`; 3 sizes; press-scale feedback. |
| `Card` family | Elevated surface for panels, stats, list items. |
| `Input`, `Field` | Form primitives with a labelled wrapper. |
| `Skeleton` | Shimmer placeholder for loading states. |
| `StatCard` | Animated dashboard metric tile. |
| `Sidebar`, `ThemeToggle` | App shell navigation + light/dark switch. |

New components follow the same rules: semantic tokens, `cva` for variants, the `cn()`
class merger, and a focus-visible ring on every interactive element.

## Motion

Framer Motion, used sparingly and purposefully:

- **Entrance** — content fades up ~12px over ~350ms `easeOut`; lists stagger ~60ms.
- **Microinteractions** — buttons scale to 0.98 on press; nav items cross-fade.
- **Loading** — skeletons with a 1.6s shimmer sweep; never a blank screen.
- **Respect `prefers-reduced-motion`** — animations collapse to instant transitions.

Keep durations short (150–400ms). Motion communicates state change; it never blocks
interaction.

## Example screens & flows

- **Onboarding / profile wizard** — collect age, sex, height, weight, activity, diet,
  weekly target; immediately surface the calculated calorie target with a "manual
  override" affordance.
- **Dashboard** — four `StatCard`s (target, maintenance, deficit, meals/day) above a
  macro-split donut (Recharts).
- **Meal-plan builder** — diet type, meal count, calendar range → generate → a per-day
  board of meal cards with per-day calorie delta; swap and regenerate inline.
- **Recipe detail** — ingredients, steps, nutrition, allergen warnings; substitution
  modal shows the calorie/macro delta before confirming.
- **Shopping list** — aisle-grouped, checkable items with an "already have" control.

## Accessibility

Semantic HTML, labelled controls, keyboard-navigable everything, visible focus rings,
AA contrast in both themes, and reduced-motion support.
