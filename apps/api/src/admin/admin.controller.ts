// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Admin surfaces. Privacy: instance-only stats — ingredient / recipe /
 * substitution counts and seed bookkeeping. **No per-user signals**, so this
 * panel can never become a user-activity dashboard.
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminConnection,
  AdminHealth,
  AdminStats,
  AdminStatus,
  CatalogueUpdateState,
  DietType,
  FoodImportState,
  Ingredient,
  IngredientListQuery,
  ReplacedIngredient,
  ReplaceIngredientRequest,
  RetiredIngredient,
  UsdaImportQuery,
  type Locale,
} from '@diet-app/shared';
import type { Request } from 'express';
import { CatalogueCoverageService } from '../catalogue/catalogue-coverage.service.js';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isAdminEnabled, type Env } from '../config/env.js';
import { parseTrustProxy } from '../config/trust-proxy.js';
import { COVERAGE_TARGET, MACRO_OUT_OF_REACH } from '../engine/coverage.js';
import { macroSplitOf } from '../engine/nutrition.js';
import { IngredientsService } from '../ingredients/ingredients.service.js';
import { AdminHealthService } from './admin-health.service.js';
import { AdminSessionGuard } from './admin-session.guard.js';
import { InstanceFilesService } from './drafts/ship/instance-files.service.js';
import { retiredIngredientsInUse } from './retired-ingredients.js';
import { computeDataState, resolveDataDir } from './seed/data-hash.js';
import { SeedRunner } from './seed/runner.js';
import { replaceIngredient, ReplaceRefused } from './seed/seeder.js';
import { UsdaImportRunner } from './usda/runner.js';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly runner: SeedRunner,
    private readonly importer: UsdaImportRunner,
    private readonly coverage: CatalogueCoverageService,
    private readonly ingredients: IngredientsService,
    private readonly files: InstanceFilesService,
    private readonly instanceHealth: AdminHealthService,
  ) {}

  /** Whether the panel is on. Anyone may ask: the page does, before there is a session. */
  // Public probe so the /admin UI can render a useful "set ADMIN_PASSWORD"
  // hint without first triggering a 403. Returns enabled-flag only — never
  // any credential material.
  @Get('status')
  @Answers(AdminStatus)
  status(): AdminStatus {
    const adminPassword = this.config.get('ADMIN_PASSWORD', { infer: true });
    const enabled = isAdminEnabled({ ADMIN_PASSWORD: adminPassword });
    return {
      enabled,
      message: enabled
        ? null
        : 'Admin panel is disabled. Set ADMIN_PASSWORD in .env to enable it, then restart the API.',
    };
  }

  /**
   * What the API sees of the connection the administrator is on. Opened
   * through the public address of the instance, it shows whether the reverse
   * proxy passes the client's address on and whether `TRUST_PROXY` is set to
   * believe it.
   */
  @Get('connection')
  @UseGuards(AdminSessionGuard)
  @Answers(AdminConnection)
  connection(@Req() req: Request): AdminConnection {
    const header = req.headers['x-forwarded-for'];
    const forwardedFor = Array.isArray(header) ? header.join(', ') : (header ?? null);
    const forwardedHops = (forwardedFor ?? '')
      .split(',')
      .filter((address) => address.trim().length > 0).length;
    const clientAddress = req.ip ?? null;
    const peerAddress = req.socket.remoteAddress ?? null;
    const trustProxy = parseTrustProxy(this.config.get('TRUST_PROXY', { infer: true }));
    return {
      clientAddress,
      peerAddress,
      forwardedFor,
      forwardedHops,
      trustProxy,
      countedAsProxy: forwardedFor !== null && clientAddress === peerAddress,
      overTrusted: typeof trustProxy === 'number' && forwardedHops < trustProxy,
    };
  }

  /**
   * How the instance stands: the database, the scheduled tasks, this process of
   * the API, how fast it answers, the AI calls of the rolling 30 days and whether
   * mail is set up. Nothing of an account or an address.
   */
  @Get('health')
  @UseGuards(AdminSessionGuard)
  @Answers(AdminHealth)
  health(): Promise<AdminHealth> {
    return this.instanceHealth.read();
  }

  /** What the catalogue holds: its counts, how many recipes each diet has for each meal and how many drafts wait for each, what the plans of each diet reach, and whether the data files have changed since they were last loaded. */
  @Get('stats')
  @UseGuards(AdminSessionGuard)
  @Answers(AdminStats)
  async stats(): Promise<AdminStats> {
    // The catalogue as plans see it: no recipe a user made for themselves, nothing an update retired.
    // One after another, on one connection: the page is opened by one person now and then, and seven
    // connections at once for it would be seven that the requests of accounts wait for.
    const ingredients = await this.prisma.ingredient.count({ where: { retiredAt: null } });
    const recipes = await this.prisma.recipe.count({
      where: { createdByUserId: null, retiredAt: null },
    });
    const substitutions = await this.prisma.substitutionRule.count();
    const meta = await this.prisma.seedMeta.findUnique({ where: { key: 'data' } });
    const coverage = await this.coverage.count();
    const waiting = await this.coverage.waiting();
    const reach = await this.coverage.macroReach();
    const state = computeDataState(resolveDataDir());
    return {
      counts: { ingredients, recipes, substitutions },
      coverage,
      coverageTarget: COVERAGE_TARGET,
      coverageWaiting: waiting,
      macros: {
        outOfReach: MACRO_OUT_OF_REACH,
        diets: Object.fromEntries(
          DietType.options.map((diet) => [
            diet,
            { target: macroSplitOf(diet), reached: reach[diet] },
          ]),
        ) as AdminStats['macros']['diets'],
      },
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
   * Start the catalogue update: the data files are loaded into the database,
   * in the background. 409 while one is running; `db/update/status` says
   * where it stands.
   *
   * The work takes minutes, far longer than a request may, so the answer is
   * given at once and the panel asks for the state again and again.
   */
  @Post('db/update')
  @HttpCode(202)
  @UseGuards(AdminSessionGuard)
  @Answers(CatalogueUpdateState)
  async startUpdate(): Promise<CatalogueUpdateState> {
    const started = await this.runner.start();
    if (!started) {
      throw new ConflictException({
        error: 'UPDATE_IN_PROGRESS',
        message: 'A database update is already in progress.',
      });
    }
    return this.runner.getState();
  }

  /** Where the catalogue update stands. */
  @Get('db/update/status')
  @UseGuards(AdminSessionGuard)
  @Answers(CatalogueUpdateState)
  updateStatus(): Promise<CatalogueUpdateState> {
    return this.runner.getState();
  }

  /**
   * Start an import of foods from USDA FoodData Central, in the background.
   * It writes `ingredients.generated.json` into the data directory, and a
   * catalogue update then loads what it wrote. `?dataTypes=` names the data
   * types of this run (`Foundation,SR Legacy`) in the place of
   * `FDC_DATA_TYPES`.
   */
  @Post('db/import-usda')
  @HttpCode(202)
  @UseGuards(AdminSessionGuard)
  @Answers(FoodImportState)
  async startUsdaImport(
    @Query(new ZodValidationPipe(UsdaImportQuery)) query: UsdaImportQuery,
  ): Promise<FoodImportState> {
    const started = await this.importer.start(query.dataTypes);
    if (!started) {
      throw new ConflictException({
        error: 'IMPORT_IN_PROGRESS',
        message: 'A USDA import is already in progress.',
      });
    }
    return this.importer.getState();
  }

  /** Where the import of foods stands. */
  @Get('db/import-usda/status')
  @UseGuards(AdminSessionGuard)
  @Answers(FoodImportState)
  usdaImportStatus(): Promise<FoodImportState> {
    return this.importer.getState();
  }

  /** The retired ingredients that something of the instance still uses, with what uses them. */
  @Get('ingredients/retired')
  @UseGuards(AdminSessionGuard)
  @AnswersListOf(RetiredIngredient)
  retiredIngredients(@RequestLocale() locale: Locale): Promise<RetiredIngredient[]> {
    return retiredIngredientsInUse(this.prisma, locale);
  }

  /** The ingredients of the catalogue whose name holds `search`: what a retired one can be replaced by. */
  @Get('ingredients')
  @UseGuards(AdminSessionGuard)
  @AnswersListOf(Ingredient)
  searchIngredients(
    @RequestLocale() locale: Locale,
    @Query(new ZodValidationPipe(IngredientListQuery)) query: IngredientListQuery,
  ): Promise<Ingredient[]> {
    return this.ingredients.search(locale, query.search);
  }

  /**
   * Replace a retired ingredient by one of the catalogue: what uses it moves
   * over, with each amount kept, what is worked out from the ingredients of
   * recipes outside the seed is worked out again, the retired ingredient goes,
   * and the instance's files are written again. The text of a recipe is not
   * changed: one that names the old food is for a person to correct.
   */
  @Post('ingredients/:id/replace')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard)
  @Answers(ReplacedIngredient)
  async replaceIngredient(
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(ReplaceIngredientRequest)) body: ReplaceIngredientRequest,
  ): Promise<ReplacedIngredient> {
    let replaced: ReplacedIngredient;
    try {
      replaced = await replaceIngredient(this.prisma, id, body.by);
    } catch (err) {
      if (!(err instanceof ReplaceRefused)) throw err;
      switch (err.code) {
        case 'INGREDIENT_NOT_RETIRED':
          throw new ConflictException({
            error: 'INGREDIENT_NOT_RETIRED',
            message: 'Only a retired ingredient is replaced, and this one is not retired.',
          });
        case 'REPLACEMENT_NOT_IN_CATALOGUE':
          throw new UnprocessableEntityException({
            error: 'REPLACEMENT_NOT_IN_CATALOGUE',
            message: 'The replacement must be another ingredient of the catalogue.',
          });
        case 'UNITS_STAND_IN_THE_WAY':
          throw new ConflictException({
            error: 'UNITS_STAND_IN_THE_WAY',
            message: `The replacement cannot be weighed in ${err.units.join(', ')}, not even through grams.`,
            details: { units: err.units },
          });
      }
    }
    await this.files.write();
    return replaced;
  }
}
