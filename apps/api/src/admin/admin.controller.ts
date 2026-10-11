// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Admin surfaces. Privacy: instance-only stats — ingredient / recipe /
 * substitution counts and seed bookkeeping. **No per-user signals**, so this
 * panel can never become a user-activity dashboard.
 */
import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FdcDataTypes } from '@diet-app/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { CatalogueCoverageService } from '../catalogue/catalogue-coverage.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isAdminEnabled, type Env } from '../config/env.js';
import { parseTrustProxy } from '../config/trust-proxy.js';
import { COVERAGE_TARGET, type CoverageMatrix } from '../engine/coverage.js';
import { BasicAuthGuard } from './basic-auth.guard.js';
import { computeDataState, resolveDataDir } from './seed/data-hash.js';
import { SeedRunner, type RunnerState } from './seed/runner.js';
import { UsdaImportRunner, type ImportRunnerState } from './usda/runner.js';

interface AdminStatusDto {
  enabled: boolean;
  /** Operator-facing hint when disabled — never exposes the configured password. */
  message: string | null;
}

interface AdminStatsDto {
  counts: { ingredients: number; recipes: number; substitutions: number };
  /** How many recipes each diet has for each meal. */
  coverage: CoverageMatrix;
  /** How many a release needs for each: what a recipe run that fills the catalogue writes towards. */
  coverageTarget: number;
  seed: {
    lastSeededAt: string | null;
    storedHash: string | null;
    currentHash: string;
    updateAvailable: boolean;
    /** Per-file presence/size so the UI can warn "run the importer first". */
    files: { name: string; present: boolean; bytes: number }[];
  };
}

/** How this request reached the API, for an operator setting up a reverse proxy. */
interface AdminConnectionDto {
  /** The address requests are counted against: the client's, as far as `TRUST_PROXY` lets it be known. */
  clientAddress: string | null;
  /** The address of the connection itself: the proxy nearest to the API, or the client when there is none. */
  peerAddress: string | null;
  /** `X-Forwarded-For` as it arrived, or null when the request carried none. */
  forwardedFor: string | null;
  /** How many addresses that header holds: one for every proxy that wrote into it. */
  forwardedHops: number;
  /** What `TRUST_PROXY` is set to: `false`, a number of proxies, or their addresses. */
  trustProxy: false | number | string[];
  /**
   * True when the request came through a proxy and the address it is counted
   * against is that proxy's: every client behind it then shares one allowance
   * for everything that is limited by address.
   */
  countedAsProxy: boolean;
  /**
   * True when `TRUST_PROXY` counts more proxies than wrote into the header of
   * this request. The API then takes an address further left for the client
   * than any proxy wrote, which is one a visitor can write themselves: every
   * limit by address can be walked around. The administrator's own browser
   * writes no such header, so their request shows the chain as it is.
   */
  overTrusted: boolean;
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly runner: SeedRunner,
    private readonly importer: UsdaImportRunner,
    private readonly coverage: CatalogueCoverageService,
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

  /**
   * What the API sees of the connection the administrator is on. Opened
   * through the public address of the instance, it shows whether the reverse
   * proxy passes the client's address on and whether `TRUST_PROXY` is set to
   * believe it.
   */
  @Get('connection')
  @UseGuards(BasicAuthGuard)
  connection(@Req() req: Request): AdminConnectionDto {
    const header = req.headers['x-forwarded-for'];
    const forwardedFor = Array.isArray(header) ? header.join(', ') : (header ?? null);
    const forwardedHops = (forwardedFor ?? '').split(',').filter((address) => address.trim().length > 0).length;
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

  @Get('stats')
  @UseGuards(BasicAuthGuard)
  async stats(): Promise<AdminStatsDto> {
    // The catalogue as plans see it: no recipe a user made for themselves, nothing an update retired.
    const [ingredients, recipes, substitutions, meta, coverage] = await Promise.all([
      this.prisma.ingredient.count({ where: { retiredAt: null } }),
      this.prisma.recipe.count({ where: { createdByUserId: null, retiredAt: null } }),
      this.prisma.substitutionRule.count(),
      this.prisma.seedMeta.findUnique({ where: { key: 'data' } }),
      this.coverage.count(),
    ]);
    const state = computeDataState(resolveDataDir());
    return {
      counts: { ingredients, recipes, substitutions },
      coverage,
      coverageTarget: COVERAGE_TARGET,
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
   * Kick off a USDA FoodData Central bulk import. Writes
   * `data/ingredients.generated.json` to the bind-mounted data dir; the
   * operator then runs `db/update` to materialize the new rows. Optional
   * `?dataTypes=` overrides FDC_DATA_TYPES (e.g. `Foundation,SR Legacy`)
   * without an .env edit.
   */
  @Post('db/import-usda')
  @HttpCode(202)
  @UseGuards(BasicAuthGuard)
  startUsdaImport(
    @Query(new ZodValidationPipe(z.object({ dataTypes: FdcDataTypes.optional() }))) query: { dataTypes?: string },
  ): ImportRunnerState {
    const started = this.importer.start(query.dataTypes);
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

