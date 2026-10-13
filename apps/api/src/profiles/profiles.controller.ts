// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { CalorieCalculation, CaloriePreview, CaloriePreviewRequest, Profile, ProfileInput, ProfilePreferencesPatch, ProfileUpdate } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ProfilesService } from './profiles.service.js';

@Controller('profiles')
@UseGuards(JwtAuthGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  /** The profiles of the account. */
  @Get()
  @AnswersListOf(Profile)
  list(@CurrentUser() user: RequestUser) {
    return this.profiles.list(user.id);
  }

  /** One profile. */
  @Get(':id')
  @Answers(Profile)
  get(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    return this.profiles.get(user.id, id);
  }

  /** What the profile's figures come to: its calorie target and how it is worked out, and the protein, fat and carbohydrate of it. */
  @Get(':id/calories')
  @Answers(CalorieCalculation)
  calories(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    return this.profiles.calories(user.id, id);
  }

  /**
   * The calorie target and macros that figures somebody typed would come to,
   * and what each pace of loss would: for a form that shows them before there
   * is a profile. Nothing is kept.
   */
  @Post('calories')
  @HttpCode(200)
  @Answers(CaloriePreview)
  previewCalories(@Body(new ZodValidationPipe(CaloriePreviewRequest)) dto: CaloriePreviewRequest) {
    return this.profiles.previewCalories(dto);
  }

  /** Add a profile to the account. */
  @Post()
  @Answers(Profile)
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(ProfileInput)) dto: ProfileInput,
  ) {
    return this.profiles.create(user.id, dto);
  }

  /** The profile as it is from now on: every part of it. A part that is left out is refused. */
  @Put(':id')
  @Answers(Profile)
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(ProfileUpdate)) dto: ProfileUpdate,
  ) {
    return this.profiles.update(user.id, id, dto);
  }

  /** Change some of the profile's preferences: what is left out stays as it is. */
  @Patch(':id/preferences')
  @Answers(Profile)
  patchPreferences(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(ProfilePreferencesPatch)) dto: ProfilePreferencesPatch,
  ) {
    return this.profiles.patchPreferences(user.id, id, dto);
  }

  /** Delete a profile, with its plans, lists and pantry. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.profiles.remove(user.id, id);
  }
}
