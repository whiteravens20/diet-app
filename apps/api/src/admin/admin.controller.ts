/**
 * F16 admin surfaces. Privacy: instance-only stats — ingredient / recipe /
 * substitution counts and seed bookkeeping. **No per-user signals**, so this
 * panel can never become a user-activity dashboard.
 */
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Locale as LocaleSchema,
  NON_CANONICAL_LOCALES,
  type Locale,
} from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { isAdminEnabled, type Env } from '../config/env.js';
import { BasicAuthGuard } from './basic-auth.guard.js';
import { computeDataState, resolveDataDir } from './seed/data-hash.js';
import { SeedRunner, type RunnerState } from './seed/runner.js';
import {
  TranslateRunner,
  type TranslateRunnerState,
  type TranslateScope,
} from './translate/runner.js';
import { UsdaImportRunner, type ImportRunnerState } from './usda/runner.js';

interface AdminStatusDto {
  enabled: boolean;
  /** Operator-facing hint when disabled — never exposes the configured password. */
  message: string | null;
}

interface AdminStatsDto {
  counts: { ingredients: number; recipes: number; substitutions: number };
  seed: {
    lastSeededAt: string | null;
    storedHash: string | null;
    currentHash: string;
    updateAvailable: boolean;
    /** Per-file presence/size so the UI can warn "run the importer first". */
    files: { name: string; present: boolean; bytes: number }[];
  };
}

/** Per-source counts for a single parent partition (curated or imported). */
interface SourceBreakdown {
  curated_json: number;
  ai: number;
  manual: number;
  missing: number;
}

interface TranslationStatusEntry {
  locale: Locale;
  /** Curated parents = `data/*.json`-sourced rows (ingredients without the
   *  `usda-imported` tag; recipes with `origin = seed`). */
  curated: { ingredients: SourceBreakdown; recipes: SourceBreakdown };
  /** Imported parents = USDA-generated ingredients. Recipes never come from
   *  the importer, so this only has the ingredients axis. */
  imported: { ingredients: SourceBreakdown };
  /** First ~20 missing slugs per partition, so the operator can copy them
   *  to their translator / clipboard. Not exhaustive. */
  missingSamples: {
    curatedIngredients: string[];
    curatedRecipes: string[];
    importedIngredients: string[];
  };
}

const MISSING_SAMPLE_LIMIT = 20;

@Controller('admin')
export class AdminController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly runner: SeedRunner,
    private readonly translator: TranslateRunner,
    private readonly importer: UsdaImportRunner,
  ) {}

  // Public probe so the /admin UI can render a useful "set ADMIN_PASSWORD"
  // hint without first triggering a 403. Returns enabled-flag only — never
  // any credential material.
  @Get('status')
  status(): AdminStatusDto {
    const adminPassword = this.config.get('ADMIN_PASSWORD', { infer: true });
    const enabled = isAdminEnabled({ ADMIN_PASSWORD: adminPassword });
    return {
      enabled,
      message: enabled
        ? null
        : 'Admin panel is disabled. Set ADMIN_PASSWORD in .env to enable it, then restart the API.',
    };
  }

  @Get('stats')
  @UseGuards(BasicAuthGuard)
  async stats(): Promise<AdminStatsDto> {
    const [ingredients, recipes, substitutions, meta] = await Promise.all([
      this.prisma.ingredient.count(),
      this.prisma.recipe.count(),
      this.prisma.substitutionRule.count(),
      this.prisma.seedMeta.findUnique({ where: { key: 'data' } }),
    ]);
    const state = computeDataState(resolveDataDir());
    return {
      counts: { ingredients, recipes, substitutions },
      seed: {
        lastSeededAt: meta?.seededAt.toISOString() ?? null,
        storedHash: meta?.hash ?? null,
        currentHash: state.hash,
        updateAvailable: meta?.hash !== state.hash,
        files: state.files,
      },
    };
  }

  /**
   * Kicks off the updater in the background and returns immediately. The
   * actual work takes minutes — far longer than any sensible HTTP timeout —
   * so the panel polls {@link updateStatus} for progress.
   */
  @Post('db/update')
  @HttpCode(202)
  @UseGuards(BasicAuthGuard)
  startUpdate(): RunnerState {
    const started = this.runner.start();
    if (!started) {
      throw new ConflictException({
        error: 'UPDATE_IN_PROGRESS',
        message: 'A database update is already in progress.',
      });
    }
    return this.runner.getState();
  }

  @Get('db/update/status')
  @UseGuards(BasicAuthGuard)
  updateStatus(): RunnerState {
    return this.runner.getState();
  }

  /**
   * Per-locale translation coverage for the curated DB. Returns one entry per
   * non-canonical locale (every Locale enum value except `en`), broken down
   * into curated / imported partitions × source provenance. The admin
   * translation card iterates over this array so a new locale appears
   * automatically the moment it lands in the Locale enum.
   */
  @Get('translations/status')
  @UseGuards(BasicAuthGuard)
  async translationsStatus(): Promise<TranslationStatusEntry[]> {
    // One query per parent table; partition in memory so we don't need
    // separate Prisma calls per locale × per source.
    const ingredients = await this.prisma.ingredient.findMany({
      select: { id: true, slug: true, name: true, tags: true },
    });
    const recipes = await this.prisma.recipe.findMany({
      where: { origin: 'seed' },
      select: { id: true, slug: true, title: true },
    });
    const curatedIngredients = ingredients.filter((i) => !i.tags.includes('usda-imported'));
    const importedIngredients = ingredients.filter((i) => i.tags.includes('usda-imported'));

    const entries: TranslationStatusEntry[] = [];
    for (const locale of NON_CANONICAL_LOCALES) {
      const [ingTrans, recTrans] = await Promise.all([
        this.prisma.ingredientTranslation.findMany({
          where: { locale },
          select: { ingredientId: true, source: true },
        }),
        this.prisma.recipeTranslation.findMany({
          where: { locale },
          select: { recipeId: true, source: true },
        }),
      ]);
      const ingBySource = new Map(ingTrans.map((t) => [t.ingredientId, t.source]));
      const recBySource = new Map(recTrans.map((t) => [t.recipeId, t.source]));

      const curatedIng = partition(curatedIngredients, ingBySource);
      const importedIng = partition(importedIngredients, ingBySource);
      const curatedRec = partition(recipes, recBySource);

      entries.push({
        locale,
        curated: {
          ingredients: curatedIng.counts,
          recipes: curatedRec.counts,
        },
        imported: { ingredients: importedIng.counts },
        missingSamples: {
          curatedIngredients: curatedIng.missingSlugs,
          curatedRecipes: curatedRec.missingSlugs,
          importedIngredients: importedIng.missingSlugs,
        },
      });
    }
    return entries;
  }

  /**
   * Auto-translate missing rows using the admin-default AI provider
   * (AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL env vars). `locale=all` fans
   * out to every non-canonical locale; otherwise a single locale code.
   * Scope defaults to `missing`.
   */
  @Post('translations/fill')
  @HttpCode(202)
  @UseGuards(BasicAuthGuard)
  startTranslate(
    @Query('locale') locale: string | undefined,
    @Query('scope') scopeRaw: string | undefined,
  ): TranslateRunnerState & { configured: boolean } {
    const scope = (scopeRaw ?? 'missing') as TranslateScope;
    if (!['missing', 'ai', 'all'].includes(scope)) {
      throw new BadRequestException({
        error: 'INVALID_SCOPE',
        message: `scope must be one of: missing, ai, all`,
      });
    }
    let target: 'all' | Locale;
    if (!locale || locale === 'all') {
      target = 'all';
    } else {
      const parsed = LocaleSchema.safeParse(locale);
      if (!parsed.success || locale === 'en') {
        throw new BadRequestException({
          error: 'INVALID_LOCALE',
          message: `locale must be a supported non-canonical Locale, got "${locale}"`,
        });
      }
      target = parsed.data;
    }
    const started = this.translator.start(target, scope);
    if (!started) {
      throw new ConflictException({
        error: 'TRANSLATE_IN_PROGRESS',
        message: 'A translation job is already in progress.',
      });
    }
    return {
      ...this.translator.getState(),
      configured: this.translator.isConfigured(),
    };
  }

  @Get('translations/fill/status')
  @UseGuards(BasicAuthGuard)
  translateStatus(): TranslateRunnerState & { configured: boolean } {
    return {
      ...this.translator.getState(),
      configured: this.translator.isConfigured(),
    };
  }

  /**
   * Cooperative cancel: the runner notices the flag between batches and
   * finalises the in-flight job as `done` with `error: 'cancelled'`. Returns
   * the post-cancel state so the panel can refresh immediately.
   */
  @Post('translations/fill/stop')
  @HttpCode(202)
  @UseGuards(BasicAuthGuard)
  stopTranslate(): TranslateRunnerState & { configured: boolean } {
    this.translator.cancel();
    return {
      ...this.translator.getState(),
      configured: this.translator.isConfigured(),
    };
  }

  /**
   * Hard-delete every `source = AI` translation row across all locales.
   * Refuses (409) while a translation job is running. Use when the operator
   * decides the model's output isn't acceptable and wants to start over.
   */
  @Post('translations/wipe-ai')
  @HttpCode(200)
  @UseGuards(BasicAuthGuard)
  async wipeAiTranslations(): Promise<{ ingredients: number; recipes: number }> {
    try {
      return await this.translator.wipeAi();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConflictException({ error: 'TRANSLATE_IN_PROGRESS', message });
    }
  }

  /**
   * Kick off a USDA FoodData Central bulk import. Writes
   * `data/ingredients.generated.json` to the bind-mounted data dir; the
   * operator then runs `db/update` to materialize the new rows. Optional
   * `?dataTypes=` overrides FDC_DATA_TYPES (e.g. `Foundation,SR Legacy`)
   * without an .env edit.
   */
  @Post('db/import-usda')
  @HttpCode(202)
  @UseGuards(BasicAuthGuard)
  startUsdaImport(@Query('dataTypes') dataTypes: string | undefined): ImportRunnerState {
    const started = this.importer.start(dataTypes);
    if (!started) {
      throw new ConflictException({
        error: 'IMPORT_IN_PROGRESS',
        message: 'A USDA import is already in progress.',
      });
    }
    return this.importer.getState();
  }

  @Get('db/import-usda/status')
  @UseGuards(BasicAuthGuard)
  usdaImportStatus(): ImportRunnerState {
    return this.importer.getState();
  }
}

interface ParentRow {
  id: string;
  slug: string | null;
  name?: string;
  title?: string;
}

/** Count translation coverage for a parent partition + a translation map.
 *  `missingSlugs` is capped at MISSING_SAMPLE_LIMIT so the API stays small. */
function partition(
  parents: ParentRow[],
  bySource: Map<string, 'CURATED_JSON' | 'AI' | 'MANUAL'>,
): { counts: SourceBreakdown; missingSlugs: string[] } {
  const counts: SourceBreakdown = { curated_json: 0, ai: 0, manual: 0, missing: 0 };
  const missingSlugs: string[] = [];
  for (const p of parents) {
    const src = bySource.get(p.id);
    if (src === 'CURATED_JSON') counts.curated_json += 1;
    else if (src === 'AI') counts.ai += 1;
    else if (src === 'MANUAL') counts.manual += 1;
    else {
      counts.missing += 1;
      if (missingSlugs.length < MISSING_SAMPLE_LIMIT) {
        missingSlugs.push(p.slug ?? p.name ?? p.title ?? p.id);
      }
    }
  }
  return { counts, missingSlugs };
}
