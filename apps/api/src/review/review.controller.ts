// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Reviewer-facing API.
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
 * What a reviewer may read, edit and review, and what an edit does to the
 * reviews a draft had, is decided in `DraftService`, the same for these routes
 * as for the administrator's.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
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
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  IngredientNameReviewPatchBody,
  NON_CANONICAL_LOCALES,
  RecipeReviewPatchBody,
  ReviewQueueQuery,
  ReviewerLoginBody,
  ReviewerReasonBody,
  TargetLocale,
  type IngredientNameReviewSlice,
  type Locale,
  type RecipeReviewSlice,
  type ReviewAction,
  type ReviewerSessionDto,
} from '@diet-app/shared';
import type { z } from 'zod';
import { DraftService, type Actor, type Page } from '../admin/drafts/draft.service.js';
import { toIngredientNameReviewSlice, toRecipeReviewSlice } from '../admin/drafts/drafts.mapper.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { verifyPassword } from '../common/password-hash.js';
import { readCookie } from '../common/cookies.js';
import type { Env } from '../config/env.js';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';
import { SignInGate } from '../rate-limit/sign-in-gate.js';
import { ReviewerSessionGuard, type ReviewerRequest } from './reviewer-session.guard.js';
import {
  REVIEWER_COOKIE_NAME,
  buildReviewerSetCookie,
  resolveReviewerSecret,
  signReviewerCookie,
  verifyReviewerCookie,
} from './session.js';

@Controller('review')
export class ReviewController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    private readonly settings: InstanceSettingsService,
    private readonly gate: SignInGate,
    private readonly drafts: DraftService,
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

  // One password for every reviewer, so there is no account to count attempts
  // against: five a minute per client, and wrong ones are slowed down by the
  // sign-in gate.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('auth')
  @HttpCode(204)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
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
    const client = req.ip ?? 'unknown';
    this.gate.assertOpen('reviewer', client, res);
    const ok = await verifyPassword(parsed.data.password, reviewerPasswordHash);
    if (!ok) {
      this.gate.failed('reviewer', client);
      throw new UnauthorizedException({
        error: 'INVALID_REVIEWER_PASSWORD',
        message: 'Invalid password.',
      });
    }
    this.gate.succeeded('reviewer', client);

    const secret = resolveReviewerSecret(this.config);
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
    const secret = resolveReviewerSecret(this.config);
    const parsedSession = verifyReviewerCookie(this.jwt, secret, token);
    return { session: parsedSession };
  }

  // ── Recipe drafts (guarded) ────────────────────────────────────────────────

  @Get('drafts/recipes')
  @UseGuards(ReviewerSessionGuard)
  async listRecipeSlices(@Query(new ZodValidationPipe(ReviewQueueQuery)) query: ReviewQueueQuery): Promise<Page<RecipeReviewSlice>> {
    const found = await this.drafts.recipesWaitingFor(query);
    return { ...found, items: found.items.map((row) => toRecipeReviewSlice(row, query.locale)) };
  }

  @Get('drafts/recipes/:id')
  @UseGuards(ReviewerSessionGuard)
  async getRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
  ): Promise<RecipeReviewSlice> {
    const locale = parseTargetLocale(localeRaw);
    return toRecipeReviewSlice(await this.drafts.recipeFor(id, locale, reviewerOf(req)), locale);
  }

  @Patch('drafts/recipes/:id')
  @UseGuards(ReviewerSessionGuard)
  async patchRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<RecipeReviewSlice> {
    const locale = parseTargetLocale(localeRaw);
    const patch = bodyOf(RecipeReviewPatchBody, body, 'INVALID_REVIEW_PATCH');
    return toRecipeReviewSlice(await this.drafts.editRecipeText(id, locale, patch, reviewerOf(req)), locale);
  }

  @Post('drafts/recipes/:id/approve')
  @UseGuards(ReviewerSessionGuard)
  approveRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<RecipeReviewSlice> {
    return this.reviewRecipe(req, id, localeRaw, body, 'APPROVE');
  }

  @Post('drafts/recipes/:id/reject')
  @UseGuards(ReviewerSessionGuard)
  rejectRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<RecipeReviewSlice> {
    return this.reviewRecipe(req, id, localeRaw, body, 'REJECT');
  }

  private async reviewRecipe(req: ReviewerRequest, id: string, localeRaw: string | undefined, body: unknown, action: ReviewAction): Promise<RecipeReviewSlice> {
    const locale = parseTargetLocale(localeRaw);
    const { reason } = bodyOf(ReviewerReasonBody, body ?? {}, 'INVALID_REVIEW');
    return toRecipeReviewSlice(await this.drafts.reviewRecipe(id, { locale, action, reason }, reviewerOf(req)), locale);
  }

  // ── Ingredient-name drafts (guarded) ───────────────────────────────────────

  @Get('drafts/ingredient-names')
  @UseGuards(ReviewerSessionGuard)
  async listIngredientNameSlices(@Query(new ZodValidationPipe(ReviewQueueQuery)) query: ReviewQueueQuery): Promise<Page<IngredientNameReviewSlice>> {
    const found = await this.drafts.ingredientNamesWaitingFor(query);
    return { ...found, items: found.items.map((row) => toIngredientNameReviewSlice(row, query.locale)) };
  }

  @Get('drafts/ingredient-names/:id')
  @UseGuards(ReviewerSessionGuard)
  async getIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
  ): Promise<IngredientNameReviewSlice> {
    const locale = parseTargetLocale(localeRaw);
    return toIngredientNameReviewSlice(await this.drafts.ingredientNameFor(id, locale, reviewerOf(req)), locale);
  }

  @Patch('drafts/ingredient-names/:id')
  @UseGuards(ReviewerSessionGuard)
  async patchIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<IngredientNameReviewSlice> {
    const locale = parseTargetLocale(localeRaw);
    const patch = bodyOf(IngredientNameReviewPatchBody, body, 'INVALID_REVIEW_PATCH');
    return toIngredientNameReviewSlice(await this.drafts.editIngredientNameText(id, locale, patch, reviewerOf(req)), locale);
  }

  @Post('drafts/ingredient-names/:id/approve')
  @UseGuards(ReviewerSessionGuard)
  approveIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<IngredientNameReviewSlice> {
    return this.reviewIngredientName(req, id, localeRaw, body, 'APPROVE');
  }

  @Post('drafts/ingredient-names/:id/reject')
  @UseGuards(ReviewerSessionGuard)
  rejectIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('locale') localeRaw: string | undefined,
    @Body() body: unknown,
  ): Promise<IngredientNameReviewSlice> {
    return this.reviewIngredientName(req, id, localeRaw, body, 'REJECT');
  }

  private async reviewIngredientName(
    req: ReviewerRequest,
    id: string,
    localeRaw: string | undefined,
    body: unknown,
    action: ReviewAction,
  ): Promise<IngredientNameReviewSlice> {
    const locale = parseTargetLocale(localeRaw);
    const { reason } = bodyOf(ReviewerReasonBody, body ?? {}, 'INVALID_REVIEW');
    return toIngredientNameReviewSlice(await this.drafts.reviewIngredientName(id, { locale, action, reason }, reviewerOf(req)), locale);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** The reviewer the guard let in, as the one who acts on a draft. */
function reviewerOf(req: ReviewerRequest): Actor {
  if (!req.reviewer) {
    // Guard should have set this; defensive only.
    throw new UnauthorizedException({
      error: 'NO_REVIEWER_SESSION',
      message: 'No reviewer session present.',
    });
  }
  return { role: 'REVIEWER', label: req.reviewer.label };
}

/** `body` checked against `schema`, or a 400 under the code this route has always answered with. */
function bodyOf<T>(schema: z.ZodType<T>, body: unknown, code: string): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException({ error: code, message: result.error.message });
  return result.data;
}

/** Validates the `?locale=` query argument: must be a supported Locale and
 *  must not be `en` (EN is the canonical authoring language). */
function parseTargetLocale(raw: string | undefined): TargetLocale {
  const parsed = TargetLocale.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException({
      error: 'INVALID_LOCALE',
      message: `locale must be a non-canonical Locale (got "${raw ?? ''}").`,
    });
  }
  return parsed.data;
}
