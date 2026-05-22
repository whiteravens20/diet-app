# ADR 0005 — Curated database is the source of truth

**Status:** accepted · 2026-05

## Context

The product must produce trustworthy, reproducible nutrition numbers. Generative AI
readily fabricates plausible-but-wrong calorie and macro values.

## Decision

The curated `Ingredient` / `NutritionFact` tables are the **single source of truth** for
nutrition. AI may draft recipe *structure* and suggestions, but:

- Every recipe's nutrition is **computed** from the ingredient table by the deterministic
  engine — at seed time, after AI generation, and in plan totals.
- AI output passes `AiValidationService`: unknown ingredients are rejected or remapped to
  approved ones; all nutrition is recomputed and AI's numbers discarded.
- Calorie/macro/quantity math is pure, seeded-deterministic and unit-tested.

## Consequences

- Recipes never store hand- or AI-authored nutrition; it is always derived.
- An AI-drafted recipe using an out-of-database ingredient is rejected, not guessed.
- The curated database's breadth is a real constraint — addressed by ADR 0006.
