// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Curation queue endpoints: ingredient-name drafts, recipe drafts (with a
 * dry-run PATCH for live nutrition recompute) and the ship endpoints — all on
 * this one controller.
 *
 * Auth: BasicAuthGuard, like the rest of /api/admin. Reviewer-cookie auth lives
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
import { Throttle } from '@nestjs/throttler';
import {
  IngredientNameDraftListQuery,
  IngredientNameGenerateSpec,
  IngredientNameSuggestion,
  Locale as LocaleSchema,
  RecipeDraftListQuery,
  RecipeDraftPatch,
  RecipeGenerateSpec,
  TargetLocale,
  type DraftRunnerState,
  type IngredientNameDraft,
  type RecipeDraft,
  type ReviewAction,
} from '@diet-app/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Env } from '../../config/env.js';
import { deriveKey } from '../../common/crypto.js';
import { BasicAuthGuard } from '../basic-auth.guard.js';
import { DraftService, invalid, type Actor, type Page } from './draft.service.js';
import { toIngredientNameDraftDto, toRecipeDraftDto } from './drafts.mapper.js';
import {
  IngredientNamerRunner,
  type IngredientNamerStartSpec,
} from './ingredient-namer.runner.js';
import {
  RecipeGeneratorRunner,
  type RecipeRunnerState,
} from './recipe-generator.runner.js';
import { recipeFacts, type RecipeFacts } from '../../engine/recipe-facts.js';
import { checkRecipeText } from '../../recipes/recipe-rules.js';
import { UnitConversionError } from '../../engine/units.js';
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

/** The administrator acting on a draft; a review carries the name they gave instead of this one. */
const ADMIN: Actor = { role: 'ADMIN', label: 'admin' };

/** `body` checked against `schema`, or a 400 under the code this route has always answered with. */
function bodyOf<T>(schema: z.ZodType<T>, body: unknown, code: string): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException({ error: code, message: result.error.message });
  return result.data;
}

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
    private readonly drafts: DraftService,
  ) {}

  // ── Ingredient-name generation ──────────────────────────────────────────────

  // Kicks off an expensive batched AI run. Admin-gated already; the explicit
  // cap stops an authenticated admin from queuing many costly batches at once.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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
    @Query(new ZodValidationPipe(IngredientNameDraftListQuery)) query: IngredientNameDraftListQuery,
  ): Promise<Page<IngredientNameDraft>> {
    const found = await this.drafts.listIngredientNames(query);
    return { ...found, items: found.items.map(toIngredientNameDraftDto) };
  }

  @Get('ingredient-names/:id')
  async getIngredientNameDraft(@Param('id', new ParseUUIDPipe()) id: string): Promise<IngredientNameDraft> {
    return toIngredientNameDraftDto(await this.drafts.ingredientName(id));
  }

  // ── Edit / approve / reject / delete (ingredient names) ────────────────────

  @Patch('ingredient-names/:id')
  async patchIngredientNameDraft(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown): Promise<IngredientNameDraft> {
    const { suggestions } = bodyOf(PatchSuggestionsBody, body, 'INVALID_PATCH');
    return toIngredientNameDraftDto(await this.drafts.editIngredientName(id, suggestions, ADMIN));
  }

  @Post('ingredient-names/:id/approve')
  approveIngredientNameDraft(@Param('id', new ParseUUIDPipe()) id: string, @Query('locale') locale: string, @Body() body: unknown): Promise<IngredientNameDraft> {
    return this.reviewIngredientName(id, locale, body, 'APPROVE');
  }

  @Post('ingredient-names/:id/reject')
  rejectIngredientNameDraft(@Param('id', new ParseUUIDPipe()) id: string, @Query('locale') locale: string, @Body() body: unknown): Promise<IngredientNameDraft> {
    return this.reviewIngredientName(id, locale, body, 'REJECT');
  }

  @Delete('ingredient-names/:id')
  @HttpCode(204)
  deleteIngredientNameDraft(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.drafts.deleteIngredientName(id, ADMIN);
  }

  // ── Recipe generation ──────────────────────────────────────────────────────

  // Same rationale as ingredient-name generation: cap the costly AI batch start.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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
  async listRecipeDrafts(@Query(new ZodValidationPipe(RecipeDraftListQuery)) query: RecipeDraftListQuery): Promise<Page<RecipeDraft>> {
    const found = await this.drafts.listRecipes(query);
    return { ...found, items: found.items.map(toRecipeDraftDto) };
  }

  @Get('recipes/:id')
  async getRecipeDraft(@Param('id', new ParseUUIDPipe()) id: string): Promise<RecipeDraft> {
    return toRecipeDraftDto(await this.drafts.recipe(id));
  }

  // ── Recipe edit / approve / reject / delete ─────────────────────────────────

  /**
   * Patch a recipe draft. `?dryRun=true` returns the result without storing
   * it — the inline editor uses it for live nutrition feedback.
   */
  @Patch('recipes/:id')
  async patchRecipeDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Query('dryRun') dryRun: string | undefined,
  ): Promise<RecipeDraft> {
    const patch = bodyOf(RecipeDraftPatch, body, 'INVALID_PATCH');
    return toRecipeDraftDto(await this.drafts.editRecipe(id, patch, ADMIN, { dryRun: dryRun === 'true' || dryRun === '1' }));
  }

  @Post('recipes/:id/approve')
  approveRecipeDraft(@Param('id', new ParseUUIDPipe()) id: string, @Query('locale') locale: string, @Body() body: unknown): Promise<RecipeDraft> {
    return this.reviewRecipe(id, locale, body, 'APPROVE');
  }

  @Post('recipes/:id/reject')
  rejectRecipeDraft(@Param('id', new ParseUUIDPipe()) id: string, @Query('locale') locale: string, @Body() body: unknown): Promise<RecipeDraft> {
    return this.reviewRecipe(id, locale, body, 'REJECT');
  }

  @Delete('recipes/:id')
  @HttpCode(204)
  deleteRecipeDraft(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.drafts.deleteRecipe(id, ADMIN);
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

    // The text that goes into the shared library is held to the rules of
    // every recipe, and goes in as the plain lines the check returns.
    const text = checkRecipeText({ titles: existing.titles, descriptions: existing.descriptions, steps: existing.steps }, existing.locales);
    if (!text.ok) throw invalid(text.problems);
    const { titles, descriptions, steps } = text.text;

    // Same-instance promotion: copy the structural payload (ingredients with
    // their resolved ingredientId, units, quantities) directly from a personal
    // source Recipe rather than re-resolving slugs. The draft may stand for
    // the recipes of several users, all made of the same lines; any of them
    // that still exists will do.
    const sourceRecipe = await this.prisma.recipe.findFirst({
      where: { id: { in: existing.sourceRecipeIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { ingredients: { include: { ingredient: true } } },
    });
    if (!sourceRecipe) {
      throw new ConflictException({
        error: 'DRAFT_NO_SOURCE_RECIPE',
        message: 'No recipe this draft was made from exists any more — cannot promote.',
      });
    }
    // The shared recipe gets the facts of the ingredient lines it is written
    // with, worked out now, not the numbers the draft was stored with.
    let facts: RecipeFacts;
    try {
      facts = recipeFacts(sourceRecipe.ingredients, existing.servings);
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      throw new BadRequestException({ error: 'UNIT_CONVERSION_FAILED', message: err.message });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // The shared recipe carries the same fingerprint as the personal ones
      // it was made from: from here on, whoever makes this recipe again is
      // given the shared one.
      const curated = await tx.recipe.create({
        data: {
          title: titles.en ?? Object.values(titles)[0] ?? existing.slug,
          description: descriptions.en ?? Object.values(descriptions)[0] ?? '',
          servings: existing.servings,
          mealTypes: existing.mealTypes,
          dietTags: facts.dietTags,
          steps: steps.en ?? Object.values(steps)[0] ?? [],
          prepMinutes: existing.prepMinutes,
          cookMinutes: existing.cookMinutes,
          difficulty: existing.difficulty,
          allergens: facts.allergens,
          origin: 'curated',
          createdByUserId: null,
          fingerprint: existing.fingerprint,
          caloriesPerServing: facts.perServing.calories,
          proteinPerServing: facts.perServing.protein,
          fatPerServing: facts.perServing.fat,
          carbsPerServing: facts.perServing.carbs,
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
            // Approved by people in the queue. Not `CURATED_JSON`: that is
            // text from the data files, which an update rewrites.
            source: 'MANUAL',
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
    return deriveKey(this.config.get('DATA_ENCRYPTION_SECRET', { infer: true }), 'bundle-download');
  }

  /** The administrator reviews the languages reviewers review: the name of an ingredient has no English. */
  private async reviewIngredientName(id: string, locale: string, body: unknown, action: ReviewAction): Promise<IngredientNameDraft> {
    const target = TargetLocale.safeParse(locale);
    if (!target.success) {
      throw new BadRequestException({ error: 'INVALID_LOCALE', message: `locale must be a supported non-canonical Locale, got "${locale}"` });
    }
    const { reviewedByLabel, reason } = bodyOf(ApproveRejectBody, body, 'INVALID_REVIEW');
    return toIngredientNameDraftDto(await this.drafts.reviewIngredientName(id, { locale: target.data, action, reason }, { ...ADMIN, label: reviewedByLabel }));
  }

  /** The administrator reviews any language of a recipe, and is the one who reviews English. */
  private async reviewRecipe(id: string, locale: string, body: unknown, action: ReviewAction): Promise<RecipeDraft> {
    const target = LocaleSchema.safeParse(locale);
    if (!target.success) {
      throw new BadRequestException({ error: 'INVALID_LOCALE', message: `locale must be a supported Locale, got "${locale}"` });
    }
    const { reviewedByLabel, reason } = bodyOf(ApproveRejectBody, body, 'INVALID_REVIEW');
    return toRecipeDraftDto(await this.drafts.reviewRecipe(id, { locale: target.data, action, reason }, { ...ADMIN, label: reviewedByLabel }));
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
