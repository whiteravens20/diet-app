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
  Logger,
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
import {
  shipIngredientNamesLocal,
  shipRecipeDraftLocal,
  shipRecipesLocal,
  writeRecipeSidecar,
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
  type PullPolicy,
} from './ship/pull-overrides.js';
import { NothingShips } from './ship/shippable.js';
import { instanceDataState, restoreInstanceData, type InstanceDataState, type RestoreResult } from './ship/restore.js';
import {
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
    bundle: { available: true };
  };
  pull: { available: true; defaultSource: string; tokenSet: boolean };
  /** The instance's own data directory: what a local ship has copied there, and whether it still can. */
  instanceData: InstanceDataState;
  approvedCounts: { recipe: number; ingredientName: number };
}

type ShipResponseDto =
  | ({ mode: 'local' } & LocalShipResult)
  | ({ mode: 'upstream-pr' } & UpstreamShipResult)
  | ({ mode: 'bundle' } & BundleShipResult);

@Controller('admin/drafts')
@UseGuards(BasicAuthGuard)
export class DraftsController {
  private readonly logger = new Logger(DraftsController.name);

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
   * Promote a recipe users made to the shared library: the one draft is
   * shipped into this instance, on the terms of every local ship, and written
   * to the instance's data directory. The personal recipes it stands for are
   * left as they are; whoever makes the recipe again is given the shared one.
   */
  @Post('recipes/:id/promote')
  async promoteRecipeDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RecipeDraft> {
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
    const { sidecarError } = writeRecipeSidecar(this.resolveInstanceDataDir(), [outcome.content]);
    if (sidecarError) this.logger.warn(`Promoted ${outcome.content.slug}, but its copy in the instance's data directory was not written: ${sidecarError}`);
    return toRecipeDraftDto(outcome.draft);
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
        bundle: { available: true },
      },
      pull: {
        available: true,
        defaultSource: this.config.get('OVERRIDES_PULL_SOURCE', { infer: true }),
        tokenSet: this.pullToken() !== null,
      },
      instanceData: instanceDataState(this.resolveInstanceDataDir()),
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
      const { config, repoRoot, dataDir } = this.upstreamTarget();
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
          throw new ConflictException({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
        }
        throw err;
      }
    }

    // bundle: the file itself comes back, to whoever asked with the administrator's credentials
    try {
      const result = kind === 'recipe' ? await shipRecipesBundle(this.prisma, { kind, batchIds }) : await shipIngredientNamesBundle(this.prisma, { kind, batchIds });
      return { mode: 'bundle', ...result };
    } catch (err) {
      if (err instanceof NothingShips) {
        throw new ConflictException({ error: 'NO_VALID_DRAFTS', message: 'None of the approved drafts can ship as they are.', details: { skipped: err.skipped } });
      }
      if (err instanceof Error && err.message === 'NO_APPROVED_DRAFTS') {
        throw new ConflictException({ error: 'NO_APPROVED_DRAFTS', message: 'There are no approved drafts to ship.' });
      }
      throw err;
    }
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
    const { config, repoRoot, dataDir } = this.upstreamTarget();
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
      return await pullOverrides(this.prisma, source, this.pullPolicy());
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

  /**
   * The terms of a pull: the token, and the hosts that are fetched from
   * wherever they are. Those are the hosts the operator listed, and the host
   * of the default source when the operator set that to an address.
   */
  private pullPolicy(): PullPolicy {
    const listed = (this.config.get('OVERRIDES_PULL_ALLOWED_HOSTS', { infer: true }) ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter((host) => host.length > 0);
    const preset = this.config.get('OVERRIDES_PULL_SOURCE', { infer: true });
    const presetHost = /^https?:\/\//i.test(preset) && URL.canParse(preset) ? [new URL(preset).host] : [];
    return { token: this.pullToken(), allowedHosts: [...listed, ...presetHost] };
  }

  /**
   * Read back into the database what local ships copied to the instance's
   * data directory: the way to carry an instance's own recipes and names to a
   * new server. Repeatable; see `ship/restore.ts`.
   */
  @Post('ship/restore')
  @HttpCode(200)
  restoreFromInstanceData(): Promise<RestoreResult> {
    return restoreInstanceData(this.prisma, this.resolveInstanceDataDir());
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

  /**
   * Where a pull-request ship would write and push, or the refusal that
   * stands in its way: what the settings decide first, then the tool, then
   * the checkout and its remote.
   */
  private upstreamTarget(): { config: UpstreamShipConfig; repoRoot: string; dataDir: string } {
    const config = this.readUpstreamConfig();
    const repoRoot = findRepoRoot(process.cwd());
    const blocked = upstreamBlockedReason(config, repoRoot);
    if (blocked !== null || repoRoot === null) {
      const code = blocked ?? 'SHIP_REPO_ROOT_NOT_FOUND';
      throw new ConflictException({ error: code, message: `Shipping as a pull request is refused: ${code}.` });
    }
    return { config, repoRoot, dataDir: resolvePath(repoRoot, 'data') };
  }

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
    return { ...this.namer.getState(), configured: this.namer.isConfigured() };
  }

  private recipeRunnerState(): RecipeRunnerStateDto {
    return { ...this.recipeGen.getState(), configured: this.recipeGen.isConfigured() };
  }
}

export interface RecipeRunnerStateDto extends DraftRunnerState {
  complexityCounts: RecipeRunnerState['complexityCounts'];
  mixDrift: boolean;
  lastRejectReason: string | null;
  lastRejectKey: string | null;
  lastRejectHead: string | null;
}
