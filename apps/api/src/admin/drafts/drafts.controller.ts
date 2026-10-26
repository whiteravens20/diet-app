// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Curation queue endpoints: ingredient-name drafts, recipe drafts (with a
 * dry-run PATCH for live nutrition recompute) and the ship endpoints — all on
 * this one controller.
 *
 * Auth: AdminSessionGuard, like the rest of /api/admin. Reviewer-cookie auth lives
 * on a separate controller (`/api/review/*`).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  DraftBulkRejectBody,
  DraftLocaleQuery,
  DraftReviewBody,
  DraftRunnerState,
  DryRunQuery,
  IngredientNameDraft,
  IngredientNameDraftListQuery,
  IngredientNameDraftPage,
  IngredientNameDraftPatchBody,
  IngredientNameGenerateSpec,
  MarkShippedRequest,
  RecipeDraft,
  RecipeDraftListQuery,
  RecipeDraftPage,
  RecipeDraftPatch,
  RecipeGenerateSpec,
  RecipeImportRequest,
  RecipeImportResult,
  RecipeRunState,
  RejectedDrafts,
  RestoredFromInstanceData,
  ShipConfig,
  ShipRequest,
  ShipResult,
  StoredImportRejection,
  TargetLocaleQuery,
  TranslationGenerateSpec,
  Updated,
  type Locale,
  type ReviewAction,
  type TargetLocale,
} from '@diet-app/shared';
import { Answers, AnswersListOf, AnswersWithAFile } from '../../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AdminSessionGuard } from '../admin-session.guard.js';
import { DraftService, invalid, type Actor } from './draft.service.js';
import { toIngredientNameDraftDto, toRecipeDraftDto } from './drafts.mapper.js';
import { IngredientNamerRunner, type IngredientNamerStartSpec } from './ingredient-namer.runner.js';
import { RecipeGeneratorRunner } from './recipe-generator.runner.js';
import { AdminModelService } from './admin-model.service.js';
import { RecipeImportService } from './external/recipe-import.service.js';
import { TranslationRunner } from './translation.runner.js';
import { InstanceFilesService } from './ship/instance-files.service.js';
import {
  shipIngredientNamesLocal,
  shipRecipeDraftLocal,
  shipRecipesLocal,
} from './ship/local-mode.js';
import { buildCurrentIngredientOverrides } from './ship/current-overrides.js';
import { NothingShips } from './ship/shippable.js';
import {
  markBundleShipped,
  shipIngredientNamesBundle,
  shipRecipesBundle,
} from './ship/bundle-mode.js';

/** The administrator acting on a draft; a review carries the name they gave instead of this one. */
const ADMIN: Actor = { role: 'ADMIN', label: 'admin' };

@Controller('admin/drafts')
@UseGuards(AdminSessionGuard)
export class DraftsController {
  private readonly logger = new Logger(DraftsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly namer: IngredientNamerRunner,
    private readonly recipeGen: RecipeGeneratorRunner,
    private readonly translations: TranslationRunner,
    private readonly adminModel: AdminModelService,
    private readonly imports: RecipeImportService,
    private readonly drafts: DraftService,
    private readonly files: InstanceFilesService,
  ) {}

  // ── Ingredient-name generation ──────────────────────────────────────────────

  /** Start the run that asks a model for names of ingredients. 409 while one is running. */
  // Kicks off an expensive batched AI run. Admin-gated already; the explicit
  // cap stops an authenticated admin from queuing many costly batches at once.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('ingredient-names/generate')
  @HttpCode(202)
  @Answers(DraftRunnerState)
  async startNamerRun(
    @Body(new ZodValidationPipe(IngredientNameGenerateSpec)) body: IngredientNameGenerateSpec,
  ): Promise<DraftRunnerState> {
    const spec: IngredientNamerStartSpec = {
      scope: body.scope,
      slugs: body.slugs,
      targetLocales: body.targetLocales,
    };
    const started = await this.namer.start(spec);
    if (!started) {
      throw new ConflictException({
        error: 'NAMER_IN_PROGRESS',
        message: 'An ingredient-namer run is already in progress.',
      });
    }
    return this.namerRunnerState();
  }

  /** Where the run of names stands. */
  @Get('ingredient-names/generate/status')
  @Answers(DraftRunnerState)
  namerStatus(): Promise<DraftRunnerState> {
    return this.namerRunnerState();
  }

  /** Stop the run of names. What it has written stays. */
  @Post('ingredient-names/generate/stop')
  @HttpCode(202)
  @Answers(DraftRunnerState)
  async stopNamer(): Promise<DraftRunnerState> {
    await this.namer.cancel();
    return this.namerRunnerState();
  }

  // ── List + read ─────────────────────────────────────────────────────────────

  /** The drafts of names for ingredients, a page at a time, narrowed as asked. */
  @Get('ingredient-names')
  @Answers(IngredientNameDraftPage)
  async listIngredientNameDrafts(
    @Query(new ZodValidationPipe(IngredientNameDraftListQuery)) query: IngredientNameDraftListQuery,
  ): Promise<IngredientNameDraftPage> {
    const found = await this.drafts.listIngredientNames(query);
    return { ...found, items: found.items.map(toIngredientNameDraftDto) };
  }

  /** One draft of a name. */
  @Get('ingredient-names/:id')
  @Answers(IngredientNameDraft)
  async getIngredientNameDraft(
    @Param('id', requiredUuid) id: string,
  ): Promise<IngredientNameDraft> {
    return toIngredientNameDraftDto(await this.drafts.ingredientName(id));
  }

  // ── Edit / approve / reject / delete (ingredient names) ────────────────────

  /** Change what a draft of a name suggests. */
  @Patch('ingredient-names/:id')
  @Answers(IngredientNameDraft)
  async patchIngredientNameDraft(
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(IngredientNameDraftPatchBody))
    { suggestions }: IngredientNameDraftPatchBody,
  ): Promise<IngredientNameDraft> {
    return toIngredientNameDraftDto(await this.drafts.editIngredientName(id, suggestions, ADMIN));
  }

  /** Approve a draft of a name, in the language asked for. */
  @Post('ingredient-names/:id/approve')
  @Answers(IngredientNameDraft)
  approveIngredientNameDraft(
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
    @Body(new ZodValidationPipe(DraftReviewBody)) body: DraftReviewBody,
  ): Promise<IngredientNameDraft> {
    return this.reviewIngredientName(id, locale, body, 'APPROVE');
  }

  /** Reject a draft of a name, in the language asked for, with a reason. */
  @Post('ingredient-names/:id/reject')
  @Answers(IngredientNameDraft)
  rejectIngredientNameDraft(
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
    @Body(new ZodValidationPipe(DraftReviewBody)) body: DraftReviewBody,
  ): Promise<IngredientNameDraft> {
    return this.reviewIngredientName(id, locale, body, 'REJECT');
  }

  /** Remove a draft of a name. */
  @Delete('ingredient-names/:id')
  @HttpCode(204)
  deleteIngredientNameDraft(@Param('id', requiredUuid) id: string): Promise<void> {
    return this.drafts.deleteIngredientName(id, ADMIN);
  }

  // ── Recipe generation ──────────────────────────────────────────────────────

  /** Start the run that asks a model for recipe drafts. 409 while one is running. */
  // Same rationale as ingredient-name generation: cap the costly AI batch start.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('recipes/generate')
  @HttpCode(202)
  @Answers(RecipeRunState)
  async startRecipeRun(
    @Body(new ZodValidationPipe(RecipeGenerateSpec)) spec: RecipeGenerateSpec,
  ): Promise<RecipeRunState> {
    const started = await this.recipeGen.start(spec);
    if (!started) {
      throw new ConflictException({
        error: 'RECIPE_GEN_IN_PROGRESS',
        message: 'A recipe-generator run is already in progress.',
      });
    }
    return this.recipeRunnerState();
  }

  /** Where the run of recipes stands. */
  @Get('recipes/generate/status')
  @Answers(RecipeRunState)
  recipeRunStatus(): Promise<RecipeRunState> {
    return this.recipeRunnerState();
  }

  /** Stop the run of recipes. What it has written stays. */
  @Post('recipes/generate/stop')
  @HttpCode(202)
  @Answers(RecipeRunState)
  async stopRecipeRun(): Promise<RecipeRunState> {
    await this.recipeGen.cancel();
    return this.recipeRunnerState();
  }

  // ── Recipes from elsewhere ──────────────────────────────────────────────────

  /**
   * Take recipes in from a document the operator has: those that resolve
   * against the catalogue become drafts, in English, with where they are from;
   * the others are refused with their reasons and kept for the administrator
   * to look through. With `dryRun` nothing is written. No model is asked and
   * nothing is fetched.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('recipes/import')
  @HttpCode(200)
  @Answers(RecipeImportResult)
  importRecipes(
    @Body(new ZodValidationPipe(RecipeImportRequest)) body: RecipeImportRequest,
  ): Promise<RecipeImportResult> {
    return this.imports.import(body);
  }

  /** The recipes that imports refused, each with the reasons. */
  @Get('recipes/import/rejections')
  @AnswersListOf(StoredImportRejection)
  importRejections(): Promise<StoredImportRejection[]> {
    return this.imports.rejections();
  }

  /** Forget the recipes that imports refused. */
  @Delete('recipes/import/rejections')
  @HttpCode(204)
  clearImportRejections(): Promise<void> {
    return this.imports.clearRejections();
  }

  // ── A missing language ──────────────────────────────────────────────────────

  /**
   * Start the run that fills a language recipes lack. What it writes are
   * drafts for the queue; nothing live changes until a person has approved
   * them and they ship.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('translations/generate')
  @HttpCode(202)
  @Answers(DraftRunnerState)
  async startTranslations(
    @Body(new ZodValidationPipe(TranslationGenerateSpec)) body: TranslationGenerateSpec,
  ): Promise<DraftRunnerState> {
    if (!(await this.translations.start(body))) {
      throw new ConflictException({
        error: 'TRANSLATIONS_IN_PROGRESS',
        message: 'A run that fills a language is already in progress.',
      });
    }
    return this.translationRunnerState();
  }

  /** Where the run that fills a language stands. */
  @Get('translations/generate/status')
  @Answers(DraftRunnerState)
  translationsStatus(): Promise<DraftRunnerState> {
    return this.translationRunnerState();
  }

  /** Stop the run that fills a language. What it has written stays. */
  @Post('translations/generate/stop')
  @HttpCode(202)
  @Answers(DraftRunnerState)
  async stopTranslations(): Promise<DraftRunnerState> {
    await this.translations.cancel();
    return this.translationRunnerState();
  }

  // ── Recipe list + read ─────────────────────────────────────────────────────

  /** The recipe drafts, a page at a time, narrowed as asked. */
  @Get('recipes')
  @Answers(RecipeDraftPage)
  async listRecipeDrafts(
    @Query(new ZodValidationPipe(RecipeDraftListQuery)) query: RecipeDraftListQuery,
  ): Promise<RecipeDraftPage> {
    const found = await this.drafts.listRecipes(query);
    return { ...found, items: found.items.map(toRecipeDraftDto) };
  }

  /** One recipe draft. */
  @Get('recipes/:id')
  @Answers(RecipeDraft)
  async getRecipeDraft(@Param('id', requiredUuid) id: string): Promise<RecipeDraft> {
    return toRecipeDraftDto(await this.drafts.recipe(id));
  }

  // ── Recipe edit / approve / reject / delete ─────────────────────────────────

  /**
   * Change a recipe draft. With `?dryRun=true` the result is answered and
   * not stored: what the editor shows the nutrition of an edit with.
   */
  @Patch('recipes/:id')
  @Answers(RecipeDraft)
  async patchRecipeDraft(
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(RecipeDraftPatch)) patch: RecipeDraftPatch,
    @Query(new ZodValidationPipe(DryRunQuery)) { dryRun }: DryRunQuery,
  ): Promise<RecipeDraft> {
    return toRecipeDraftDto(await this.drafts.editRecipe(id, patch, ADMIN, { dryRun }));
  }

  /** Approve a recipe draft, in the language asked for. */
  @Post('recipes/:id/approve')
  @Answers(RecipeDraft)
  approveRecipeDraft(
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(DraftLocaleQuery)) { locale }: DraftLocaleQuery,
    @Body(new ZodValidationPipe(DraftReviewBody)) body: DraftReviewBody,
  ): Promise<RecipeDraft> {
    return this.reviewRecipe(id, locale, body, 'APPROVE');
  }

  /**
   * Reject up to a hundred recipe drafts with one reason: what the queue is
   * cleared with when users sent what nobody will ship. Answers which were
   * rejected and which were left out, each with the refusal a single
   * rejection would have got.
   */
  @Post('recipes/reject')
  @HttpCode(200)
  @Answers(RejectedDrafts)
  rejectRecipeDrafts(
    @Body(new ZodValidationPipe(DraftBulkRejectBody))
    { ids, reviewedByLabel, reason }: DraftBulkRejectBody,
  ): Promise<RejectedDrafts> {
    return this.drafts.rejectRecipes(ids, reason, { ...ADMIN, label: reviewedByLabel });
  }

  /** Reject a recipe draft, in the language asked for, with a reason. */
  @Post('recipes/:id/reject')
  @Answers(RecipeDraft)
  rejectRecipeDraft(
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(DraftLocaleQuery)) { locale }: DraftLocaleQuery,
    @Body(new ZodValidationPipe(DraftReviewBody)) body: DraftReviewBody,
  ): Promise<RecipeDraft> {
    return this.reviewRecipe(id, locale, body, 'REJECT');
  }

  /** Remove a recipe draft. */
  @Delete('recipes/:id')
  @HttpCode(204)
  deleteRecipeDraft(@Param('id', requiredUuid) id: string): Promise<void> {
    return this.drafts.deleteRecipe(id, ADMIN);
  }

  /**
   * Promote a recipe users made to the shared library: the one draft is
   * shipped into this instance, on the terms of every local ship, and the
   * instance's files are written again. The personal recipes it stands for are
   * left as they are; whoever makes the recipe again is given the shared one.
   */
  @Post('recipes/:id/promote')
  @Answers(RecipeDraft)
  async promoteRecipeDraft(@Param('id', requiredUuid) id: string): Promise<RecipeDraft> {
    const existing = await this.drafts.recipe(id);
    if (existing.source !== 'AI_USER') {
      throw new BadRequestException({
        error: 'DRAFT_NOT_PROMOTABLE',
        message: 'Only AI_USER drafts can be promoted.',
      });
    }
    const notApproved = () =>
      new ConflictException({
        error: 'DRAFT_NOT_APPROVED',
        message: 'Draft must be approved in every locale before it can be promoted.',
      });
    if (existing.status !== 'APPROVED') throw notApproved();

    const outcome = await shipRecipeDraftLocal(this.prisma, id);
    if (!outcome.ok) {
      if (outcome.problems) throw invalid(outcome.problems);
      // Reviewed, edited or promoted by someone else a moment ago.
      if (outcome.reason.startsWith('not-approved')) throw notApproved();
      throw new ConflictException({
        error: 'DRAFT_NOT_SHIPPABLE',
        message: `The draft cannot go into the library: ${outcome.reason}.`,
        details: { reason: outcome.reason },
      });
    }
    await this.files.write();
    return toRecipeDraftDto(outcome.draft);
  }

  // ── Ship ───────────────────────────────────────────────────────────────────

  /** The ways drafts can be shipped on this instance, and how many are approved and wait. */
  @Get('ship/config')
  @Answers(ShipConfig)
  async shipConfig(): Promise<ShipConfig> {
    const recipeCount = await this.prisma.recipeDraft.count({
      where: { status: 'APPROVED' },
    });
    const ingredientCount = await this.prisma.ingredientNameDraft.count({
      where: { status: 'APPROVED' },
    });
    return {
      modes: {
        local: { available: true },
        bundle: { available: true },
      },
      instanceData: await this.files.state(),
      approvedCounts: { recipe: recipeCount, ingredientName: ingredientCount },
    };
  }

  /** Ship the approved drafts of a kind: into this instance, or as a file to save. */
  @Post('ship')
  @Answers(ShipResult)
  async ship(
    @Body(new ZodValidationPipe(ShipRequest)) { kind, mode, batchIds }: ShipRequest,
  ): Promise<ShipResult> {
    if (mode === 'local') {
      const result =
        kind === 'recipe'
          ? await shipRecipesLocal(this.prisma, { kind, batchIds })
          : await shipIngredientNamesLocal(this.prisma, { kind, batchIds });
      if (result.shippedDraftIds.length === 0 && result.skipped.length === 0) {
        throw new ConflictException({
          error: 'SHIP_NO_APPROVED',
          message: 'No approved drafts to ship.',
        });
      }
      // What shipped is in the instance's files from now on.
      const files = result.shippedDraftIds.length > 0 ? await this.files.write() : { written: [] };
      return {
        mode: 'local',
        ...result,
        sidecarPaths: files.written,
        ...(files.error ? { sidecarError: files.error } : {}),
      };
    }

    // bundle: the file itself comes back, to whoever asked with the administrator's credentials
    try {
      const result =
        kind === 'recipe'
          ? await shipRecipesBundle(this.prisma, { kind, batchIds })
          : await shipIngredientNamesBundle(this.prisma, { kind, batchIds });
      return { mode: 'bundle', ...result };
    } catch (err) {
      if (err instanceof NothingShips) {
        throw new ConflictException({
          error: 'NO_VALID_DRAFTS',
          message: 'None of the approved drafts can ship as they are.',
          details: { skipped: err.skipped },
        });
      }
      if (err instanceof Error && err.message === 'NO_APPROVED_DRAFTS') {
        throw new ConflictException({
          error: 'NO_APPROVED_DRAFTS',
          message: 'There are no approved drafts to ship.',
        });
      }
      throw err;
    }
  }

  /**
   * The names this instance has given its ingredients, as the file `data/`
   * keeps them: to carry them to another instance or repository at any time,
   * whatever has shipped.
   */
  @Get('ship/current-overrides')
  @AnswersWithAFile('application/json')
  async downloadCurrentOverrides(@Res() res: Response): Promise<void> {
    const file = await buildCurrentIngredientOverrides(this.prisma);
    res
      .status(200)
      .setHeader('Content-Type', 'application/json; charset=utf-8')
      .setHeader('Content-Disposition', 'attachment; filename="ingredient-overrides.json"')
      .send(JSON.stringify(file, null, 2) + '\n');
  }

  /**
   * Read back into the database what local ships copied to the instance's
   * data directory: the way to carry an instance's own recipes and names to a
   * new server. Repeatable; see `ship/restore.ts`.
   */
  @Post('ship/restore')
  @HttpCode(200)
  @Answers(RestoredFromInstanceData)
  restoreFromInstanceData(): Promise<RestoredFromInstanceData> {
    return this.files.restore();
  }

  /** Mark drafts as shipped, once the file a bundle gave is where it belongs. */
  @Post('ship/mark-shipped')
  @Answers(Updated)
  async shipMarkShipped(
    @Body(new ZodValidationPipe(MarkShippedRequest)) { kind, draftIds }: MarkShippedRequest,
  ): Promise<Updated> {
    return markBundleShipped(this.prisma, kind, draftIds);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** The administrator reviews the languages reviewers review: the name of an ingredient has no English. */
  private async reviewIngredientName(
    id: string,
    locale: TargetLocale,
    { reviewedByLabel, reason }: DraftReviewBody,
    action: ReviewAction,
  ): Promise<IngredientNameDraft> {
    return toIngredientNameDraftDto(
      await this.drafts.reviewIngredientName(
        id,
        { locale, action, reason },
        { ...ADMIN, label: reviewedByLabel },
      ),
    );
  }

  /** The administrator reviews any language of a recipe, and is the one who reviews English. */
  private async reviewRecipe(
    id: string,
    locale: Locale,
    { reviewedByLabel, reason }: DraftReviewBody,
    action: ReviewAction,
  ): Promise<RecipeDraft> {
    return toRecipeDraftDto(
      await this.drafts.reviewRecipe(
        id,
        { locale, action, reason },
        { ...ADMIN, label: reviewedByLabel },
      ),
    );
  }

  private async namerRunnerState(): Promise<DraftRunnerState> {
    return { ...(await this.namer.getState()), configured: this.namer.isConfigured() };
  }

  private async translationRunnerState(): Promise<DraftRunnerState> {
    return { ...(await this.translations.getState()), configured: this.adminModel.configured };
  }

  private async recipeRunnerState(): Promise<RecipeRunState> {
    return { ...(await this.recipeGen.getState()), configured: this.recipeGen.isConfigured() };
  }
}
