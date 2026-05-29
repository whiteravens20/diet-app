/**
 * Curation queue endpoints.
 *
 * Phase C scope: ingredient-name drafts (generate / list / patch / approve /
 * reject / delete). Recipe drafts + ship endpoints are added in Phases D + E
 * on the same controller — the pipeline shape is shared by design.
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
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IngredientNameGenerateSpec,
  IngredientNameSuggestion,
  Locale as LocaleSchema,
  type DraftRunnerState,
  type IngredientNameDraft,
} from '@diet-app/shared';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Env } from '../../config/env.js';
import { BasicAuthGuard } from '../basic-auth.guard.js';
import {
  IngredientNamerRunner,
  type IngredientNamerStartSpec,
} from './ingredient-namer.runner.js';

const ApproveRejectBody = z.object({
  reviewedByLabel: z.string().min(1).max(80),
  reason: z.string().max(500).optional(),
});

const PatchSuggestionsBody = z.object({
  suggestions: IngredientNameSuggestion,
});

@Controller('admin/drafts')
@UseGuards(BasicAuthGuard)
export class DraftsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly namer: IngredientNamerRunner,
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
    return this.runnerState();
  }

  @Get('ingredient-names/generate/status')
  namerStatus(): DraftRunnerState {
    return this.runnerState();
  }

  @Post('ingredient-names/generate/stop')
  @HttpCode(202)
  stopNamer(): DraftRunnerState {
    this.namer.cancel();
    return this.runnerState();
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

  // ── Edit / approve / reject / delete ────────────────────────────────────────

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
    return this.upsertReview(id, locale, body, 'APPROVE');
  }

  @Post('ingredient-names/:id/reject')
  async rejectIngredientNameDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') locale: string,
    @Body() body: unknown,
  ): Promise<IngredientNameDraft> {
    return this.upsertReview(id, locale, body, 'REJECT');
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

  // ── Internals ───────────────────────────────────────────────────────────────

  private async upsertReview(
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

  private runnerState(): DraftRunnerState {
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
}

/** Status derivation — single source of truth shared with the recipe pipeline.
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
  // Cast through unknown because Prisma surfaces JSON columns as
  // `Prisma.JsonValue`; the shape is enforced by the validator on the way in
  // and by the Zod schema on the way out.
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
