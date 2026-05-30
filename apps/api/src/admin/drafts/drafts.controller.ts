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
  shipIngredientNamesUpstream,
  shipRecipesUpstream,
  upstreamBlockedReason,
  UpstreamShipError,
  type UpstreamShipConfig,
  type UpstreamShipResult,
} from './ship/upstream-mode.js';
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
      const status = deriveStatus(existing.locales, reviews);

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
      const status = deriveStatus(existing.locales, reviews);

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

/** Status derivation — single source of truth shared by both pipelines.
 *  APPROVED iff every expected locale has an APPROVE row; REJECTED if any
 *  expected locale has a REJECT; PENDING otherwise. SHIPPED is owned by the
 *  ship runner (Phase E) and never derived here. */
function deriveStatus(
  expectedLocales: string[],
  reviews: { locale: string; action: string }[],
): 'PENDING' | 'APPROVED' | 'REJECTED' {
  if (reviews.some((r) => r.action === 'REJECT')) return 'REJECTED';
  const approved = new Set(
    reviews.filter((r) => r.action === 'APPROVE').map((r) => r.locale),
  );
  if (expectedLocales.every((l) => approved.has(l))) return 'APPROVED';
  return 'PENDING';
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
  source: 'AI' | 'EXTERNAL' | 'MANUAL';
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
  source: 'AI' | 'EXTERNAL' | 'MANUAL';
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
