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
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { isAdminEnabled, type Env } from '../config/env.js';
import { parseTrustProxy } from '../config/trust-proxy.js';
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
  /** What `TRUST_PROXY` is set to: `false`, a number of proxies, or their addresses. */
  trustProxy: false | number | string[];
  /**
   * True when the request came through a proxy and the address it is counted
   * against is that proxy's: every client behind it then shares one allowance
   * for everything that is limited by address.
   */
  countedAsProxy: boolean;
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly runner: SeedRunner,
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
    const clientAddress = req.ip ?? null;
    const peerAddress = req.socket.remoteAddress ?? null;
    return {
      clientAddress,
      peerAddress,
      forwardedFor,
      trustProxy: parseTrustProxy(this.config.get('TRUST_PROXY', { infer: true })),
      countedAsProxy: forwardedFor !== null && clientAddress === peerAddress,
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

