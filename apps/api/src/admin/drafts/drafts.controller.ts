/**
 * Curation queue endpoints.
 *
 * Phase C: ingredient-name drafts. Phase D extends with recipe drafts +
 * dry-run PATCH for live nutrition recompute. Ship endpoints arrive in
 * Phase E on the same controller.
 *
 * Auth: BasicAuthGuard, like the rest of /api/admin. Reviewer-cookie auth is
 * Phase H and lives on a separate controller (`/api/review/*`).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { resolve as resolvePath } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  IngredientNameGenerateSpec,
  IngredientNameSuggestion,
  Locale as LocaleSchema,
  RecipeDraftPatch,
  RecipeGenerateSpec,
  type Complexity,
  type DraftRunnerState,
  type IngredientNameDraft,
  type RecipeDraft,
  type RecipeDraftIngredientLine,
} from '@diet-app/shared';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Env } from '../../config/env.js';
import { BasicAuthGuard } from '../basic-auth.guard.js';
import { deriveDraftStatus } from './derive-status.js';
import {
  IngredientNamerRunner,
  type IngredientNamerStartSpec,
} from './ingredient-namer.runner.js';
import {
  RecipeGeneratorRunner,
  type RecipeRunnerState,
} from './recipe-generator.runner.js';
import { nutritionFor, toCanonical } from '../../engine/units.js';
import { classifyComplexity } from './recipe-generator.complexity.js';
import {
  shipIngredientNamesLocal,
  shipRecipesLocal,
  type LocalShipResult,
} from './ship/local-mode.js';
import {
  findRepoRoot,
  pushCurrentOverridesUpstream,
  shipIngredientNamesUpstream,
  shipRecipesUpstream,
  upstreamBlockedReason,
  UpstreamShipError,
  type CurrentOverridesPushResult,
  type UpstreamShipConfig,
  type UpstreamShipResult,
} from './ship/upstream-mode.js';
import { buildCurrentIngredientOverrides } from './ship/current-overrides.js';
import {
  pullOverrides,
  PullOverridesError,
  type PullOverridesResult,
} from './ship/pull-overrides.js';
import {
  consumeBundleToken,
  markBundleShipped,
  shipIngredientNamesBundle,
  shipRecipesBundle,
  type BundleShipResult,
} from './ship/bundle-mode.js';

const ApproveRejectBody = z.object({
  reviewedByLabel: z.string().min(1).max(80),
  reason: z.string().max(500).optional(),
});

const PatchSuggestionsBody = z.object({
  suggestions: IngredientNameSuggestion,
});

const ShipKind = z.enum(['recipe', 'ingredient-name']);
const ShipMode = z.enum(['local', 'upstream-pr', 'bundle']);
const ShipBody = z.object({
  kind: ShipKind,
  mode: ShipMode,
  batchIds: z.array(z.string().min(1)).optional(),
});

const MarkShippedBody = z.object({
  kind: ShipKind,
  draftIds: z.array(z.string().uuid()).min(1),
});

const PullOverridesBody = z.object({
  /** Repo (`owner/repo[@branch]`) or a full raw URL. Falls back to the env
   *  default when omitted/blank. */
  source: z.string().trim().min(1).optional(),
});

interface ShipConfigDto {
  modes: {
    local: { available: true };
    upstreamPr: {
      available: boolean;
      enabled: boolean;
      reason: string | null;
      baseBranch: string;
      remote: string;
    };
    bundle: { available: true; ttlSeconds: number };
  };
  pull: { available: true; defaultSource: string; tokenSet: boolean };
  approvedCounts: { recipe: number; ingredientName: number };
}

type ShipResponseDto =
  | ({ mode: 'local' } & LocalShipResult)
  | ({ mode: 'upstream-pr' } & UpstreamShipResult)
  | ({ mode: 'bundle' } & BundleShipResult);

@Controller('admin/drafts')
@UseGuards(BasicAuthGuard)
export class DraftsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly namer: IngredientNamerRunner,
    private readonly recipeGen: RecipeGeneratorRunner,
  ) {}

  // ── Ingredient-name generation ──────────────────────────────────────────────

  @Post('ingredient-names/generate')
  @HttpCode(202)
  startNamerRun(@Body() body: unknown): DraftRunnerState {
    const parsed = IngredientNameGenerateSpec.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_SPEC',
        message: parsed.error.message,
      });
    }
    const spec: IngredientNamerStartSpec = {
      scope: parsed.data.scope,
      slugs: parsed.data.slugs,
      targetLocales: parsed.data.targetLocales,
    };
    if (spec.scope === 'specific-slugs' && (!spec.slugs || spec.slugs.length === 0)) {
      throw new BadRequestException({
        error: 'INVALID_SPEC',
        message: 'scope=specific-slugs requires a non-empty `slugs` array',
      });
    }
    const started = this.namer.start(spec);
    if (!started) {
      throw new ConflictException({
        error: 'NAMER_IN_PROGRESS',
        message: 'An ingredient-namer run is already in progress.',
      });
    }
    return this.namerRunnerState();
  }

  @Get('ingredient-names/generate/status')
  namerStatus(): DraftRunnerState {
    return this.namerRunnerState();
  }

  @Post('ingredient-names/generate/stop')
  @HttpCode(202)
  stopNamer(): DraftRunnerState {
    this.namer.cancel();
    return this.namerRunnerState();
  }

  // ── List + read ─────────────────────────────────────────────────────────────

  @Get('ingredient-names')
  async listIngredientNameDrafts(
    @Query('status') status: string | undefined,
    @Query('batchId') batchId: string | undefined,
    @Query('page') pageRaw: string | undefined,
    @Query('pageSize') pageSizeRaw: string | undefined,
  ): Promise<{ items: IngredientNameDraft[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Number.parseInt(pageRaw ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(pageSizeRaw ?? '25', 10) || 25));
    const where = {
      ...(status ? { status: status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED' } : {}),
      ...(batchId ? { batchId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.ingredientNameDraft.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { localeReviews: true },
      }),
      this.prisma.ingredientNameDraft.count({ where }),
    ]);
    return {
      items: items.map(toIngredientNameDraftDto),
      total,
      page,
      pageSize,
    };
  }

  @Get('ingredient-names/:id')
  async getIngredientNameDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IngredientNameDraft> {
    const row = await this.prisma.ingredientNameDraft.findUnique({
      where: { id },
      include: { localeReviews: true },
    });
    if (!row) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
    return toIngredientNameDraftDto(row);
  }

  // ── Edit / approve / reject / delete (ingredient names) ────────────────────

  @Patch('ingredient-names/:id')
  async patchIngredientNameDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<IngredientNameDraft> {
    const parsed = PatchSuggestionsBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ error: 'INVALID_PATCH', message: parsed.error.message });
    }
    // Any edit invalidates partial reviews (§3 invariant).
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.ingredientNameDraft.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
      await tx.ingredientNameDraftLocaleReview.deleteMany({ where: { draftId: id } });
      return tx.ingredientNameDraft.update({
        where: { id },
        data: {
          suggestions: parsed.data.suggestions,
          status: 'PENDING',
        },
        include: { localeReviews: true },
      });
    });
    return toIngredientNameDraftDto(updated);
  }

  @Post('ingredient-names/:id/approve')
  async approveIngredientNameDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') locale: string,
    @Body() body: unknown,
  ): Promise<IngredientNameDraft> {
    return this.upsertIngredientReview(id, locale, body, 'APPROVE');
  }

  @Post('ingredient-names/:id/reject')
  async rejectIngredientNameDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') locale: string,
    @Body() body: unknown,
  ): Promise<IngredientNameDraft> {
    return this.upsertIngredientReview(id, locale, body, 'REJECT');
  }

  @Delete('ingredient-names/:id')
  @HttpCode(204)
  async deleteIngredientNameDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const existing = await this.prisma.ingredientNameDraft.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
    if (existing.status === 'SHIPPED') {
      throw new ConflictException({
        error: 'DRAFT_SHIPPED',
        message: 'Shipped drafts cannot be deleted — the row has already been written to data/*.json.',
      });
    }
    await this.prisma.ingredientNameDraft.delete({ where: { id } });
  }

  // ── Recipe generation ──────────────────────────────────────────────────────

  @Post('recipes/generate')
  @HttpCode(202)
  startRecipeRun(@Body() body: unknown): RecipeRunnerStateDto {
    const parsed = RecipeGenerateSpec.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_RECIPE_SPEC',
        message: parsed.error.message,
      });
    }
    const started = this.recipeGen.start(parsed.data);
    if (!started) {
      throw new ConflictException({
        error: 'RECIPE_GEN_IN_PROGRESS',
        message: 'A recipe-generator run is already in progress.',
      });
    }
    return this.recipeRunnerState();
  }

  @Get('recipes/generate/status')
  recipeRunStatus(): RecipeRunnerStateDto {
    return this.recipeRunnerState();
  }

  @Post('recipes/generate/stop')
  @HttpCode(202)
  stopRecipeRun(): RecipeRunnerStateDto {
    this.recipeGen.cancel();
    return this.recipeRunnerState();
  }

  // ── Recipe list + read ─────────────────────────────────────────────────────

  @Get('recipes')
  async listRecipeDrafts(
    @Query('status') status: string | undefined,
    @Query('batchId') batchId: string | undefined,
    @Query('complexity') complexity: string | undefined,
    @Query('page') pageRaw: string | undefined,
    @Query('pageSize') pageSizeRaw: string | undefined,
  ): Promise<{ items: RecipeDraft[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Number.parseInt(pageRaw ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(pageSizeRaw ?? '25', 10) || 25));
    const where = {
      ...(status ? { status: status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED' } : {}),
      ...(batchId ? { batchId } : {}),
      ...(complexity ? { complexity } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.recipeDraft.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { localeReviews: true },
      }),
      this.prisma.recipeDraft.count({ where }),
    ]);
    return {
      items: items.map(toRecipeDraftDto),
      total,
      page,
      pageSize,
    };
  }

  @Get('recipes/:id')
  async getRecipeDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RecipeDraft> {
    const row = await this.prisma.recipeDraft.findUnique({
      where: { id },
      include: { localeReviews: true },
    });
    if (!row) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
    return toRecipeDraftDto(row);
  }

  // ── Recipe edit / approve / reject / delete ─────────────────────────────────

  /**
   * Patch a recipe draft. `?dryRun=true` returns the recomputed shape without
   * persisting — the inline editor uses it for live nutrition feedback. A
   * persisted patch re-runs the engine recompute, re-tags complexity, and
   * wipes existing localeReviews (PATCH invalidates partial reviews per §3).
   */
  @Patch('recipes/:id')
  async patchRecipeDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Query('dryRun') dryRunRaw: string | undefined,
  ): Promise<RecipeDraft> {
    const parsed = RecipeDraftPatch.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_PATCH',
        message: parsed.error.message,
      });
    }
    const dryRun = dryRunRaw === 'true' || dryRunRaw === '1';

    const existing = await this.prisma.recipeDraft.findUnique({
      where: { id },
      include: { localeReviews: true },
    });
    if (!existing) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
    if (existing.status === 'SHIPPED') {
      throw new ConflictException({
        error: 'DRAFT_SHIPPED',
        message: 'Shipped drafts cannot be edited.',
      });
    }

    // AI_USER drafts (personal recipes mirrored into the queue by the user's
    // /recipes/ai-draft or applyIngredientSwap path) accept TRANSLATION-only
    // edits — `titles`, `descriptions`, `steps`. Structural edits would
    // break the dedup invariant (the fingerprint is over the ingredient set)
    // and undermine the personal Recipe's nutrition recompute. Admins who
    // need to restructure must promote first, then edit the curated row via
    // the existing admin path.
    if (existing.source === 'AI_USER' && hasStructuralEdit(parsed.data)) {
      throw new ForbiddenException({
        error: 'DRAFT_STRUCTURAL_EDIT_FORBIDDEN',
        message: 'User-drafted recipes: translation edits only.',
      });
    }

    const merged = mergeRecipeDraft(existing, parsed.data);
    const recompute = await this.recomputeRecipe(merged);

    if (dryRun) {
      return toRecipeDraftDto({
        ...existing,
        titles: merged.titles,
        descriptions: merged.descriptions,
        steps: merged.steps,
        servings: merged.servings,
        mealTypes: merged.mealTypes,
        dietTags: merged.dietTags,
        prepMinutes: merged.prepMinutes,
        cookMinutes: merged.cookMinutes,
        difficulty: merged.difficulty,
        ingredientsJson: merged.ingredients as unknown as object,
        complexity: recompute.complexity,
        caloriesPerServing: recompute.caloriesPerServing,
        proteinPerServing: recompute.proteinPerServing,
        fatPerServing: recompute.fatPerServing,
        carbsPerServing: recompute.carbsPerServing,
        allergens: recompute.allergens,
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.recipeDraftLocaleReview.deleteMany({ where: { draftId: id } });
      return tx.recipeDraft.update({
        where: { id },
        data: {
          titles: merged.titles,
          descriptions: merged.descriptions,
          steps: merged.steps,
          servings: merged.servings,
          mealTypes: merged.mealTypes,
          dietTags: merged.dietTags,
          prepMinutes: merged.prepMinutes,
          cookMinutes: merged.cookMinutes,
          difficulty: merged.difficulty,
          ingredientsJson: merged.ingredients as unknown as object,
          complexity: recompute.complexity,
          caloriesPerServing: recompute.caloriesPerServing,
          proteinPerServing: recompute.proteinPerServing,
          fatPerServing: recompute.fatPerServing,
          carbsPerServing: recompute.carbsPerServing,
          allergens: recompute.allergens,
          status: 'PENDING',
        },
        include: { localeReviews: true },
      });
    });
    return toRecipeDraftDto(updated);
  }

  @Post('recipes/:id/approve')
  async approveRecipeDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') locale: string,
    @Body() body: unknown,
  ): Promise<RecipeDraft> {
    return this.upsertRecipeReview(id, locale, body, 'APPROVE');
  }

  @Post('recipes/:id/reject')
  async rejectRecipeDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') locale: string,
    @Body() body: unknown,
  ): Promise<RecipeDraft> {
    return this.upsertRecipeReview(id, locale, body, 'REJECT');
  }

  @Delete('recipes/:id')
  @HttpCode(204)
  async deleteRecipeDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const existing = await this.prisma.recipeDraft.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
    if (existing.status === 'SHIPPED') {
      throw new ConflictException({
        error: 'DRAFT_SHIPPED',
        message: 'Shipped recipe drafts cannot be deleted.',
      });
    }
    await this.prisma.recipeDraft.delete({ where: { id } });
  }

  /**
   * Promote an APPROVED AI_USER draft to a curated `Recipe`. Creates a new
   * Recipe row with `origin: 'curated'`, copies the polished `RecipeTranslation`
   * rows from the draft (per-locale `titles` / `descriptions` / `steps`),
   * sets `RecipeDraft.promotedRecipeId`, marks the draft `SHIPPED`. Personal
   * Recipe rows in `sourceRecipeIds` are intentionally left untouched — their
   * planned meals stay reproducible. Future fingerprint matches resolve to
   * the new curated row.
   */
  @Post('recipes/:id/promote')
  async promoteRecipeDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RecipeDraft> {
    const existing = await this.prisma.recipeDraft.findUnique({
      where: { id },
      include: { localeReviews: true },
    });
    if (!existing) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
    if (existing.source !== 'AI_USER') {
      throw new BadRequestException({
        error: 'DRAFT_NOT_PROMOTABLE',
        message: 'Only AI_USER drafts can be promoted.',
      });
    }
    if (existing.status !== 'APPROVED') {
      throw new ConflictException({
        error: 'DRAFT_NOT_APPROVED',
        message: 'Draft must be approved in every locale before it can be promoted.',
      });
    }

    const titles = existing.titles as Record<string, string>;
    const descriptions = existing.descriptions as Record<string, string>;
    const steps = existing.steps as Record<string, string[]>;

    // Same-instance promotion: copy the structural payload (ingredients with
    // their resolved ingredientId, units, quantities) directly from the
    // first personal source Recipe rather than re-resolving slugs. Avoids
    // failing on ingredients with null slugs (legacy / USDA imports).
    if (existing.sourceRecipeIds.length === 0) {
      throw new ConflictException({
        error: 'DRAFT_NO_SOURCE_RECIPE',
        message: 'Draft is not linked to a source recipe — cannot promote.',
      });
    }
    const sourceRecipe = await this.prisma.recipe.findUnique({
      where: { id: existing.sourceRecipeIds[0]! },
      include: { ingredients: true },
    });
    if (!sourceRecipe) {
      throw new ConflictException({
        error: 'DRAFT_NO_SOURCE_RECIPE',
        message: 'Source recipe was deleted — cannot promote.',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // `Recipe.fingerprint` is uniquely indexed; the personal source rows
      // currently hold the same fingerprint as the draft. Clear it on them
      // before assigning it to the curated row so future dedup hits land
      // on curated (case 1) instead of the user's old variant.
      await tx.recipe.updateMany({
        where: { id: { in: existing.sourceRecipeIds } },
        data: { fingerprint: null },
      });
      const curated = await tx.recipe.create({
        data: {
          title: titles.en ?? Object.values(titles)[0] ?? existing.slug,
          description: descriptions.en ?? Object.values(descriptions)[0] ?? '',
          servings: existing.servings,
          mealTypes: existing.mealTypes,
          dietTags: existing.dietTags,
          steps: steps.en ?? Object.values(steps)[0] ?? [],
          prepMinutes: existing.prepMinutes,
          cookMinutes: existing.cookMinutes,
          difficulty: existing.difficulty,
          allergens: existing.allergens,
          origin: 'curated',
          createdByUserId: null,
          fingerprint: existing.fingerprint,
          caloriesPerServing: existing.caloriesPerServing,
          proteinPerServing: existing.proteinPerServing,
          fatPerServing: existing.fatPerServing,
          carbsPerServing: existing.carbsPerServing,
          ingredients: {
            create: sourceRecipe.ingredients.map((line) => ({
              ingredientId: line.ingredientId,
              quantity: line.quantity,
              unit: line.unit,
              note: line.note,
            })),
          },
        },
      });
      for (const lc of existing.locales) {
        await tx.recipeTranslation.create({
          data: {
            recipeId: curated.id,
            locale: lc,
            title: titles[lc] ?? titles.en ?? existing.slug,
            description: descriptions[lc] ?? descriptions.en ?? '',
            steps: steps[lc] ?? steps.en ?? [],
            source: 'CURATED_JSON',
          },
        });
      }
      return tx.recipeDraft.update({
        where: { id },
        data: {
          promotedRecipeId: curated.id,
          status: 'SHIPPED',
          shippedAt: new Date(),
        },
        include: { localeReviews: true },
      });
    });
    return toRecipeDraftDto(updated);
  }

  // ── Ship ───────────────────────────────────────────────────────────────────

  @Get('ship/config')
  async shipConfig(): Promise<ShipConfigDto> {
    const upstreamConfig = this.readUpstreamConfig();
    const recipeCount = await this.prisma.recipeDraft.count({
      where: { status: 'APPROVED' },
    });
    const ingredientCount = await this.prisma.ingredientNameDraft.count({
      where: { status: 'APPROVED' },
    });
    const repoRoot = findRepoRoot(process.cwd());
    const upstreamReason = upstreamBlockedReason(upstreamConfig, repoRoot);
    return {
      modes: {
        local: { available: true },
        upstreamPr: {
          available: upstreamReason === null,
          enabled: upstreamConfig.enabled,
          reason: upstreamReason,
          baseBranch: upstreamConfig.baseBranch,
          remote: upstreamConfig.remote,
        },
        bundle: { available: true, ttlSeconds: 600 },
      },
      pull: {
        available: true,
        defaultSource: this.config.get('OVERRIDES_PULL_SOURCE', { infer: true }),
        tokenSet: this.pullToken() !== null,
      },
      approvedCounts: { recipe: recipeCount, ingredientName: ingredientCount },
    };
  }

  @Post('ship')
  async ship(@Body() body: unknown): Promise<ShipResponseDto> {
    const parsed = ShipBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_SHIP_REQUEST',
        message: parsed.error.message,
      });
    }
    const { kind, mode, batchIds } = parsed.data;

    if (mode === 'local') {
      const instanceDataDir = this.resolveInstanceDataDir();
      const result =
        kind === 'recipe'
          ? await shipRecipesLocal(this.prisma, { kind, batchIds, instanceDataDir })
          : await shipIngredientNamesLocal(this.prisma, { kind, batchIds, instanceDataDir });
      if (result.shippedDraftIds.length === 0 && result.skipped.length === 0) {
        throw new ConflictException({
          error: 'SHIP_NO_APPROVED',
          message: 'No approved drafts to ship.',
        });
      }
      return { mode: 'local', ...result };
    }

    if (mode === 'upstream-pr') {
      const config = this.readUpstreamConfig();
      const repoRoot = findRepoRoot(process.cwd());
      if (!repoRoot) {
        throw new InternalServerErrorException({
          error: 'SHIP_REPO_ROOT_NOT_FOUND',
          message: 'Could not find git repo root.',
        });
      }
      const blocked = upstreamBlockedReason(config, repoRoot);
      if (blocked) {
        throw new ConflictException({
          error: blocked,
          message: `Upstream-PR mode refused: ${blocked}.`,
        });
      }
      const dataDir = resolvePath(repoRoot, 'data');
      try {
        const result =
          kind === 'recipe'
            ? await shipRecipesUpstream(this.prisma, { kind, batchIds, dataDir, repoRoot, config })
            : await shipIngredientNamesUpstream(this.prisma, {
                kind,
                batchIds,
                dataDir,
                repoRoot,
                config,
              });
        return { mode: 'upstream-pr', ...result };
      } catch (err) {
        if (err instanceof UpstreamShipError) {
          throw new ConflictException({ error: err.code, message: err.message });
        }
        throw err;
      }
    }

    // bundle
    const secret = this.bundleSecret();
    const appUrl = this.config.get('APP_URL', { infer: true }) ?? '';
    try {
      const result =
        kind === 'recipe'
          ? await shipRecipesBundle(this.prisma, { kind, batchIds }, secret, appUrl)
          : await shipIngredientNamesBundle(this.prisma, { kind, batchIds }, secret, appUrl);
      return { mode: 'bundle', ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'NO_APPROVED_DRAFTS' || message === 'NO_VALID_DRAFTS') {
        throw new ConflictException({ error: message, message });
      }
      throw err;
    }
  }

  @Get('ship/download/:token')
  async shipDownload(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const secret = this.bundleSecret();
    const payload = consumeBundleToken(token, secret);
    if (!payload) {
      res.status(410).json({
        error: 'SHIP_BUNDLE_TOKEN_INVALID',
        message: 'Bundle token expired, invalid, or already consumed.',
      });
      return;
    }
    const filename = `${payload.kind}-${payload.batchId}.json`;
    res
      .status(200)
      .setHeader('Content-Type', 'application/json; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      .send(JSON.stringify(payload, null, 2));
  }

  /** Download the full current ingredient-override set, rebuilt from the live
   *  DB (every MANUAL translation). Available any time — independent of draft
   *  status — so the operator can lift the accumulated overrides into another
   *  instance or repo even after everything has been shipped. */
  @Get('ship/current-overrides')
  async downloadCurrentOverrides(@Res() res: Response): Promise<void> {
    const file = await buildCurrentIngredientOverrides(this.prisma);
    res
      .status(200)
      .setHeader('Content-Type', 'application/json; charset=utf-8')
      .setHeader('Content-Disposition', 'attachment; filename="ingredient-overrides.json"')
      .send(JSON.stringify(file, null, 2) + '\n');
  }

  /** Push the full current ingredient-override set to the configured upstream
   *  repo as a gh PR (reuses the upstream-pr env config + plumbing). Not tied
   *  to draft status. */
  @Post('ship/current-overrides/push')
  async pushCurrentOverrides(): Promise<CurrentOverridesPushResult> {
    const config = this.readUpstreamConfig();
    const repoRoot = findRepoRoot(process.cwd());
    if (!repoRoot) {
      throw new InternalServerErrorException({
        error: 'SHIP_REPO_ROOT_NOT_FOUND',
        message: 'Could not find git repo root.',
      });
    }
    const blocked = upstreamBlockedReason(config, repoRoot);
    if (blocked) {
      throw new ConflictException({
        error: blocked,
        message: `Upstream push refused: ${blocked}.`,
      });
    }
    const dataDir = resolvePath(repoRoot, 'data');
    try {
      return await pushCurrentOverridesUpstream(this.prisma, { dataDir, repoRoot, config });
    } catch (err) {
      if (err instanceof UpstreamShipError) {
        throw new ConflictException({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  /** Pull ingredient overrides from a repo the operator names (or the env
   *  default) and apply them to this instance's DB as MANUAL translations. The
   *  reverse of the local ship — sync overrides authored elsewhere (or the
   *  canonical community set) without rebuilding the image. Public repos need
   *  no auth; private GitHub repos use the env PAT. */
  @Post('ship/current-overrides/pull')
  async pullCurrentOverrides(@Body() body: unknown): Promise<PullOverridesResult> {
    const parsed = PullOverridesBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_PULL_REQUEST',
        message: parsed.error.message,
      });
    }
    const source =
      parsed.data.source ??
      this.config.get('OVERRIDES_PULL_SOURCE', { infer: true }) ??
      'whiteravens20/diet-app';
    try {
      return await pullOverrides(this.prisma, source, this.pullToken());
    } catch (err) {
      if (err instanceof PullOverridesError) {
        throw new ConflictException({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  /** PAT for pulling from a private repo: the dedicated var, falling back to
   *  the upstream-push token. Null when neither is set (public-only). */
  private pullToken(): string | null {
    return (
      this.config.get('OVERRIDES_PULL_TOKEN', { infer: true }) ??
      this.config.get('SHIP_UPSTREAM_GH_TOKEN', { infer: true }) ??
      null
    );
  }

  @Post('ship/mark-shipped')
  async shipMarkShipped(@Body() body: unknown): Promise<{ updated: number }> {
    const parsed = MarkShippedBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_MARK_SHIPPED_REQUEST',
        message: parsed.error.message,
      });
    }
    return markBundleShipped(this.prisma, parsed.data.kind, parsed.data.draftIds);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private readUpstreamConfig(): UpstreamShipConfig {
    return {
      enabled: Boolean(this.config.get('SHIP_UPSTREAM_ENABLED', { infer: true })),
      remote: this.config.get('SHIP_UPSTREAM_REMOTE', { infer: true }) ?? 'origin',
      baseBranch: this.config.get('SHIP_UPSTREAM_BASE_BRANCH', { infer: true }) ?? 'main',
      ghToken: this.config.get('SHIP_UPSTREAM_GH_TOKEN', { infer: true }) ?? null,
      authorName: this.config.get('SHIP_UPSTREAM_GIT_AUTHOR_NAME', { infer: true }) ?? null,
      authorEmail: this.config.get('SHIP_UPSTREAM_GIT_AUTHOR_EMAIL', { infer: true }) ?? null,
    };
  }

  private resolveInstanceDataDir(): string {
    const raw = this.config.get('INSTANCE_DATA_DIR', { infer: true }) ?? 'instance-data';
    return resolvePath(process.cwd(), raw);
  }

  private bundleSecret(): string {
    const explicit = this.config.get('SHIP_DOWNLOAD_TOKEN_SECRET', { infer: true });
    if (explicit && explicit.length > 0) return explicit;
    return this.config.get('JWT_ACCESS_SECRET', { infer: true })!;
  }

  private async upsertIngredientReview(
    id: string,
    localeRaw: string,
    body: unknown,
    action: 'APPROVE' | 'REJECT',
  ): Promise<IngredientNameDraft> {
    const localeParse = LocaleSchema.safeParse(localeRaw);
    if (!localeParse.success || localeRaw === 'en') {
      throw new BadRequestException({
        error: 'INVALID_LOCALE',
        message: `locale must be a supported non-canonical Locale, got "${localeRaw}"`,
      });
    }
    const bodyParse = ApproveRejectBody.safeParse(body);
    if (!bodyParse.success) {
      throw new BadRequestException({
        error: 'INVALID_REVIEW',
        message: bodyParse.error.message,
      });
    }
    const locale = localeParse.data;

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.ingredientNameDraft.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
      if (existing.status === 'SHIPPED') {
        throw new ConflictException({
          error: 'DRAFT_SHIPPED',
          message: 'Shipped drafts cannot be re-reviewed.',
        });
      }
      if (!existing.locales.includes(locale)) {
        throw new BadRequestException({
          error: 'LOCALE_NOT_IN_DRAFT',
          message: `Draft was not generated for locale "${locale}".`,
        });
      }

      await tx.ingredientNameDraftLocaleReview.upsert({
        where: { draftId_locale: { draftId: id, locale } },
        create: {
          draftId: id,
          locale,
          action,
          reviewedByLabel: bodyParse.data.reviewedByLabel,
          reason: bodyParse.data.reason ?? null,
        },
        update: {
          action,
          reviewedByLabel: bodyParse.data.reviewedByLabel,
          reason: bodyParse.data.reason ?? null,
          reviewedAt: new Date(),
        },
      });

      const reviews = await tx.ingredientNameDraftLocaleReview.findMany({
        where: { draftId: id },
      });
      const status = deriveDraftStatus(existing.locales, reviews);

      return tx.ingredientNameDraft.update({
        where: { id },
        data: { status },
        include: { localeReviews: true },
      });
    });

    return toIngredientNameDraftDto(updated);
  }

  private async upsertRecipeReview(
    id: string,
    localeRaw: string,
    body: unknown,
    action: 'APPROVE' | 'REJECT',
  ): Promise<RecipeDraft> {
    // EN is canonical and always part of the draft; reviewers approve EN too
    // for traceability (the admin acts as the EN reviewer in practice — Phase
    // H gates non-`en` to the reviewer cookie). Allow any supported locale.
    const localeParse = LocaleSchema.safeParse(localeRaw);
    if (!localeParse.success) {
      throw new BadRequestException({
        error: 'INVALID_LOCALE',
        message: `locale must be a supported Locale, got "${localeRaw}"`,
      });
    }
    const bodyParse = ApproveRejectBody.safeParse(body);
    if (!bodyParse.success) {
      throw new BadRequestException({
        error: 'INVALID_REVIEW',
        message: bodyParse.error.message,
      });
    }
    const locale = localeParse.data;

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.recipeDraft.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
      if (existing.status === 'SHIPPED') {
        throw new ConflictException({
          error: 'DRAFT_SHIPPED',
          message: 'Shipped drafts cannot be re-reviewed.',
        });
      }
      if (!existing.locales.includes(locale)) {
        throw new BadRequestException({
          error: 'LOCALE_NOT_IN_DRAFT',
          message: `Draft was not generated for locale "${locale}".`,
        });
      }

      await tx.recipeDraftLocaleReview.upsert({
        where: { draftId_locale: { draftId: id, locale } },
        create: {
          draftId: id,
          locale,
          action,
          reviewedByLabel: bodyParse.data.reviewedByLabel,
          reason: bodyParse.data.reason ?? null,
        },
        update: {
          action,
          reviewedByLabel: bodyParse.data.reviewedByLabel,
          reason: bodyParse.data.reason ?? null,
          reviewedAt: new Date(),
        },
      });

      const reviews = await tx.recipeDraftLocaleReview.findMany({
        where: { draftId: id },
      });
      const status = deriveDraftStatus(existing.locales, reviews);

      return tx.recipeDraft.update({
        where: { id },
        data: { status },
        include: { localeReviews: true },
      });
    });

    return toRecipeDraftDto(updated);
  }

  private async recomputeRecipe(
    merged: ReturnType<typeof mergeRecipeDraft>,
  ): Promise<{
    complexity: Complexity;
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
    allergens: string[];
  }> {
    const slugs = [...new Set(merged.ingredients.map((i) => i.slug))];
    const rows = await this.prisma.ingredient.findMany({
      where: { slug: { in: slugs } },
      select: {
        slug: true,
        canonicalUnit: true,
        gramsPerPiece: true,
        density: true,
        caloriesPer100: true,
        proteinPer100: true,
        fatPer100: true,
        carbsPer100: true,
        allergens: true,
      },
    });
    const bySlug = new Map(rows.map((r) => [r.slug!, r]));

    let calories = 0;
    let protein = 0;
    let fat = 0;
    let carbs = 0;
    const allergens = new Set<string>();
    for (const line of merged.ingredients) {
      const row = bySlug.get(line.slug);
      if (!row) {
        throw new BadRequestException({
          error: 'UNKNOWN_SLUG',
          message: `ingredient slug "${line.slug}" not found in the curated catalogue`,
        });
      }
      let canonical: number;
      try {
        canonical = toCanonical(line.quantity, line.unit, {
          canonicalUnit: row.canonicalUnit,
          gramsPerPiece: row.gramsPerPiece,
          density: row.density,
        });
      } catch (err) {
        throw new BadRequestException({
          error: 'UNIT_CONVERSION_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      const n = nutritionFor(canonical, {
        calories: row.caloriesPer100,
        protein: row.proteinPer100,
        fat: row.fatPer100,
        carbs: row.carbsPer100,
      });
      calories += n.calories;
      protein += n.protein;
      fat += n.fat;
      carbs += n.carbs;
      for (const a of row.allergens) allergens.add(a);
    }

    const stepCount =
      (merged.steps as Record<string, string[]>).en?.length ??
      Object.values(merged.steps as Record<string, string[]>)[0]?.length ??
      0;
    const totalMinutes = merged.prepMinutes + merged.cookMinutes;
    const complexity = classifyComplexity({
      ingredientCount: merged.ingredients.length,
      stepCount,
      totalMinutes,
    });
    if (complexity === null) {
      throw new BadRequestException({
        error: 'OUT_OF_COMPLEXITY_BAND',
        message: `recipe is outside every complexity band (ingredients=${merged.ingredients.length}, steps=${stepCount}, minutes=${totalMinutes})`,
      });
    }

    return {
      complexity,
      caloriesPerServing: Math.round(calories / merged.servings),
      proteinPerServing: Math.round(protein / merged.servings),
      fatPerServing: Math.round(fat / merged.servings),
      carbsPerServing: Math.round(carbs / merged.servings),
      allergens: [...allergens].sort(),
    };
  }

  private namerRunnerState(): DraftRunnerState {
    const state = this.namer.getState();
    return {
      status: state.status,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      processed: state.processed,
      total: state.total,
      failed: state.failed,
      written: state.written,
      provider: state.provider,
      model: state.model,
      batchId: state.batchId,
      error: state.error,
      configured: this.namer.isConfigured(),
    };
  }

  private recipeRunnerState(): RecipeRunnerStateDto {
    const state = this.recipeGen.getState();
    return {
      status: state.status,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      processed: state.processed,
      total: state.total,
      failed: state.failed,
      written: state.written,
      provider: state.provider,
      model: state.model,
      batchId: state.batchId,
      error: state.error,
      configured: this.recipeGen.isConfigured(),
      complexityCounts: state.complexityCounts,
      mixDrift: state.mixDrift,
      lastRejectReason: state.lastRejectReason,
      lastRejectKey: state.lastRejectKey,
      lastRejectHead: state.lastRejectHead,
    };
  }
}

export interface RecipeRunnerStateDto extends DraftRunnerState {
  complexityCounts: RecipeRunnerState['complexityCounts'];
  mixDrift: boolean;
  lastRejectReason: string | null;
  lastRejectKey: string | null;
  lastRejectHead: string | null;
}


interface RawRecipeDraft {
  id: string;
  slug: string;
  titles: unknown;
  descriptions: unknown;
  steps: unknown;
  locales: string[];
  servings: number;
  mealTypes: string[];
  dietTags: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  complexity: string;
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  allergens: string[];
  ingredientsJson: unknown;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';
  source: 'AI' | 'EXTERNAL' | 'MANUAL' | 'AI_USER';
  batchId: string;
  modelUsed: string | null;
  generatorPrompt: string | null;
  generationSpec: unknown;
  provenanceUrl: string | null;
  provenanceLicense: string | null;
  shippedPRUrl: string | null;
  shippedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  localeReviews: {
    locale: string;
    action: string;
    reviewedByLabel: string;
    reason: string | null;
    reviewedAt: Date;
  }[];
}

function toRecipeDraftDto(row: RawRecipeDraft): RecipeDraft {
  return {
    id: row.id,
    slug: row.slug,
    titles: row.titles as RecipeDraft['titles'],
    descriptions: row.descriptions as RecipeDraft['descriptions'],
    steps: row.steps as RecipeDraft['steps'],
    locales: row.locales as RecipeDraft['locales'],
    servings: row.servings,
    mealTypes: row.mealTypes as RecipeDraft['mealTypes'],
    dietTags: row.dietTags as RecipeDraft['dietTags'],
    prepMinutes: row.prepMinutes,
    cookMinutes: row.cookMinutes,
    difficulty: row.difficulty,
    complexity: row.complexity as RecipeDraft['complexity'],
    caloriesPerServing: row.caloriesPerServing,
    proteinPerServing: row.proteinPerServing,
    fatPerServing: row.fatPerServing,
    carbsPerServing: row.carbsPerServing,
    allergens: row.allergens,
    ingredients: row.ingredientsJson as RecipeDraftIngredientLine[],
    status: row.status,
    source: row.source,
    batchId: row.batchId,
    modelUsed: row.modelUsed,
    generatorPrompt: row.generatorPrompt,
    generationSpec: row.generationSpec ?? null,
    provenanceUrl: row.provenanceUrl,
    provenanceLicense: row.provenanceLicense,
    shippedPRUrl: row.shippedPRUrl,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    localeReviews: row.localeReviews.map((r) => ({
      locale: r.locale as RecipeDraft['localeReviews'][number]['locale'],
      action: r.action as 'APPROVE' | 'REJECT',
      reviewedByLabel: r.reviewedByLabel,
      reason: r.reason,
      reviewedAt: r.reviewedAt.toISOString(),
    })),
  };
}

interface RawIngredientNameDraft {
  id: string;
  ingredientId: string | null;
  ingredientSlug: string;
  rawDescription: string;
  suggestions: unknown;
  locales: string[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';
  source: 'AI' | 'EXTERNAL' | 'MANUAL' | 'AI_USER';
  batchId: string;
  modelUsed: string | null;
  generatorPrompt: string | null;
  shippedPRUrl: string | null;
  shippedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  localeReviews: {
    locale: string;
    action: string;
    reviewedByLabel: string;
    reason: string | null;
    reviewedAt: Date;
  }[];
}

function toIngredientNameDraftDto(row: RawIngredientNameDraft): IngredientNameDraft {
  const suggestions = row.suggestions as IngredientNameSuggestion;
  return {
    id: row.id,
    ingredientId: row.ingredientId,
    ingredientSlug: row.ingredientSlug,
    rawDescription: row.rawDescription,
    suggestions,
    locales: row.locales as IngredientNameDraft['locales'],
    status: row.status,
    source: row.source,
    batchId: row.batchId,
    modelUsed: row.modelUsed,
    generatorPrompt: row.generatorPrompt,
    shippedPRUrl: row.shippedPRUrl,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    localeReviews: row.localeReviews.map((r) => ({
      locale: r.locale as IngredientNameDraft['localeReviews'][number]['locale'],
      action: r.action as 'APPROVE' | 'REJECT',
      reviewedByLabel: r.reviewedByLabel,
      reason: r.reason,
      reviewedAt: r.reviewedAt.toISOString(),
    })),
  };
}

interface MergedRecipeDraft {
  titles: Record<string, string>;
  descriptions: Record<string, string>;
  steps: Record<string, string[]>;
  servings: number;
  mealTypes: string[];
  dietTags: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  ingredients: RecipeDraftIngredientLine[];
}

/**
 * True when the patch touches any non-translation field. AI_USER drafts only
 * accept `titles` / `descriptions` / `steps` per locale — anything else
 * (ingredients, quantities, servings, mealTypes, dietTags, prep/cook times,
 * difficulty) is forbidden because it would invalidate the personal Recipe
 * rows attached via `sourceRecipeIds`.
 */
function hasStructuralEdit(patch: import('@diet-app/shared').RecipeDraftPatch): boolean {
  return (
    patch.servings != null ||
    patch.mealTypes != null ||
    patch.dietTags != null ||
    patch.prepMinutes != null ||
    patch.cookMinutes != null ||
    patch.difficulty != null ||
    patch.ingredients != null
  );
}

function mergeRecipeDraft(
  existing: RawRecipeDraft,
  patch: import('@diet-app/shared').RecipeDraftPatch,
): MergedRecipeDraft {
  return {
    titles: patch.titles ?? (existing.titles as Record<string, string>),
    descriptions: patch.descriptions ?? (existing.descriptions as Record<string, string>),
    steps: patch.steps ?? (existing.steps as Record<string, string[]>),
    servings: patch.servings ?? existing.servings,
    mealTypes: patch.mealTypes ?? (existing.mealTypes as string[]),
    dietTags: patch.dietTags ?? (existing.dietTags as string[]),
    prepMinutes: patch.prepMinutes ?? existing.prepMinutes,
    cookMinutes: patch.cookMinutes ?? existing.cookMinutes,
    difficulty: patch.difficulty ?? existing.difficulty,
    ingredients:
      patch.ingredients ??
      (existing.ingredientsJson as RecipeDraftIngredientLine[]),
  };
}
