/**
 * F16 admin surfaces. Privacy: instance-only stats — ingredient / recipe /
 * substitution counts and seed bookkeeping. **No per-user signals**, so this
 * panel can never become a user-activity dashboard.
 */
import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { isAdminEnabled, type Env } from '../config/env.js';
import { BasicAuthGuard } from './basic-auth.guard.js';
import { computeDataState, resolveDataDir } from './seed/data-hash.js';
import { updateDatabase } from './seed/seeder.js';

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

interface DbUpdateDto {
  deletedRecipes: number;
  deletedIngredients: number;
  counts: { ingredients: number; recipes: number; substitutions: number };
  hash: string;
  seededAt: string;
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
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

  @Post('db/update')
  @HttpCode(200)
  @UseGuards(BasicAuthGuard)
  async updateDb(): Promise<DbUpdateDto> {
    const result = await updateDatabase(this.prisma, resolveDataDir());
    return {
      deletedRecipes: result.deletedRecipes,
      deletedIngredients: result.deletedIngredients,
      counts: {
        ingredients: result.ingredients,
        recipes: result.recipes,
        substitutions: result.substitutions,
      },
      hash: result.hash,
      seededAt: result.seededAt.toISOString(),
    };
  }
}
