/**
 * Reviewer-facing API (Phase H).
 *
 * Three classes of endpoints:
 *   1. Auth — public; cookie-based login / logout / session probe.
 *   2. Recipe drafts — guarded; locale supplied per-request via `?locale=`.
 *   3. Ingredient-name drafts — same shape, different table.
 *
 * A single reviewer can review every non-canonical locale: the cookie carries
 * only `label`, and the locale comes in on each request. This makes a
 * multilingual reviewer a no-op — pick a locale tab in the UI, the request
 * carries `?locale=` and the audit row is written against that locale +
 * the cookie's label.
 *
 * EN is the canonical authoring language; reviewer endpoints reject it on
 * sight (validating EN against itself is meaningless).
 *
 * PATCH invalidation: editing any translatable field wipes every locale's
 * review row and resets `status = PENDING` (matches admin PATCH semantics —
 * see drafts.controller.ts §3 invariant in the plan).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import {
  IngredientNameReviewPatchBody,
  Locale as LocaleSchema,
  NON_CANONICAL_LOCALES,
  RecipeReviewPatchBody,
  ReviewerLoginBody,
  ReviewerReasonBody,
  type IngredientNameReviewSlice,
  type Locale,
  type RecipeReviewSlice,
  type ReviewerSessionDto,
} from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { deriveDraftStatus } from '../admin/drafts/derive-status.js';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReviewerSessionGuard, type ReviewerRequest } from './reviewer-session.guard.js';
import {
  REVIEWER_COOKIE_NAME,
  buildReviewerSetCookie,
  readCookie,
  signReviewerCookie,
  verifyReviewerCookie,
} from './session.js';

const CANONICAL_LOCALE: Locale = 'en';

@Controller('review')
export class ReviewController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
  ) {}

  // ── Auth ────────────────────────────────────────────────────────────────────

  /** Public status probe — tells the `/review` page which state to render
   *  (disabled vs login). Also exposes the catalogue of non-canonical locales
   *  so the UI doesn't need to hardcode the list. Never reveals the hash. */
  @Get('status')
  async status(): Promise<{
    enabled: boolean;
    passwordSet: boolean;
    locales: Locale[];
  }> {
    const { reviewerEnabled, reviewerPasswordHash } =
      await this.settings.readReviewerCredentials();
    return {
      enabled: reviewerEnabled,
      passwordSet: reviewerPasswordHash !== null,
      locales: NON_CANONICAL_LOCALES,
    };
  }

  @Post('auth')
  @HttpCode(204)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<void> {
    const parsed = ReviewerLoginBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_REVIEWER_LOGIN',
        message: parsed.error.message,
      });
    }

    const { reviewerEnabled, reviewerPasswordHash } =
      await this.settings.readReviewerCredentials();
    if (!reviewerEnabled || reviewerPasswordHash === null) {
      throw new UnauthorizedException({
        error: 'REVIEWER_DISABLED',
        message: 'Reviewer interface is disabled.',
      });
    }
    const ok = await bcrypt.compare(parsed.data.password, reviewerPasswordHash);
    if (!ok) {
      throw new UnauthorizedException({
        error: 'INVALID_REVIEWER_PASSWORD',
        message: 'Invalid password.',
      });
    }

    const secret = this.config.get('JWT_ACCESS_SECRET', { infer: true });
    const { token, maxAgeSeconds } = signReviewerCookie(this.jwt, secret, {
      label: parsed.data.label,
    });
    const appUrl = this.config.get('APP_URL', { infer: true });
    res.setHeader(
      'Set-Cookie',
      buildReviewerSetCookie({
        token,
        maxAgeSeconds,
        secure: appUrl.startsWith('https://'),
      }),
    );
  }

  @Post('auth/logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    const appUrl = this.config.get('APP_URL', { infer: true });
    res.setHeader(
      'Set-Cookie',
      buildReviewerSetCookie({
        token: null,
        maxAgeSeconds: 0,
        clear: true,
        secure: appUrl.startsWith('https://'),
      }),
    );
  }

  /** Probes whether the current cookie is still valid + matches an enabled
   *  reviewer toggle. The frontend uses this on `/review` page load to pick
   *  between login form vs queue. Returns null instead of 401 so the
   *  unauthenticated probe doesn't need to be a special case. */
  @Get('session')
  async session(@Req() req: Request): Promise<{ session: ReviewerSessionDto | null }> {
    const { reviewerEnabled, reviewerPasswordHash } =
      await this.settings.readReviewerCredentials();
    if (!reviewerEnabled || reviewerPasswordHash === null) {
      return { session: null };
    }
    const cookieHeader = req.headers['cookie'];
    const token = readCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      REVIEWER_COOKIE_NAME,
    );
    if (!token) return { session: null };
    const secret = this.config.get('JWT_ACCESS_SECRET', { infer: true });
    const parsedSession = verifyReviewerCookie(this.jwt, secret, token);
    return { session: parsedSession };
  }

  // ── Recipe drafts (guarded) ────────────────────────────────────────────────

  @Get('drafts/recipes')
  @UseGuards(ReviewerSessionGuard)
  async listRecipeSlices(
    @Req() req: ReviewerRequest,
    @Query('locale') localeRaw: string | undefined,
    @Query('includeReviewed') includeReviewedRaw: string | undefined,
    @Query('page') pageRaw: string | undefined,
    @Query('pageSize') pageSizeRaw: string | undefined,
  ): Promise<{ items: RecipeReviewSlice[]; total: number; page: number; pageSize: number }> {
    requireReviewer(req);
    const locale = parseTargetLocale(localeRaw);
    const page = Math.max(1, Number.parseInt(pageRaw ?? '1', 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(pageSizeRaw ?? '25', 10) || 25),
    );
    const includeReviewed = includeReviewedRaw === 'true';

    const where = {
      status: { in: ['PENDING', 'APPROVED'] as ('PENDING' | 'APPROVED')[] },
      locales: { has: locale },
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

    const filtered = includeReviewed
      ? items
      : items.filter(
          (row) =>
            !row.localeReviews.some(
              (r) => r.locale === locale && r.action === 'APPROVE',
            ),
        );

    return {
      items: filtered.map((row) => toRecipeReviewSlice(row, locale)),
      total,
      page,
      pageSize,
    };
  }

  @Get('drafts/recipes/:id')
  @UseGuards(ReviewerSessionGuard)
  async getRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
  ): Promise<RecipeReviewSlice> {
    requireReviewer(req);
    const locale = parseTargetLocale(localeRaw);
    const row = await this.prisma.recipeDraft.findUnique({
      where: { id },
      include: { localeReviews: true },
    });
    if (!row) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
    if (!row.locales.includes(locale)) {
      throw new BadRequestException({
        error: 'LOCALE_NOT_IN_DRAFT',
        message: `Draft was not generated for locale "${locale}".`,
      });
    }
    return toRecipeReviewSlice(row, locale);
  }

  @Patch('drafts/recipes/:id')
  @UseGuards(ReviewerSessionGuard)
  async patchRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<RecipeReviewSlice> {
    requireReviewer(req);
    const locale = parseTargetLocale(localeRaw);
    const parsed = RecipeReviewPatchBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_REVIEW_PATCH',
        message: parsed.error.message,
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.recipeDraft.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
      if (existing.status === 'SHIPPED') {
        throw new ConflictException({
          error: 'DRAFT_SHIPPED',
          message: 'Shipped drafts cannot be edited.',
        });
      }
      if (!existing.locales.includes(locale)) {
        throw new BadRequestException({
          error: 'LOCALE_NOT_IN_DRAFT',
          message: `Draft was not generated for locale "${locale}".`,
        });
      }

      const data: {
        titles?: Record<string, string>;
        descriptions?: Record<string, string>;
        steps?: Record<string, string[]>;
      } = {};
      if (parsed.data.title !== undefined) {
        const titles = parseLocaleMap(existing.titles);
        titles[locale] = parsed.data.title;
        data.titles = titles;
      }
      if (parsed.data.description !== undefined) {
        const descriptions = parseLocaleMap(existing.descriptions);
        descriptions[locale] = parsed.data.description;
        data.descriptions = descriptions;
      }
      if (parsed.data.steps !== undefined) {
        const steps = parseLocaleStringsMap(existing.steps);
        steps[locale] = parsed.data.steps;
        data.steps = steps;
      }

      // §3 invariant — any edit invalidates partial reviews.
      await tx.recipeDraftLocaleReview.deleteMany({ where: { draftId: id } });
      return tx.recipeDraft.update({
        where: { id },
        data: { ...data, status: 'PENDING' as const },
        include: { localeReviews: true },
      });
    });
    return toRecipeReviewSlice(updated, locale);
  }

  @Post('drafts/recipes/:id/approve')
  @UseGuards(ReviewerSessionGuard)
  approveRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<RecipeReviewSlice> {
    return this.recordRecipeReview(req, id, localeRaw, body, 'APPROVE');
  }

  @Post('drafts/recipes/:id/reject')
  @UseGuards(ReviewerSessionGuard)
  rejectRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<RecipeReviewSlice> {
    return this.recordRecipeReview(req, id, localeRaw, body, 'REJECT');
  }

  private async recordRecipeReview(
    req: ReviewerRequest,
    id: string,
    localeRaw: string | undefined,
    body: unknown,
    action: 'APPROVE' | 'REJECT',
  ): Promise<RecipeReviewSlice> {
    const reviewer = requireReviewer(req);
    const locale = parseTargetLocale(localeRaw);
    const parsed = ReviewerReasonBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_REVIEW',
        message: parsed.error.message,
      });
    }
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
          reviewedByLabel: reviewer.label,
          reason: parsed.data.reason ?? null,
        },
        update: {
          action,
          reviewedByLabel: reviewer.label,
          reason: parsed.data.reason ?? null,
          reviewedAt: new Date(),
        },
      });

      const reviews = await tx.recipeDraftLocaleReview.findMany({ where: { draftId: id } });
      const status = deriveDraftStatus(existing.locales, reviews);

      return tx.recipeDraft.update({
        where: { id },
        data: { status },
        include: { localeReviews: true },
      });
    });
    return toRecipeReviewSlice(updated, locale);
  }

  // ── Ingredient-name drafts (guarded) ───────────────────────────────────────

  @Get('drafts/ingredient-names')
  @UseGuards(ReviewerSessionGuard)
  async listIngredientNameSlices(
    @Req() req: ReviewerRequest,
    @Query('locale') localeRaw: string | undefined,
    @Query('includeReviewed') includeReviewedRaw: string | undefined,
    @Query('page') pageRaw: string | undefined,
    @Query('pageSize') pageSizeRaw: string | undefined,
  ): Promise<{
    items: IngredientNameReviewSlice[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    requireReviewer(req);
    const locale = parseTargetLocale(localeRaw);
    const page = Math.max(1, Number.parseInt(pageRaw ?? '1', 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(pageSizeRaw ?? '25', 10) || 25),
    );
    const includeReviewed = includeReviewedRaw === 'true';

    const where = {
      status: { in: ['PENDING', 'APPROVED'] as ('PENDING' | 'APPROVED')[] },
      locales: { has: locale },
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

    const filtered = includeReviewed
      ? items
      : items.filter(
          (row) =>
            !row.localeReviews.some(
              (r) => r.locale === locale && r.action === 'APPROVE',
            ),
        );

    return {
      items: filtered.map((row) => toIngredientNameReviewSlice(row, locale)),
      total,
      page,
      pageSize,
    };
  }

  @Get('drafts/ingredient-names/:id')
  @UseGuards(ReviewerSessionGuard)
  async getIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
  ): Promise<IngredientNameReviewSlice> {
    requireReviewer(req);
    const locale = parseTargetLocale(localeRaw);
    const row = await this.prisma.ingredientNameDraft.findUnique({
      where: { id },
      include: { localeReviews: true },
    });
    if (!row) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
    if (!row.locales.includes(locale)) {
      throw new BadRequestException({
        error: 'LOCALE_NOT_IN_DRAFT',
        message: `Draft was not generated for locale "${locale}".`,
      });
    }
    return toIngredientNameReviewSlice(row, locale);
  }

  @Patch('drafts/ingredient-names/:id')
  @UseGuards(ReviewerSessionGuard)
  async patchIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<IngredientNameReviewSlice> {
    requireReviewer(req);
    const locale = parseTargetLocale(localeRaw);
    const parsed = IngredientNameReviewPatchBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_REVIEW_PATCH',
        message: parsed.error.message,
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.ingredientNameDraft.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
      if (existing.status === 'SHIPPED') {
        throw new ConflictException({
          error: 'DRAFT_SHIPPED',
          message: 'Shipped drafts cannot be edited.',
        });
      }
      if (!existing.locales.includes(locale)) {
        throw new BadRequestException({
          error: 'LOCALE_NOT_IN_DRAFT',
          message: `Draft was not generated for locale "${locale}".`,
        });
      }

      const suggestions = (existing.suggestions as {
        name: Record<string, string>;
        storageHint?: Record<string, string>;
      }) ?? { name: {} };
      const name = { ...(suggestions.name ?? {}) };
      const storageHint = { ...(suggestions.storageHint ?? {}) };
      if (parsed.data.name !== undefined) {
        name[locale] = parsed.data.name;
      }
      if (parsed.data.storageHint !== undefined) {
        if (parsed.data.storageHint.length === 0) {
          delete storageHint[locale];
        } else {
          storageHint[locale] = parsed.data.storageHint;
        }
      }
      const nextSuggestions: { name: Record<string, string>; storageHint?: Record<string, string> } = {
        name,
      };
      if (Object.keys(storageHint).length > 0) nextSuggestions.storageHint = storageHint;

      await tx.ingredientNameDraftLocaleReview.deleteMany({ where: { draftId: id } });
      return tx.ingredientNameDraft.update({
        where: { id },
        data: { suggestions: nextSuggestions, status: 'PENDING' },
        include: { localeReviews: true },
      });
    });
    return toIngredientNameReviewSlice(updated, locale);
  }

  @Post('drafts/ingredient-names/:id/approve')
  @UseGuards(ReviewerSessionGuard)
  approveIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<IngredientNameReviewSlice> {
    return this.recordIngredientNameReview(req, id, localeRaw, body, 'APPROVE');
  }

  @Post('drafts/ingredient-names/:id/reject')
  @UseGuards(ReviewerSessionGuard)
  rejectIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<IngredientNameReviewSlice> {
    return this.recordIngredientNameReview(req, id, localeRaw, body, 'REJECT');
  }

  private async recordIngredientNameReview(
    req: ReviewerRequest,
    id: string,
    localeRaw: string | undefined,
    body: unknown,
    action: 'APPROVE' | 'REJECT',
  ): Promise<IngredientNameReviewSlice> {
    const reviewer = requireReviewer(req);
    const locale = parseTargetLocale(localeRaw);
    const parsed = ReviewerReasonBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_REVIEW',
        message: parsed.error.message,
      });
    }
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
          reviewedByLabel: reviewer.label,
          reason: parsed.data.reason ?? null,
        },
        update: {
          action,
          reviewedByLabel: reviewer.label,
          reason: parsed.data.reason ?? null,
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
    return toIngredientNameReviewSlice(updated, locale);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function requireReviewer(req: ReviewerRequest): { label: string } {
  if (!req.reviewer) {
    // Guard should have set this; defensive only.
    throw new UnauthorizedException({
      error: 'NO_REVIEWER_SESSION',
      message: 'No reviewer session present.',
    });
  }
  return { label: req.reviewer.label };
}

/** Validates the `?locale=` query argument: must be a supported Locale and
 *  must not be `en` (EN is the canonical authoring language). */
function parseTargetLocale(raw: string | undefined): Locale {
  const parsed = LocaleSchema.safeParse(raw);
  if (!parsed.success || parsed.data === CANONICAL_LOCALE) {
    throw new BadRequestException({
      error: 'INVALID_LOCALE',
      message: `locale must be a non-canonical Locale (got "${raw ?? ''}").`,
    });
  }
  return parsed.data;
}

function parseLocaleMap(raw: unknown): Record<string, string> {
  if (raw && typeof raw === 'object') {
    return { ...(raw as Record<string, string>) };
  }
  return {};
}

function parseLocaleStringsMap(raw: unknown): Record<string, string[]> {
  if (raw && typeof raw === 'object') {
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.map(String);
    }
    return out;
  }
  return {};
}

interface RawRecipeDraftRow {
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
  batchId: string;
  modelUsed: string | null;
  localeReviews: { locale: string; action: string }[];
}

function toRecipeReviewSlice(
  row: RawRecipeDraftRow,
  locale: Locale,
): RecipeReviewSlice {
  const titles = parseLocaleMap(row.titles);
  const descriptions = parseLocaleMap(row.descriptions);
  const steps = parseLocaleStringsMap(row.steps);
  const reviewed = row.localeReviews.find((r) => r.locale === locale);
  return {
    id: row.id,
    slug: row.slug,
    locale,
    title: titles[locale] ?? '',
    titleSource: titles[CANONICAL_LOCALE] ?? '',
    description: descriptions[locale] ?? '',
    descriptionSource: descriptions[CANONICAL_LOCALE] ?? '',
    steps: steps[locale] ?? [],
    stepsSource: steps[CANONICAL_LOCALE] ?? [],
    servings: row.servings,
    mealTypes: row.mealTypes as RecipeReviewSlice['mealTypes'],
    dietTags: row.dietTags as RecipeReviewSlice['dietTags'],
    prepMinutes: row.prepMinutes,
    cookMinutes: row.cookMinutes,
    difficulty: row.difficulty,
    complexity: row.complexity as RecipeReviewSlice['complexity'],
    caloriesPerServing: row.caloriesPerServing,
    proteinPerServing: row.proteinPerServing,
    fatPerServing: row.fatPerServing,
    carbsPerServing: row.carbsPerServing,
    allergens: row.allergens,
    ingredients: row.ingredientsJson as RecipeReviewSlice['ingredients'],
    batchId: row.batchId,
    modelUsed: row.modelUsed,
    status: row.status,
    alreadyReviewed: reviewed !== undefined,
    alreadyReviewedAction:
      reviewed && (reviewed.action === 'APPROVE' || reviewed.action === 'REJECT')
        ? reviewed.action
        : null,
  };
}

interface RawIngredientNameDraftRow {
  id: string;
  ingredientSlug: string;
  rawDescription: string;
  suggestions: unknown;
  locales: string[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';
  batchId: string;
  modelUsed: string | null;
  localeReviews: { locale: string; action: string }[];
}

function toIngredientNameReviewSlice(
  row: RawIngredientNameDraftRow,
  locale: Locale,
): IngredientNameReviewSlice {
  const suggestions = (row.suggestions ?? {}) as {
    name?: Record<string, string>;
    storageHint?: Record<string, string>;
  };
  const reviewed = row.localeReviews.find((r) => r.locale === locale);
  return {
    id: row.id,
    ingredientSlug: row.ingredientSlug,
    rawDescription: row.rawDescription,
    locale,
    name: suggestions.name?.[locale] ?? '',
    nameSource: suggestions.name?.[CANONICAL_LOCALE] ?? '',
    storageHint: suggestions.storageHint?.[locale] ?? null,
    storageHintSource: suggestions.storageHint?.[CANONICAL_LOCALE] ?? null,
    batchId: row.batchId,
    modelUsed: row.modelUsed,
    status: row.status,
    alreadyReviewed: reviewed !== undefined,
    alreadyReviewedAction:
      reviewed && (reviewed.action === 'APPROVE' || reviewed.action === 'REJECT')
        ? reviewed.action
        : null,
  };
}
