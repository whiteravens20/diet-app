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
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
  IngredientNameReviewSlice,
  IngredientNameReviewSlicePage,
  NON_CANONICAL_LOCALES,
  RecipeReviewPatchBody,
  RecipeReviewSlice,
  RecipeReviewSlicePage,
  ReviewerLoginBody,
  ReviewerReasonBody,
  ReviewerSessionAnswer,
  ReviewQueueQuery,
  ReviewStatus,
  TargetLocaleQuery,
  type ReviewAction,
  type TargetLocale,
} from '@diet-app/shared';
import { DraftService, type Actor } from '../admin/drafts/draft.service.js';
import { toIngredientNameReviewSlice, toRecipeReviewSlice } from '../admin/drafts/drafts.mapper.js';
import { Answers } from '../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { assertFromTheApplication } from '../auth/session-cookies.js';
import { Passwords } from '../common/passwords.js';
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
    private readonly passwords: Passwords,
  ) {}

  // ── Auth ────────────────────────────────────────────────────────────────────

  /**
   * Whether reviewers may sign in on this instance, and the languages there
   * are to review. Anyone may ask; the password is no part of the answer.
   */
  @Get('status')
  @Answers(ReviewStatus)
  async status(): Promise<ReviewStatus> {
    const { reviewerEnabled, reviewerPasswordHash } =
      await this.settings.readReviewerCredentials();
    return {
      enabled: reviewerEnabled,
      passwordSet: reviewerPasswordHash !== null,
      locales: NON_CANONICAL_LOCALES,
    };
  }

  /** Sign a reviewer in with the reviewers' password and the name they review under. The session is a cookie. */
  // One password for every reviewer, so there is no account to count attempts
  // against: five a minute per client, and wrong ones are slowed down by the
  // sign-in gate.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('auth')
  @HttpCode(204)
  async login(@Body(new ZodValidationPipe(ReviewerLoginBody)) body: ReviewerLoginBody, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const appUrl = this.config.get('APP_URL', { infer: true });
    // A page of another site cannot sign a visitor in to a session of its choosing.
    assertFromTheApplication(req.headers.origin, appUrl);
    const { reviewerEnabled, reviewerPasswordHash, reviewerSessionEpoch } = await this.settings.readReviewerCredentials();
    if (!reviewerEnabled || reviewerPasswordHash === null) {
      throw new UnauthorizedException({
        error: 'REVIEWER_DISABLED',
        message: 'Reviewer interface is disabled.',
      });
    }
    const client = req.ip ?? 'unknown';
    this.gate.assertOpen('reviewer', client, res);
    const ok = await this.passwords.matches(body.password, reviewerPasswordHash);
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
      label: body.label,
      epoch: reviewerSessionEpoch,
    });
    res.setHeader(
      'Set-Cookie',
      buildReviewerSetCookie({
        token,
        maxAgeSeconds,
        secure: appUrl.startsWith('https://'),
      }),
    );
  }

  /** End the reviewer's session. */
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

  /**
   * The reviewer's session, or none: what the page asks first, to show the
   * queue or the form to sign in. Answers 200 either way.
   */
  @Get('session')
  @Answers(ReviewerSessionAnswer)
  async session(@Req() req: Request): Promise<ReviewerSessionAnswer> {
    const { reviewerEnabled, reviewerPasswordHash, reviewerSessionEpoch } = await this.settings.readReviewerCredentials();
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
    const parsedSession = verifyReviewerCookie(this.jwt, secret, token, reviewerSessionEpoch);
    return { session: parsedSession };
  }

  // ── Recipe drafts (guarded) ────────────────────────────────────────────────

  /** The recipe drafts that wait for a review in a language, a page at a time. */
  @Get('drafts/recipes')
  @UseGuards(ReviewerSessionGuard)
  @Answers(RecipeReviewSlicePage)
  async listRecipeSlices(@Query(new ZodValidationPipe(ReviewQueueQuery)) query: ReviewQueueQuery): Promise<RecipeReviewSlicePage> {
    const found = await this.drafts.recipesWaitingFor(query);
    return { ...found, items: found.items.map((row) => toRecipeReviewSlice(row, query.locale)) };
  }

  /** One of those drafts: the text in the language beside the English. */
  @Get('drafts/recipes/:id')
  @UseGuards(ReviewerSessionGuard)
  @Answers(RecipeReviewSlice)
  async getRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
  ): Promise<RecipeReviewSlice> {
    return toRecipeReviewSlice(await this.drafts.recipeFor(id, locale, reviewerOf(req)), locale);
  }

  /** Change the text of a recipe draft in the language. */
  @Patch('drafts/recipes/:id')
  @UseGuards(ReviewerSessionGuard)
  @Answers(RecipeReviewSlice)
  async patchRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
    @Body(new ZodValidationPipe(RecipeReviewPatchBody)) patch: RecipeReviewPatchBody,
  ): Promise<RecipeReviewSlice> {
    return toRecipeReviewSlice(await this.drafts.editRecipeText(id, locale, patch, reviewerOf(req)), locale);
  }

  /** Approve a recipe draft in the language. */
  @Post('drafts/recipes/:id/approve')
  @UseGuards(ReviewerSessionGuard)
  @Answers(RecipeReviewSlice)
  approveRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
    @Body(new ZodValidationPipe(ReviewerReasonBody.prefault({}))) body: ReviewerReasonBody,
  ): Promise<RecipeReviewSlice> {
    return this.reviewRecipe(req, id, locale, body, 'APPROVE');
  }

  /** Reject a recipe draft in the language, with a reason. */
  @Post('drafts/recipes/:id/reject')
  @UseGuards(ReviewerSessionGuard)
  @Answers(RecipeReviewSlice)
  rejectRecipeSlice(
    @Req() req: ReviewerRequest,
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
    @Body(new ZodValidationPipe(ReviewerReasonBody.prefault({}))) body: ReviewerReasonBody,
  ): Promise<RecipeReviewSlice> {
    return this.reviewRecipe(req, id, locale, body, 'REJECT');
  }

  private async reviewRecipe(req: ReviewerRequest, id: string, locale: TargetLocale, { reason }: ReviewerReasonBody, action: ReviewAction): Promise<RecipeReviewSlice> {
    return toRecipeReviewSlice(await this.drafts.reviewRecipe(id, { locale, action, reason }, reviewerOf(req)), locale);
  }

  // ── Ingredient-name drafts (guarded) ───────────────────────────────────────

  /** The names of ingredients that wait for a review in a language, a page at a time. */
  @Get('drafts/ingredient-names')
  @UseGuards(ReviewerSessionGuard)
  @Answers(IngredientNameReviewSlicePage)
  async listIngredientNameSlices(@Query(new ZodValidationPipe(ReviewQueueQuery)) query: ReviewQueueQuery): Promise<IngredientNameReviewSlicePage> {
    const found = await this.drafts.ingredientNamesWaitingFor(query);
    return { ...found, items: found.items.map((row) => toIngredientNameReviewSlice(row, query.locale)) };
  }

  /** One of those names: the text in the language beside the English. */
  @Get('drafts/ingredient-names/:id')
  @UseGuards(ReviewerSessionGuard)
  @Answers(IngredientNameReviewSlice)
  async getIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
  ): Promise<IngredientNameReviewSlice> {
    return toIngredientNameReviewSlice(await this.drafts.ingredientNameFor(id, locale, reviewerOf(req)), locale);
  }

  /** Change the text of a name in the language. */
  @Patch('drafts/ingredient-names/:id')
  @UseGuards(ReviewerSessionGuard)
  @Answers(IngredientNameReviewSlice)
  async patchIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
    @Body(new ZodValidationPipe(IngredientNameReviewPatchBody)) patch: IngredientNameReviewPatchBody,
  ): Promise<IngredientNameReviewSlice> {
    return toIngredientNameReviewSlice(await this.drafts.editIngredientNameText(id, locale, patch, reviewerOf(req)), locale);
  }

  /** Approve a name in the language. */
  @Post('drafts/ingredient-names/:id/approve')
  @UseGuards(ReviewerSessionGuard)
  @Answers(IngredientNameReviewSlice)
  approveIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
    @Body(new ZodValidationPipe(ReviewerReasonBody.prefault({}))) body: ReviewerReasonBody,
  ): Promise<IngredientNameReviewSlice> {
    return this.reviewIngredientName(req, id, locale, body, 'APPROVE');
  }

  /** Reject a name in the language, with a reason. */
  @Post('drafts/ingredient-names/:id/reject')
  @UseGuards(ReviewerSessionGuard)
  @Answers(IngredientNameReviewSlice)
  rejectIngredientNameSlice(
    @Req() req: ReviewerRequest,
    @Param('id', requiredUuid) id: string,
    @Query(new ZodValidationPipe(TargetLocaleQuery)) { locale }: TargetLocaleQuery,
    @Body(new ZodValidationPipe(ReviewerReasonBody.prefault({}))) body: ReviewerReasonBody,
  ): Promise<IngredientNameReviewSlice> {
    return this.reviewIngredientName(req, id, locale, body, 'REJECT');
  }

  private async reviewIngredientName(
    req: ReviewerRequest,
    id: string,
    locale: TargetLocale,
    { reason }: ReviewerReasonBody,
    action: ReviewAction,
  ): Promise<IngredientNameReviewSlice> {
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
