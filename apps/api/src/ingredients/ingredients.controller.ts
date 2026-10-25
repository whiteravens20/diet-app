// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Ingredient, IngredientListQuery, type Locale } from '@diet-app/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { AnswersListOf } from '../common/answers.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { IngredientsService } from './ingredients.service.js';

@Controller('ingredients')
@UseGuards(JwtAuthGuard)
export class IngredientsController {
  constructor(private readonly ingredients: IngredientsService) {}

  /**
   * Search the curated ingredient database. `?ids=` resolves a specific
   * list (used by the profile page to render saved favourite/avoid entries
   * by name); `?search=` does a case-insensitive name match.
   */
  @Get()
  @AnswersListOf(Ingredient)
  list(
    @RequestLocale() locale: Locale,
    @Query(new ZodValidationPipe(IngredientListQuery)) query: IngredientListQuery,
  ) {
    if (query.ids) return this.ingredients.getMany(locale, query.ids);
    return this.ingredients.search(locale, query.search);
  }
}
