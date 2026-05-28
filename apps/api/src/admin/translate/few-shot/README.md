# Few-shot anchors per target locale

Each `<code>.json` file in this directory is a small array of `{source, translation}`
pairs that the [prompt builder](../prompt.ts) injects into the LLM call when
auto-translating into that locale. They steer the model on terminology the base
training data underweights — culinary specifics, regional names, common false
friends.

## When to write or extend a file

A locale's first few-shot pass starts blank or with a handful of generic
anchors. The right time to invest in expanding it is **after** the first
real translation run, when actual error patterns are visible.

The iteration recipe is the same for every locale (PL today, DE / FR / … later):

1. **Run** the admin auto-translate for the target locale on a representative
   batch (`scope=missing`, single locale).
2. **Scan** the resulting `IngredientTranslation` / `RecipeTranslation` rows.
   A quick SQL dump works:
   ```bash
   docker exec <postgres> psql -U diet -d diet_app -t -A -F'|' -c \
     "SELECT i.name, it.name FROM \"IngredientTranslation\" it
      JOIN \"Ingredient\" i ON i.id=it.\"ingredientId\"
      WHERE it.locale='<code>' AND it.source='AI' ORDER BY i.name;"
   ```
3. **Tag** the errors. Three categories worth anchoring:
   - **Wrong species / object** ("pawpaw" mis-translated as "papaya", "millet"
     mis-translated as "barley"). High-impact, low-anchor-count.
   - **Wrong anatomy / cut** (beef cuts especially — "flank" vs "tenderloin"
     vs "ribeye" all get confused).
   - **Phrase-pattern flips** ("96% fat free" → "96% fat", "added vitamin C"
     dropped to "vitamin C").
4. **Write** one anchor per distinct error pattern, with a *correct* target
   translation. Aim for 20–30 anchors per locale — diminishing returns past that.
5. **Wipe AI rows** via the admin panel and **re-run**. Compare a fresh sample
   against the previous run to confirm the lift.

The anchors are model-agnostic — switching `AI_DEFAULT_MODEL` does not invalidate
them. The errors they fix are vocabulary gaps, not model failures.

## What does NOT belong here

- **General-purpose phrases.** The prompt template already establishes tone,
  imperative form for steps, JSON discipline, etc. Anchors are for terminology
  the model gets *wrong*, not for things it gets right.
- **Brand / proper nouns.** The prompt explicitly tells the model to pass these
  through unchanged. Don't waste anchor budget on them.
- **Per-row corrections.** If one specific row needs a hand-edit, the right tool
  is the (planned) inline-edit UI marking the row as `MANUAL`, not a one-off
  few-shot pair.

## Cross-locale transfer is zero

A Polish anchor like `Pawpaw → Azymina` does **not** help German translation —
German has different vocabulary, different false friends. Each locale earns its
anchor file through its own iteration loop. The infrastructure is locale-generic;
the content is not.
