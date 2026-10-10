// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { recipesPerDietAndMeal, type CoverageMatrix } from '../engine/coverage.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** How long a count is handed out again before the recipes are read anew. */
const KEPT_FOR_MS = 60_000;

/**
 * What the shared catalogue can serve right now: the recipes any user's plan
 * may draw on, counted per diet and meal. What a user made for themselves and
 * what an update retired are left out.
 */
@Injectable()
export class CatalogueCoverageService {
  private kept: { at: number; matrix: CoverageMatrix } | null = null;
  private counting: Promise<CoverageMatrix> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Counted now, and kept for those who ask next. */
  async count(): Promise<CoverageMatrix> {
    const recipes = await this.prisma.recipe.findMany({
      where: { createdByUserId: null, retiredAt: null, deletedAt: null },
      select: { dietTags: true, mealTypes: true },
    });
    const matrix = recipesPerDietAndMeal(recipes);
    this.kept = { at: Date.now(), matrix };
    return matrix;
  }

  /**
   * As counted within the last minute. For the public configuration, which
   * every page asks for before anybody has signed in: however often it is
   * asked, the recipes are read once a minute, and once for all who ask at the
   * same moment.
   */
  recent(): Promise<CoverageMatrix> {
    if (this.kept && Date.now() - this.kept.at < KEPT_FOR_MS) return Promise.resolve(this.kept.matrix);
    this.counting ??= this.count().finally(() => {
      this.counting = null;
    });
    return this.counting;
  }
}
