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
import * as z from './zod.js';
import { Locale } from './settings.js';
import { Complexity, Cuisine, Difficulty, Unit, MealType, DietType } from './enums.js';
export { Complexity };

export const DraftStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SHIPPED']);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const DraftSource = z.enum(['AI', 'EXTERNAL', 'AI_USER']);
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

/** The language of a draft a reviewer's request is about: `?locale=`. */
export const TargetLocaleQuery = z.object({ locale: TargetLocale });
export type TargetLocaleQuery = z.infer<typeof TargetLocaleQuery>;

/** The language of a draft the administrator's request is about: any one, English too. */
export const DraftLocaleQuery = z.object({ locale: Locale });
export type DraftLocaleQuery = z.infer<typeof DraftLocaleQuery>;

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
export const LocaleStringMap = z.partialRecord(Locale, z.string().min(1).max(10_000));
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
export const IngredientNameGenerateSpec = z
  .object({
    scope: z.enum(['all-usda-missing', 'specific-slugs']),
    slugs: z.array(z.string().min(1).max(200)).max(1000).optional(),
    targetLocales: z.array(TargetLocale).min(1).max(TargetLocale.options.length).optional(),
  })
  .refine((spec) => spec.scope !== 'specific-slugs' || (spec.slugs?.length ?? 0) > 0, {
    path: ['slugs'],
    message: 'Name the ingredients to write for.',
  });
export type IngredientNameGenerateSpec = z.infer<typeof IngredientNameGenerateSpec>;

/** The most one run that fills a language takes on. */
export const MOST_TRANSLATIONS_PER_RUN = 200;

/**
 * What `POST /api/admin/drafts/translations/generate` is asked for: the
 * language to fill for recipes, and the most the run takes on. English is
 * none of the languages: everything is written from it.
 */
export const TranslationGenerateSpec = z
  .object({
    locale: TargetLocale,
    limit: z.number().int().min(1).max(MOST_TRANSLATIONS_PER_RUN).default(25),
  })
  .strict();
export type TranslationGenerateSpec = z.infer<typeof TranslationGenerateSpec>;

/** The administrator's edit of the names a draft suggests. */
export const IngredientNameDraftPatchBody = z.object({ suggestions: IngredientNameSuggestion });
export type IngredientNameDraftPatchBody = z.infer<typeof IngredientNameDraftPatchBody>;

/** The administrator's review of one language of a draft: under which name, and why when it is a rejection. */
export const DraftReviewBody = z.object({
  reviewedByLabel: z.string().min(1).max(80),
  reason: z.string().max(500).optional(),
});
export type DraftReviewBody = z.infer<typeof DraftReviewBody>;

/** Up to a hundred drafts rejected with one reason. */
export const DraftBulkRejectBody = DraftReviewBody.extend({ ids: z.array(z.string().uuid()).min(1).max(100) });
export type DraftBulkRejectBody = z.infer<typeof DraftBulkRejectBody>;

/** Which queue a shipment is taken from. */
export const ShipKind = z.enum(['recipe', 'ingredient-name']);
export type ShipKind = z.infer<typeof ShipKind>;

/** How approved drafts leave the queue. */
export const ShipMode = z.enum(['local', 'upstream-pr', 'bundle']);
export type ShipMode = z.infer<typeof ShipMode>;

/** The most drafts one shipment can name. */
export const MAX_SHIPPED_AT_ONCE = 1000;

/** Ships approved drafts: all of a queue, or the batches named. */
export const ShipRequest = z.object({
  kind: ShipKind,
  mode: ShipMode,
  batchIds: z.array(z.string().min(1).max(200)).max(MAX_SHIPPED_AT_ONCE).optional(),
});
export type ShipRequest = z.infer<typeof ShipRequest>;

/** Says that the drafts of a bundle the administrator saved are shipped. */
export const MarkShippedRequest = z.object({
  kind: ShipKind,
  draftIds: z.array(z.string().uuid()).min(1).max(MAX_SHIPPED_AT_ONCE),
});
export type MarkShippedRequest = z.infer<typeof MarkShippedRequest>;

/** Where shipped data is pulled from: a repository (`owner/repo[@branch]`) or an address; the instance's own source when it is left out. */
export const PullOverridesRequest = z.object({ source: z.string().trim().min(1).max(500).optional() });
export type PullOverridesRequest = z.infer<typeof PullOverridesRequest>;

/** `?dryRun=true`: say what an edit would give, and store nothing. */
export const DryRunQuery = z.object({
  dryRun: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});
export type DryRunQuery = z.infer<typeof DryRunQuery>;

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
 *  - `coverage-reached`: every diet has enough recipes for every meal;
 *  - `nothing-to-translate`: nothing lacks the language that was asked for.
 */
export const DraftRunNote = z.enum(['nothing-imported', 'not-imported', 'all-have-drafts', 'coverage-reached', 'nothing-to-translate']);
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

/** Where a run that writes recipe drafts stands. */
export const RecipeRunState = DraftRunnerState.extend({
  /** The diet and the meal the run is writing for, when it chooses them itself. */
  target: z.object({ diet: DietType, meal: MealType }).nullable(),
  /** How many drafts of each complexity the run has written. */
  complexityCounts: z.record(Complexity, z.number().int().min(0)),
  /** The mix the run reached is more than a quarter off the mix it was asked for, in some band. */
  mixDrift: z.boolean(),
  /** Why the last answer of the model was refused, which key it was about, and how the answer began. */
  lastRejectReason: z.string().nullable(),
  lastRejectKey: z.string().nullable(),
  lastRejectHead: z.string().nullable(),
});
export type RecipeRunState = z.infer<typeof RecipeRunState>;

// ── Recipe drafts ─────────────────────────────────────────────────────────────

/** Locale-keyed string-array map — used for `steps` where every entry is an
 *  ordered list, not a single string. Same key set as LocaleStringMap, and like
 *  it uses `partialRecord`: drafts are generated for a locale subset
 *  (`targetLocales`), so Zod v4's exhaustive `z.record` over the enum key would
 *  wrongly reject a `{ pl: … }` map for the missing `en` key. */
export const LocaleStringsMap = z.partialRecord(Locale, z.array(z.string().min(1).max(5_000)).min(1).max(200));
export type LocaleStringsMap = z.infer<typeof LocaleStringsMap>;

/** One ingredient line as the AI returns it inside a recipe draft. Slug must
 *  resolve to an `Ingredient.slug` in the live DB; the validator rejects rows
 *  that don't. */
export const RecipeDraftIngredientLine = z.object({
  slug: z.string().min(1).max(200),
  quantity: z.number().positive().max(1_000_000),
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
  /** The cuisine the recipe ships with, if any. */
  cuisine: Cuisine.nullable(),
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
  targetLocales: z.array(Locale).min(1).max(Locale.options.length).optional(),
  catalogueScope: CatalogueScope.optional(),
  /**
   * Write for the diet and meal that have the fewest recipes, call after
   * call, and stop when every diet has enough for every meal. The run then
   * chooses the diet and the meal itself: `dietTags` and `mealTypes` may not
   * be sent with it.
   */
  fillCoverage: z.boolean().optional(),
  dietTags: z.array(DietType).max(DietType.options.length).optional(),
  mealTypes: z.array(MealType).max(MealType.options.length).optional(),
  /**
   * The direction the model is given, in words. When it names a cuisine the
   * application knows (`Cuisine`), the drafts of the run are tagged with it.
   */
  cuisine: z.string().min(1).max(80).optional(),
  kcalRange: z
    .object({
      min: z.number().int().min(0).max(5000),
      max: z.number().int().min(1).max(5000),
    })
    .refine((r) => r.max >= r.min, { message: 'kcalRange.max must be >= min' })
    .optional(),
  avoidSlugs: z.array(z.string().min(1).max(200)).max(200).optional(),
  preferSlugs: z.array(z.string().min(1).max(200)).max(200).optional(),
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
// The limits here are those of a request, wide enough for any edit: what a
// recipe may hold is said by the rules a draft is checked against, which
// answer with the problems of the draft and not with a refusal.
export const RecipeDraftPatch = z.object({
  slug: z.string().max(200).optional(),
  titles: LocaleStringMap.optional(),
  descriptions: LocaleStringMap.optional(),
  steps: LocaleStringsMap.optional(),
  servings: z.number().int().min(1).max(1000).optional(),
  mealTypes: z.array(MealType).max(MealType.options.length).optional(),
  prepMinutes: z.number().int().min(0).max(100_000).optional(),
  cookMinutes: z.number().int().min(0).max(100_000).optional(),
  difficulty: Difficulty.optional(),
  /** The cuisine to tag the recipe with, or null for none. It is no part of the text: a change of it alone leaves the reviews standing. */
  cuisine: Cuisine.nullable().optional(),
  ingredients: z.array(RecipeDraftIngredientLine).min(1).max(200).optional(),
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

/** A page of the queue: its rows, how many there are in all, and where the page is. */
const pageOf = <T extends z.ZodType>(row: T) =>
  z.object({
    items: z.array(row),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  });

export const RecipeDraftPage = pageOf(RecipeDraft);
export type RecipeDraftPage = z.infer<typeof RecipeDraftPage>;

export const IngredientNameDraftPage = pageOf(IngredientNameDraft);
export type IngredientNameDraftPage = z.infer<typeof IngredientNameDraftPage>;

export const RecipeReviewSlicePage = pageOf(RecipeReviewSlice);
export type RecipeReviewSlicePage = z.infer<typeof RecipeReviewSlicePage>;

export const IngredientNameReviewSlicePage = pageOf(IngredientNameReviewSlice);
export type IngredientNameReviewSlicePage = z.infer<typeof IngredientNameReviewSlicePage>;

/** What rejecting several drafts at once did: those rejected, and those left as they were, with why. */
export const RejectedDrafts = z.object({
  rejected: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), error: z.string() })),
});
export type RejectedDrafts = z.infer<typeof RejectedDrafts>;

/** Whether reviewers may sign in, and the languages there are to review. Never the password. */
export const ReviewStatus = z.object({
  enabled: z.boolean(),
  passwordSet: z.boolean(),
  locales: z.array(Locale),
});
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/** The reviewer's session, or none. */
export const ReviewerSessionAnswer = z.object({ session: ReviewerSessionDto.nullable() });
export type ReviewerSessionAnswer = z.infer<typeof ReviewerSessionAnswer>;

/** A draft that did not ship: which one, and why, as `<rule>` or `<rule>: <detail>`. */
export const SkippedDraft = z.object({
  draftId: z.string(),
  /** The draft's slug, or the slug of the ingredient it names. */
  slug: z.string(),
  reason: z.string(),
});
export type SkippedDraft = z.infer<typeof SkippedDraft>;

/** What the instance's own data directory holds, as far as it can be read. */
export const InstanceDataState = z.object({
  /** Whether the API can write there: a ship that cannot leaves no copy to restore from. */
  writable: z.boolean(),
  recipeFiles: z.number().int().min(0),
  recipes: z.number().int().min(0),
  names: z.number().int().min(0),
});
export type InstanceDataState = z.infer<typeof InstanceDataState>;

/** The ways approved drafts can be shipped on this instance, and how many wait. */
export const ShipConfig = z.object({
  modes: z.object({
    local: z.object({ available: z.literal(true) }),
    upstreamPr: z.object({
      available: z.boolean(),
      enabled: z.boolean(),
      /** Why the mode is not available, when it is not. */
      reason: z.string().nullable(),
      baseBranch: z.string(),
      remote: z.string(),
    }),
    bundle: z.object({ available: z.literal(true) }),
  }),
  pull: z.object({ available: z.literal(true), defaultSource: z.string(), tokenSet: z.boolean() }),
  instanceData: InstanceDataState,
  approvedCounts: z.object({ recipe: z.number().int().min(0), ingredientName: z.number().int().min(0) }),
});
export type ShipConfig = z.infer<typeof ShipConfig>;

/** What a ship did, by the mode it was made in. */
export const ShipResult = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('local'),
    kind: ShipKind,
    shippedDraftIds: z.array(z.string()),
    skipped: z.array(SkippedDraft),
    /** The files of the instance's data directory that were written. */
    sidecarPaths: z.array(z.string()),
    /** Why those files could not be written, when they could not. The ship itself stands. */
    sidecarError: z.string().optional(),
  }),
  z.object({
    mode: z.literal('upstream-pr'),
    prUrl: z.string(),
    branch: z.string(),
    shippedDraftIds: z.array(z.string()),
    skipped: z.array(SkippedDraft),
  }),
  z.object({
    mode: z.literal('bundle'),
    kind: ShipKind,
    batchId: z.string(),
    /** The drafts the bundle holds, and the approved ones left out, each with the reason. */
    draftIds: z.array(z.string()),
    skipped: z.array(SkippedDraft),
    /** The name to save the file under, and what the file holds: a batch of recipes or the names of ingredients, as `data/` keeps them. */
    fileName: z.string(),
    content: z.unknown(),
  }),
]);
export type ShipResult = z.infer<typeof ShipResult>;

/** The pull request that carries this instance's names of ingredients. */
export const OverridesPushed = z.object({
  prUrl: z.string(),
  branch: z.string(),
  rowCount: z.number().int().min(0),
});
export type OverridesPushed = z.infer<typeof OverridesPushed>;

/** What taking names of ingredients in from a file did. */
export const OverridesPulled = z.object({
  source: z.string(),
  resolvedUrl: z.string(),
  /** Ingredients whose names were written, and the rows written for them. */
  applied: z.number().int().min(0),
  rowsWritten: z.number().int().min(0),
  /** Ingredients of the file that this instance does not have. */
  skippedSlugs: z.array(z.string()),
  /** Entries that break a rule for names, each with the reason. Nothing of them was stored. */
  refused: z.array(z.object({ slug: z.string(), reason: z.string() })),
  /** How many ingredients the file names. */
  total: z.number().int().min(0),
});
export type OverridesPulled = z.infer<typeof OverridesPulled>;

/** What restoring from the instance's data directory did. */
export const RestoredFromInstanceData = z.object({
  recipes: z.object({
    added: z.number().int().min(0),
    rewritten: z.number().int().min(0),
    /** Recipes left out, with the file they are in and the reason. */
    skipped: z.array(z.object({ file: z.string(), slug: z.string(), reason: z.string() })),
  }),
  names: z.object({
    applied: z.number().int().min(0),
    /** Names for ingredients the catalogue does not have, and names that break a rule. */
    skippedSlugs: z.array(z.string()),
    refused: z.array(z.object({ slug: z.string(), reason: z.string() })),
  }),
  /** Files that could not be read at all, with the reason. */
  unreadable: z.array(z.object({ file: z.string(), reason: z.string() })),
});
export type RestoredFromInstanceData = z.infer<typeof RestoredFromInstanceData>;
