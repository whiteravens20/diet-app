// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type Difficulty, type Unit } from '@prisma/client';
import { computeFingerprint } from '../admin/drafts/fingerprint.js';
import type { RecipeFacts } from '../engine/recipe-facts.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** The most recipes of their own one account may hold at a time. */
export const MAX_PERSONAL_RECIPES = 200;

/** The most recipes a model may write for one account within 24 hours. */
export const MAX_AI_DRAFTS_PER_DAY = 20;

/** The batch every draft made from personal recipes belongs to: it says nothing about who or when. */
const QUEUE_BATCH = 'personal-recipes';

/** The text of a recipe in one language. */
export interface RecipeText {
  title: string;
  description: string;
  steps: string[];
}

/** A recipe one user made for themselves: an ingredient swap, or a draft a model wrote. */
export interface PersonalRecipe {
  userId: string;
  origin: 'user' | 'ai';
  /** The text by locale; `en` is required and is what the recipe row itself carries. */
  text: ReadonlyMap<string, RecipeText>;
  servings: number;
  mealTypes: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: Difficulty;
  reuseScore?: number;
  ingredients: { ingredientId: string; quantity: number; unit: Unit; note: string | null }[];
  /** Worked out by the engine from the ingredients above. */
  facts: RecipeFacts;
}

/** Hold, until the transaction ends, the lock named `key`. */
const lock = (tx: Prisma.TransactionClient, key: string): Promise<number> =>
  tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

/**
 * Stores the recipes that belong to one user, and decides when one of them is
 * really a recipe that already exists.
 *
 * A recipe is identified by its fingerprint (see `computeFingerprint`), which
 * is unique per owner: two users may each have the same recipe. Saving one
 * goes through these steps:
 *
 *  1. the shared library already has it: that recipe is used, nothing is written;
 *  2. the user already has it: theirs is used, and brought back if they had deleted it;
 *  3. otherwise it is written as theirs, if the account has room for it.
 *
 * Two locks make this exact. The saves of one account take turns, so two of
 * them cannot both take the last place the account has; then the saves of one
 * recipe take turns, so two requests for it cannot both write it.
 *
 * A personal recipe reaches the curation queue in one way only: a second user
 * comes to own the same recipe, which is the sign that it may be worth sharing.
 */
@Injectable()
export class PersonalRecipesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Save `recipe` for its user and return the id of the recipe to use.
   *
   * `avoid` names shared recipes the caller must not be handed: one the
   * profile marked to be avoided stays out of its plans even when the user
   * builds the same dish by hand. They get a recipe of their own instead.
   */
  async save(recipe: PersonalRecipe, avoid: readonly string[] = []): Promise<string> {
    const fingerprint = await this.fingerprintOf(recipe);
    return this.prisma.$transaction(async (tx) => {
      await lock(tx, `personal-recipes:${recipe.userId}`);
      if (fingerprint === null) {
        // An ingredient without a slug cannot be named across instances, so
        // there is nothing to recognise the recipe by: it is simply written.
        await this.assertRoom(tx, recipe.userId, recipe.origin);
        return this.write(tx, recipe, null);
      }
      await lock(tx, fingerprint);

      const shared = await tx.recipe.findFirst({
        where: { fingerprint, createdByUserId: null, deletedAt: null, retiredAt: null, id: { notIn: [...avoid] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (shared) return shared.id;

      const own = await tx.recipe.findFirst({
        where: { fingerprint, createdByUserId: recipe.userId },
        select: { id: true, deletedAt: true },
      });
      if (own) {
        if (own.deletedAt) {
          // Brought back, it takes a place again.
          await this.assertRoom(tx, recipe.userId, 'user');
          await tx.recipe.update({ where: { id: own.id }, data: { deletedAt: null } });
        }
        return own.id;
      }

      await this.assertRoom(tx, recipe.userId, recipe.origin);
      const id = await this.write(tx, recipe, fingerprint);

      // A second owner is the sign that the recipe may be worth sharing. One
      // who deleted theirs is no owner any more.
      const others = await tx.recipe.findMany({
        where: { fingerprint, createdByUserId: { not: null }, NOT: { createdByUserId: recipe.userId }, deletedAt: null },
        select: { id: true },
      });
      if (others.length > 0) await this.mirror(tx, id, fingerprint, [id, ...others.map((other) => other.id)]);
      return id;
    });
  }

  /**
   * Refuse now what `save` would refuse later for a recipe of this origin.
   * Asked before a model is put to work on a draft there is no room for.
   */
  async assertRoomFor(userId: string, origin: PersonalRecipe['origin']): Promise<void> {
    await this.assertRoom(this.prisma, userId, origin);
  }

  /** The fingerprint of a recipe, or null when one of its ingredients has no slug. */
  private async fingerprintOf(recipe: PersonalRecipe): Promise<string | null> {
    const rows = await this.prisma.ingredient.findMany({
      where: { id: { in: recipe.ingredients.map((line) => line.ingredientId) } },
      select: { id: true, slug: true },
    });
    const slugById = new Map(rows.map((row) => [row.id, row.slug]));
    const lines: { slug: string; quantity: number; unit: Unit }[] = [];
    for (const line of recipe.ingredients) {
      const slug = slugById.get(line.ingredientId);
      if (!slug) return null;
      lines.push({ slug, quantity: line.quantity, unit: line.unit });
    }
    return computeFingerprint({ ingredients: lines, mealTypes: recipe.mealTypes, servings: recipe.servings });
  }

  private async assertRoom(
    db: Pick<Prisma.TransactionClient, 'recipe'>,
    userId: string,
    origin: PersonalRecipe['origin'],
  ): Promise<void> {
    const held = await db.recipe.count({ where: { createdByUserId: userId, deletedAt: null } });
    if (held >= MAX_PERSONAL_RECIPES) {
      throw new ForbiddenException({
        error: 'PERSONAL_RECIPE_LIMIT',
        message: `An account holds at most ${MAX_PERSONAL_RECIPES} recipes of its own. Delete some you no longer use.`,
      });
    }
    if (origin !== 'ai') return;
    // Deleted drafts count too: deleting one does not hand the place back
    // within the day, or the limit would bound nothing.
    const drafted = await db.recipe.count({
      where: { createdByUserId: userId, origin: 'ai', createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    });
    if (drafted >= MAX_AI_DRAFTS_PER_DAY) {
      throw new HttpException(
        {
          error: 'AI_DRAFT_DAILY_LIMIT',
          message: `A model writes at most ${MAX_AI_DRAFTS_PER_DAY} recipes for one account in 24 hours.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async write(tx: Prisma.TransactionClient, recipe: PersonalRecipe, fingerprint: string | null): Promise<string> {
    const en = recipe.text.get('en')!;
    const created = await tx.recipe.create({
      data: {
        title: en.title,
        description: en.description,
        steps: en.steps,
        servings: recipe.servings,
        mealTypes: recipe.mealTypes,
        dietTags: recipe.facts.dietTags,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        difficulty: recipe.difficulty,
        allergens: recipe.facts.allergens,
        origin: recipe.origin,
        createdByUserId: recipe.userId,
        fingerprint,
        caloriesPerServing: recipe.facts.perServing.calories,
        proteinPerServing: recipe.facts.perServing.protein,
        fatPerServing: recipe.facts.perServing.fat,
        carbsPerServing: recipe.facts.perServing.carbs,
        reuseScore: recipe.reuseScore ?? 0,
        ingredients: { create: recipe.ingredients },
        translations: {
          create: [...recipe.text].map(([locale, text]) => ({ locale, ...text, source: 'MANUAL' as const })),
        },
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Make sure the queue holds a draft for this fingerprint and that it names
   * the personal recipes it stands for. The draft is built from the stored
   * recipe, so it holds exactly what the user has.
   */
  private async mirror(
    tx: Prisma.TransactionClient,
    recipeId: string,
    fingerprint: string,
    sources: string[],
  ): Promise<void> {
    const existing = await tx.recipeDraft.findUnique({ where: { fingerprint }, select: { id: true, sourceRecipeIds: true } });
    if (existing) {
      const merged = [...new Set([...existing.sourceRecipeIds, ...sources])];
      if (merged.length !== existing.sourceRecipeIds.length) {
        await tx.recipeDraft.update({ where: { id: existing.id }, data: { sourceRecipeIds: { set: merged } } });
      }
      return;
    }
    const recipe = await tx.recipe.findUniqueOrThrow({
      where: { id: recipeId },
      include: { translations: true, ingredients: { include: { ingredient: { select: { slug: true } } } } },
    });
    const byLocale = <T>(pick: (text: RecipeText) => T): Record<string, T> =>
      Object.fromEntries([
        ['en', pick(recipe)],
        ...recipe.translations.map((row) => [row.locale, pick(row)] as const),
      ]);
    await tx.recipeDraft.create({
      data: {
        // Named after the recipe's content, not after a user or a moment.
        slug: `personal-${fingerprint.slice(0, 12)}`,
        titles: byLocale((text) => text.title),
        descriptions: byLocale((text) => text.description),
        steps: byLocale((text) => text.steps),
        locales: [...new Set(['en', ...recipe.translations.map((row) => row.locale)])],
        servings: recipe.servings,
        mealTypes: recipe.mealTypes,
        dietTags: recipe.dietTags,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        difficulty: recipe.difficulty,
        complexity: 'medium',
        caloriesPerServing: recipe.caloriesPerServing,
        proteinPerServing: recipe.proteinPerServing,
        fatPerServing: recipe.fatPerServing,
        carbsPerServing: recipe.carbsPerServing,
        allergens: recipe.allergens,
        ingredientsJson: recipe.ingredients.map((line) => ({
          slug: line.ingredient.slug!,
          quantity: line.quantity,
          unit: line.unit,
          note: line.note,
        })),
        status: 'PENDING',
        source: 'AI_USER',
        batchId: QUEUE_BATCH,
        fingerprint,
        sourceRecipeIds: sources,
      },
    });
  }
}
