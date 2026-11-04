// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** What the swap of a meal and the swap of an ingredient have in common. */
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Locale } from '@diet-app/shared';
import { isoDate, isSkipped } from './plan-days.js';

/** How many candidates an AI swap puts before the model. */
export const AI_SWAP_POOL = 25;

/** The longest explanation of a pick that is passed on to the user. */
export const MAX_REASON_CHARS = 200;

/** The language a model is asked to write in, by locale. */
export const LANGUAGE: Record<Locale, string> = { en: 'English', pl: 'Polish' };

/**
 * The recipe a swap or a substitution would replace. A custom meal has none
 * and cannot be swapped; a meal that was eaten is a record of what was eaten,
 * and so is the rest of a day that has passed. A day the user skips is not
 * eaten, so there is nothing on it to change a dish for.
 */
export function swappableRecipeOf(
  meal: {
    recipeId: string | null;
    source: string;
    eatenAt: Date | null;
    day: { date: Date; overrides: unknown };
  },
  today: string,
): string {
  if (!meal.recipeId || meal.source === 'USER_CUSTOM') {
    throw new BadRequestException({
      error: 'CUSTOM_MEAL_NOT_SWAPPABLE',
      message: 'Custom meals cannot be swapped or substituted.',
    });
  }
  if (meal.eatenAt) {
    throw new ConflictException({
      error: 'MEAL_EATEN',
      message: 'A meal that was eaten cannot be changed. Unmark it first.',
    });
  }
  // Dates in this form compare as text.
  if (isoDate(meal.day.date) < today) {
    throw new ConflictException({
      error: 'DAY_IN_THE_PAST',
      message: 'This day is over: its meals stay as they were.',
    });
  }
  if (isSkipped(meal.day)) {
    throw new ConflictException({
      error: 'DAY_SKIPPED',
      message: 'This day is skipped: there is no meal on it to change.',
    });
  }
  return meal.recipeId;
}
