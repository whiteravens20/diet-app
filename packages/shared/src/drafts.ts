// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Curation queue contracts.
 *
 * Drafts are the AI-proposed / human-approved staging area for recipes and
 * ingredient-name overrides. The
 * invariant is **AI proposes → human approves in-app → PR ships to data/*.json
 * → re-seed lands in DB** — these schemas describe every payload that crosses
 * the wire along that path.
 *
 * Covers ingredient-name drafts (and the runner-status shape they share with
 * the recipe pipeline) and recipe drafts (spec / preview / patch shapes).
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

/** Who reviews: the administrator, or a reviewer signed in with the reviewers' password. */
export const ReviewerRole = z.enum(['ADMIN', 'REVIEWER']);
export type ReviewerRole = z.infer<typeof ReviewerRole>;

/** A language a draft is written in and reviewed for besides the canonical one. */
export const TargetLocale = Locale.exclude(['en']);
export type TargetLocale = z.infer<typeof TargetLocale>;

/** The review a language of a draft has now. */
export const LocaleReview = z.object({
  locale: Locale,
  action: ReviewAction,
  /** Null on a review written before the role was recorded. */
  byRole: ReviewerRole.nullable(),
  /** The name the reviewer signed in with, or the one the administrator gave. */
  reviewedByLabel: z.string(),
  reason: z.string().nullable(),
  reviewedAt: z.string(),
});
export type LocaleReview = z.infer<typeof LocaleReview>;

/**
 * A review that no longer counts: a later review of the same language, or an
 * edit of the draft, took its place at `supersededAt`. Kept as the record of
 * what was decided.
 */
export const PastReview = LocaleReview.extend({ supersededAt: z.string() });
export type PastReview = z.infer<typeof PastReview>;

const page = z.coerce.number().int().min(1).max(100_000).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);

/** The administrator's list of ingredient-name drafts: its filters and its page. */
export const IngredientNameDraftListQuery = z.object({
  status: DraftStatus.optional(),
  batchId: z.string().min(1).max(120).optional(),
  page,
  pageSize,
});
export type IngredientNameDraftListQuery = z.infer<typeof IngredientNameDraftListQuery>;

/** The administrator's list of recipe drafts. `source` narrows it to where the drafts came from: `AI_USER` are the ones users sent. */
export const RecipeDraftListQuery = IngredientNameDraftListQuery.extend({ complexity: Complexity.optional(), source: DraftSource.optional() });
export type RecipeDraftListQuery = z.infer<typeof RecipeDraftListQuery>;

/** What waits for a reviewer in one language; with `includeReviewed`, also what that language already approved. */
export const ReviewQueueQuery = z.object({
  locale: TargetLocale,
  includeReviewed: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  page,
  pageSize,
});
export type ReviewQueueQuery = z.infer<typeof ReviewQueueQuery>;

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

// ── Ingredient-name drafts ────────────────────────────────────────────────────

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
  pastReviews: z.array(PastReview),
});
export type IngredientNameDraft = z.infer<typeof IngredientNameDraft>;

/**
 * Spec passed to `POST /api/admin/drafts/ingredient-names/generate`. `scope`
 * picks the parent set; `targetLocales` controls which locale keys the AI
 * must return — defaults to every non-canonical locale (`pl` today) so that
 * extending the `Locale` enum auto-extends draft coverage. English is not
 * among them: the source's own name is the English one, and a draft made for
 * English could be approved by nobody.
 */
export const IngredientNameGenerateSpec = z.object({
  scope: z.enum(['all-usda-missing', 'specific-slugs']),
  slugs: z.array(z.string()).optional(),
  targetLocales: z.array(TargetLocale).min(1).optional(),
});
export type IngredientNameGenerateSpec = z.infer<typeof IngredientNameGenerateSpec>;

// ── Runner status (shared by ingredient-name + recipe pipelines) ──────────────

export const DraftRunnerStatus = z.enum(['idle', 'running', 'done', 'error']);
export type DraftRunnerStatus = z.infer<typeof DraftRunnerStatus>;

/**
 * Why a run had nothing to do, or ended before its count, when that is no
 * failure:
 *
 *  - `nothing-imported`: the catalogue has no imported ingredient to name;
 *  - `not-imported`: none of the ingredients named is an imported one, and
 *    only those get their names from a run;
 *  - `all-have-drafts`: every imported ingredient already has a draft;
 *  - `coverage-reached`: every diet has enough recipes for every meal.
 */
export const DraftRunNote = z.enum(['nothing-imported', 'not-imported', 'all-have-drafts', 'coverage-reached']);
export type DraftRunNote = z.infer<typeof DraftRunNote>;

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
  /** In the run's scope, and left out because there was nothing to do for them. */
  skipped: z.number().int().nonnegative(),
  note: DraftRunNote.nullable(),
  /** Whether the admin-default provider env vars are set. The UI disables
   *  the Generate button when false. */
  configured: z.boolean(),
});
export type DraftRunnerState = z.infer<typeof DraftRunnerState>;

// ── Recipe drafts ─────────────────────────────────────────────────────────────

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
  pastReviews: z.array(PastReview),
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
 * those rows have approved friendly names via the namer pipeline.
 * Defaults to `curated` for v1: USDA rows carry FDC-bureaucratic names
 * (`anchovies-canned-in-olive-oil-with-salt-drained`) that don't map to
 * everyday cooking vocabulary, so the model invents simpler slugs that don't
 * exist and the validator rejects the batch.
 */
export const CatalogueScope = z.enum(['curated', 'all']);
export type CatalogueScope = z.infer<typeof CatalogueScope>;

export const RecipeGenerateSpec = z.object({
  /** How many recipes to write; with `fillCoverage`, how many at most. */
  count: z.number().int().min(1).max(25),
  targetLocales: z.array(Locale).min(1).optional(),
  catalogueScope: CatalogueScope.optional(),
  /**
   * Write for the diet and meal that have the fewest recipes, call after
   * call, and stop when every diet has enough for every meal. The run then
   * chooses the diet and the meal itself: `dietTags` and `mealTypes` may not
   * be sent with it.
   */
  fillCoverage: z.boolean().optional(),
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
}).refine((spec) => !spec.fillCoverage || (spec.dietTags === undefined && spec.mealTypes === undefined), {
  message: 'fillCoverage chooses the diet and the meal: dietTags and mealTypes may not be sent with it',
  path: ['fillCoverage'],
});
export type RecipeGenerateSpec = z.infer<typeof RecipeGenerateSpec>;

/** PATCH body for a recipe draft. All fields optional; what is sent is merged
 *  into the draft, text language by language, and the whole is held to the
 *  rules of every recipe (`RECIPE_LIMITS`) before the engine works its figures
 *  out again. The `?dryRun=true` query flag returns the result without
 *  storing it, which the inline editor uses for live nutrition feedback.
 *
 *  A change sends the draft back to be reviewed, except a change of the slug
 *  alone: the slug names the recipe in the data and is no part of what a
 *  reviewer approved. */
export const RecipeDraftPatch = z.object({
  slug: z.string().optional(),
  titles: LocaleStringMap.optional(),
  descriptions: LocaleStringMap.optional(),
  steps: LocaleStringsMap.optional(),
  servings: z.number().int().min(1).optional(),
  mealTypes: z.array(MealType).optional(),
  prepMinutes: z.number().int().min(0).optional(),
  cookMinutes: z.number().int().min(0).optional(),
  difficulty: Difficulty.optional(),
  ingredients: z.array(RecipeDraftIngredientLine).min(1).optional(),
});
export type RecipeDraftPatch = z.infer<typeof RecipeDraftPatch>;

// ── Reviewer interface ────────────────────────────────────────────────────────

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
    // Twelve characters at least, as for an account. An empty string takes
    // the password away, which closes the reviewers' door; leaving the field
    // out leaves the password as it is.
    reviewerPassword: z.union([z.literal(''), z.string().min(12).max(200)]).optional(),
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
 * Reviewer PATCH bodies — scoped to the language of the request. Only that
 * language's text is written; an edit across languages is structurally
 * impossible. How long a text may be, and that it is plain text, is decided by
 * the rules of every recipe (`RECIPE_LIMITS`, `INGREDIENT_NAME_LIMITS`), which
 * answer with the field and the rule; the bounds here only keep nonsense out.
 */
export const RecipeReviewPatchBody = z
  .object({
    title: z.string().min(1).max(2000).optional(),
    description: z.string().min(1).max(10_000).optional(),
    steps: z.array(z.string().max(5000)).min(1).max(100).optional(),
  })
  .strict();
export type RecipeReviewPatchBody = z.infer<typeof RecipeReviewPatchBody>;

export const IngredientNameReviewPatchBody = z
  .object({
    name: z.string().min(1).max(2000).optional(),
    storageHint: z.string().max(5000).optional(),
  })
  .strict();
export type IngredientNameReviewPatchBody = z.infer<typeof IngredientNameReviewPatchBody>;

export const ReviewerReasonBody = z
  .object({ reason: z.string().max(500).optional() })
  .strict();
export type ReviewerReasonBody = z.infer<typeof ReviewerReasonBody>;
