/**
 * Curation queue contracts.
 *
 * Drafts are the AI-proposed / human-approved staging area for recipes and
 * ingredient-name overrides. See [docs/adr/0008-curation-queue.md]. The
 * invariant is **AI proposes → human approves in-app → PR ships to data/*.json
 * → re-seed lands in DB** — these schemas describe every payload that crosses
 * the wire along that path.
 *
 * Phase C scope (this file): ingredient-name drafts + the runner-status
 * shape they share with the recipe pipeline. Phase D extends with the recipe
 * draft shape.
 */
import { z } from 'zod';
import { Locale } from './settings.js';

export const DraftStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SHIPPED']);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const DraftSource = z.enum(['AI', 'EXTERNAL', 'MANUAL']);
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
 */
export const LocaleStringMap = z.record(Locale, z.string().min(1));
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
