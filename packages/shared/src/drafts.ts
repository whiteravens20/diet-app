/**
 * Curation queue contracts.
 *
 * Drafts are the AI-proposed / human-approved staging area for recipes and
 * ingredient-name overrides. See [docs/adr/0008-curation-queue.md]. The
 * invariant is **AI proposes → human approves in-app → PR ships to data/*.json
 * → re-seed lands in DB** — these schemas describe every payload that crosses
 * the wire along that path.
 *
 * Phase C: ingredient-name drafts + the runner-status shape they share with
 * the recipe pipeline.
 * Phase D: recipe drafts + the spec / preview / patch shapes.
 */
import { z } from 'zod';
import { Locale } from './settings.js';
import { Complexity, Unit, MealType, DietType } from './enums.js';
export { Complexity };

export const Difficulty = z.enum(['easy', 'medium', 'hard']);
export type Difficulty = z.infer<typeof Difficulty>;

export const DraftStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SHIPPED']);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const DraftSource = z.enum(['AI', 'EXTERNAL', 'MANUAL', 'AI_USER']);
export type DraftSource = z.infer<typeof DraftSource>;

export const DraftKind = z.enum(['recipe', 'ingredient-name']);
export type DraftKind = z.infer<typeof DraftKind>;

export const ReviewAction = z.enum(['APPROVE', 'REJECT']);
export type ReviewAction = z.infer<typeof ReviewAction>;

/** Per-locale review row (audit). Mirrors the *LocaleReview Prisma rows. */
export const LocaleReview = z.object({
  locale: Locale,
  action: ReviewAction,
  reviewedByLabel: z.string(),
  reason: z.string().nullable(),
  reviewedAt: z.string(),
});
export type LocaleReview = z.infer<typeof LocaleReview>;

/**
 * Locale-keyed map of strings — e.g. `{ en: "Beef tenderloin",
 *  pl: "Polędwica wołowa" }`. Stored as a JSON column on the draft; the API
 * layer enforces "every key is a valid Locale, every value is non-empty".
 *
 * Uses `partialRecord` so a draft generated against a subset of locales
 * (e.g. `targetLocales: ['pl']`) round-trips through PATCH without Zod v4's
 * exhaustive-keys rule rejecting it. Coverage against `draft.locales` is the
 * runner/seeder's job, not the wire schema's.
 */
export const LocaleStringMap = z.partialRecord(Locale, z.string().min(1));
export type LocaleStringMap = z.infer<typeof LocaleStringMap>;

// ── Ingredient-name drafts (Phase C) ──────────────────────────────────────────

/** Body the AI returns for one ingredient. Stored as `suggestions` JSON. */
export const IngredientNameSuggestion = z.object({
  name: LocaleStringMap,
  storageHint: LocaleStringMap.optional(),
});
export type IngredientNameSuggestion = z.infer<typeof IngredientNameSuggestion>;

export const IngredientNameDraft = z.object({
  id: z.string().uuid(),
  ingredientId: z.string().uuid().nullable(),
  ingredientSlug: z.string(),
  rawDescription: z.string(),
  suggestions: IngredientNameSuggestion,
  locales: z.array(Locale),
  status: DraftStatus,
  source: DraftSource,
  batchId: z.string(),
  modelUsed: z.string().nullable(),
  generatorPrompt: z.string().nullable(),
  shippedPRUrl: z.string().nullable(),
  shippedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  localeReviews: z.array(LocaleReview),
});
export type IngredientNameDraft = z.infer<typeof IngredientNameDraft>;

/**
 * Spec passed to `POST /api/admin/drafts/ingredient-names/generate`. `scope`
 * picks the parent set; `targetLocales` controls which locale keys the AI
 * must return — defaults to every non-canonical locale (`pl` today) so that
 * extending the `Locale` enum auto-extends draft coverage.
 */
export const IngredientNameGenerateSpec = z.object({
  scope: z.enum(['all-usda-missing', 'specific-slugs']),
  slugs: z.array(z.string()).optional(),
  targetLocales: z.array(Locale).min(1).optional(),
});
export type IngredientNameGenerateSpec = z.infer<typeof IngredientNameGenerateSpec>;

// ── Runner status (shared by ingredient-name + recipe pipelines) ──────────────

export const DraftRunnerStatus = z.enum(['idle', 'running', 'done', 'error']);
export type DraftRunnerStatus = z.infer<typeof DraftRunnerStatus>;

export const DraftRunnerState = z.object({
  status: DraftRunnerStatus,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Total rows attempted so far in the current run. */
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** Rows skipped after the validator rejected them on every retry. */
  failed: z.number().int().nonnegative(),
  /** Rows persisted as PENDING drafts. */
  written: z.number().int().nonnegative(),
  /** Provider chip the UI shows beside the progress bar. */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** Last batch id assigned by this run — present so the UI can link
   *  directly to the new drafts. */
  batchId: z.string().nullable(),
  error: z.string().nullable(),
  /** Whether the admin-default provider env vars are set. The UI disables
   *  the Generate button when false. */
  configured: z.boolean(),
});
export type DraftRunnerState = z.infer<typeof DraftRunnerState>;

// ── Recipe drafts (Phase D) ───────────────────────────────────────────────────

/** Locale-keyed string-array map — used for `steps` where every entry is an
 *  ordered list, not a single string. Same key set as LocaleStringMap, and like
 *  it uses `partialRecord`: drafts are generated for a locale subset
 *  (`targetLocales`), so Zod v4's exhaustive `z.record` over the enum key would
 *  wrongly reject a `{ pl: … }` map for the missing `en` key. */
export const LocaleStringsMap = z.partialRecord(Locale, z.array(z.string().min(1)).min(1));
export type LocaleStringsMap = z.infer<typeof LocaleStringsMap>;

/** One ingredient line as the AI returns it inside a recipe draft. Slug must
 *  resolve to an `Ingredient.slug` in the live DB; the validator rejects rows
 *  that don't. */
export const RecipeDraftIngredientLine = z.object({
  slug: z.string().min(1),
  quantity: z.number().positive(),
  unit: Unit,
  note: z.string().max(120).nullable().optional(),
});
export type RecipeDraftIngredientLine = z.infer<typeof RecipeDraftIngredientLine>;

/** Per-serving nutrition the engine recomputed from `ingredients`. */
export const RecipeDraftNutrition = z.object({
  caloriesPerServing: z.number().nonnegative(),
  proteinPerServing: z.number().nonnegative(),
  fatPerServing: z.number().nonnegative(),
  carbsPerServing: z.number().nonnegative(),
});
export type RecipeDraftNutrition = z.infer<typeof RecipeDraftNutrition>;

/** Body persisted as a `RecipeDraft` row. Locale-keyed JSON columns + the
 *  engine-computed numeric fields + the structural metadata. */
export const RecipeDraft = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  titles: LocaleStringMap,
  descriptions: LocaleStringMap,
  steps: LocaleStringsMap,
  locales: z.array(Locale),
  servings: z.number().int().min(1),
  mealTypes: z.array(MealType),
  dietTags: z.array(DietType),
  prepMinutes: z.number().int().min(0),
  cookMinutes: z.number().int().min(0),
  difficulty: Difficulty,
  complexity: Complexity,
  caloriesPerServing: z.number().nonnegative(),
  proteinPerServing: z.number().nonnegative(),
  fatPerServing: z.number().nonnegative(),
  carbsPerServing: z.number().nonnegative(),
  allergens: z.array(z.string()),
  ingredients: z.array(RecipeDraftIngredientLine).min(1),
  status: DraftStatus,
  source: DraftSource,
  batchId: z.string(),
  modelUsed: z.string().nullable(),
  generatorPrompt: z.string().nullable(),
  generationSpec: z.unknown().nullable(),
  provenanceUrl: z.string().nullable(),
  provenanceLicense: z.string().nullable(),
  shippedPRUrl: z.string().nullable(),
  shippedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  localeReviews: z.array(LocaleReview),
});
export type RecipeDraft = z.infer<typeof RecipeDraft>;

/** Optional complexity mix. Three weights that should sum to 1.0; the runner
 *  normalises if they don't and stratifies the batch accordingly. */
export const ComplexityMix = z.object({
  simple: z.number().min(0).max(1),
  medium: z.number().min(0).max(1),
  complex: z.number().min(0).max(1),
});
export type ComplexityMix = z.infer<typeof ComplexityMix>;

/** Spec passed to `POST /api/admin/drafts/recipes/generate`. Every knob is
 *  optional except `count`; the runner derives sensible defaults (every
 *  non-canonical locale + EN, balanced complexity mix). */
/**
 * Which slice of the ingredient catalogue the prompt sees. `curated` (default)
 * shows only the hand-authored rows in `data/ingredients.json` — they have
 * cookbook-style names (`chicken-breast`, `lemon`, `garlic`) the model can
 * recognise and stay inside. `all` adds every USDA-imported row, useful once
 * those rows have approved friendly names via the Phase C namer pipeline.
 * Defaults to `curated` for v1: USDA rows carry FDC-bureaucratic names
 * (`anchovies-canned-in-olive-oil-with-salt-drained`) that don't map to
 * everyday cooking vocabulary, so the model invents simpler slugs that don't
 * exist and the validator rejects the batch.
 */
export const CatalogueScope = z.enum(['curated', 'all']);
export type CatalogueScope = z.infer<typeof CatalogueScope>;

export const RecipeGenerateSpec = z.object({
  count: z.number().int().min(1).max(25),
  targetLocales: z.array(Locale).min(1).optional(),
  catalogueScope: CatalogueScope.optional(),
  dietTags: z.array(DietType).optional(),
  mealTypes: z.array(MealType).optional(),
  cuisine: z.string().min(1).max(80).optional(),
  kcalRange: z
    .object({
      min: z.number().int().nonnegative(),
      max: z.number().int().positive(),
    })
    .refine((r) => r.max >= r.min, { message: 'kcalRange.max must be >= min' })
    .optional(),
  avoidSlugs: z.array(z.string()).optional(),
  preferSlugs: z.array(z.string()).optional(),
  complexityMix: ComplexityMix.optional(),
});
export type RecipeGenerateSpec = z.infer<typeof RecipeGenerateSpec>;

/** PATCH body for a recipe draft. All fields optional; the controller merges
 *  into the existing row and re-runs the validator + engine recompute. The
 *  `?dryRun=true` query flag returns the recomputed shape without persisting,
 *  which the inline editor uses for live nutrition feedback. */
export const RecipeDraftPatch = z.object({
  titles: LocaleStringMap.optional(),
  descriptions: LocaleStringMap.optional(),
  steps: LocaleStringsMap.optional(),
  servings: z.number().int().min(1).optional(),
  mealTypes: z.array(MealType).optional(),
  dietTags: z.array(DietType).optional(),
  prepMinutes: z.number().int().min(0).optional(),
  cookMinutes: z.number().int().min(0).optional(),
  difficulty: Difficulty.optional(),
  ingredients: z.array(RecipeDraftIngredientLine).min(1).optional(),
});
export type RecipeDraftPatch = z.infer<typeof RecipeDraftPatch>;

// ── Reviewer interface (Phase H) ──────────────────────────────────────────────

/**
 * Public `InstanceSettings` shape — never carries the bcrypt hash, just
 * whether one is set.
 */
export const InstanceSettingsDto = z.object({
  reviewerEnabled: z.boolean(),
  reviewerPasswordSet: z.boolean(),
  updatedAt: z.string(),
});
export type InstanceSettingsDto = z.infer<typeof InstanceSettingsDto>;

export const InstanceSettingsPatchBody = z
  .object({
    reviewerEnabled: z.boolean().optional(),
    // Empty string clears the existing hash; `undefined` means "no change".
    reviewerPassword: z.string().max(200).optional(),
  })
  .strict();
export type InstanceSettingsPatchBody = z.infer<typeof InstanceSettingsPatchBody>;

/**
 * Login body for the reviewer interface. The cookie carries the reviewer's
 * `label` only — locale is supplied per-request as a query parameter, so a
 * single reviewer can hop between locale tabs without re-authenticating.
 * EN is rejected at the API layer wherever locale is supplied because EN is
 * the canonical authoring language: the reviewer's job is to validate a
 * *target* locale against the EN source.
 */
export const ReviewerLoginBody = z.object({
  password: z.string().min(1).max(200),
  label: z.string().min(1).max(80),
});
export type ReviewerLoginBody = z.infer<typeof ReviewerLoginBody>;

/** What `GET /api/review/session` returns — minimum needed by the client. */
export const ReviewerSessionDto = z.object({
  label: z.string(),
  issuedAt: z.string(),
});
export type ReviewerSessionDto = z.infer<typeof ReviewerSessionDto>;

/**
 * Per-locale slice of a recipe draft handed to a reviewer. Contains only the
 * reviewer's `locale` slice as editable + the EN slice as a read-only source
 * reference. Locale-independent metadata (engine nutrition, allergens, slug
 * resolution, batch / model provenance) is always included.
 */
export const RecipeReviewSlice = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  locale: Locale,
  title: z.string(),
  titleSource: z.string(), // canonical EN
  description: z.string(),
  descriptionSource: z.string(),
  steps: z.array(z.string()),
  stepsSource: z.array(z.string()),
  // Locale-independent.
  servings: z.number().int().positive(),
  mealTypes: z.array(MealType),
  dietTags: z.array(DietType),
  prepMinutes: z.number().int().nonnegative(),
  cookMinutes: z.number().int().nonnegative(),
  difficulty: Difficulty,
  complexity: Complexity,
  caloriesPerServing: z.number().nonnegative(),
  proteinPerServing: z.number().nonnegative(),
  fatPerServing: z.number().nonnegative(),
  carbsPerServing: z.number().nonnegative(),
  allergens: z.array(z.string()),
  ingredients: z.array(RecipeDraftIngredientLine),
  batchId: z.string(),
  modelUsed: z.string().nullable(),
  status: DraftStatus,
  alreadyReviewed: z.boolean(),
  alreadyReviewedAction: ReviewAction.nullable(),
});
export type RecipeReviewSlice = z.infer<typeof RecipeReviewSlice>;

/** Per-locale slice of an ingredient-name draft. */
export const IngredientNameReviewSlice = z.object({
  id: z.string().uuid(),
  ingredientSlug: z.string(),
  rawDescription: z.string(),
  locale: Locale,
  name: z.string(),
  nameSource: z.string(),
  storageHint: z.string().nullable(),
  storageHintSource: z.string().nullable(),
  batchId: z.string(),
  modelUsed: z.string().nullable(),
  status: DraftStatus,
  alreadyReviewed: z.boolean(),
  alreadyReviewedAction: ReviewAction.nullable(),
});
export type IngredientNameReviewSlice = z.infer<typeof IngredientNameReviewSlice>;

/**
 * Reviewer PATCH bodies — scoped to the reviewer's `cookie.locale`. The
 * controller writes only the cookie locale into the JSON columns; cross-locale
 * edits are structurally impossible.
 */
export const RecipeReviewPatchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(2000).optional(),
    steps: z.array(z.string().min(1).max(2000)).min(1).optional(),
  })
  .strict();
export type RecipeReviewPatchBody = z.infer<typeof RecipeReviewPatchBody>;

export const IngredientNameReviewPatchBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    storageHint: z.string().max(500).optional(),
  })
  .strict();
export type IngredientNameReviewPatchBody = z.infer<typeof IngredientNameReviewPatchBody>;

export const ReviewerReasonBody = z
  .object({ reason: z.string().max(500).optional() })
  .strict();
export type ReviewerReasonBody = z.infer<typeof ReviewerReasonBody>;
