// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  fitsDiet,
  Locale as LocaleEnum,
  type AiGenerationMeta,
  type AiSuggestIngredientRequest,
  type AiSuggestIngredientResponse,
  type Locale,
  type SwapIngredientRequest,
  type SwapIngredientResponse,
  type SwapPreview,
} from '@diet-app/shared';
import { AiRouterService, withUnusableAnswer } from '../ai/ai-router.service.js';
import { modelText, readModelReply } from '../ai/model-json.js';
import { INGREDIENT_SWAP, SWAP_REWRITE } from '../ai/operations.js';
import { recipeFacts, substituteIngredient, UnitConversionError, type EngineIngredient, type RecipeFacts } from '../engine/index.js';
import { toIngredientDto } from '../ingredients/ingredients.service.js';
import { stockByIngredient } from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PersonalRecipesService } from '../recipes/personal-recipes.service.js';
import { assertMayEnter, pickIndex, restrictionsFor } from './eligibility.js';
import { MealPlansService } from './meal-plans.service.js';
import { writePlan } from './plan-write.js';
import { rewriteSwapModeA, rewriteSwapModeB, validateModeBOutput, type RecipeLocaleSlice } from './swap-rewrite.js';
import { AI_SWAP_POOL, LANGUAGE, MAX_REASON_CHARS, swappableRecipeOf } from './swap-shared.js';

// What each prompt asks the model to answer with. A reason is welcome and
// never required: a pick without one is still a pick.
const IngredientPick = z.object({ ingredientId: z.string().min(1), reason: z.unknown() });
const SwapRewrite = z.object({
  description: z.string().trim().min(1),
  steps: z.array(z.string().trim().min(1)),
});

/**
 * Putting one ingredient of a planned meal's recipe in the place of another:
 * what it would do, doing it, and which ingredient to take. The recipe of the
 * catalogue stays as it is; the meal gets a recipe of the user's own.
 */
@Injectable()
export class IngredientSwapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiRouterService,
    private readonly personalRecipes: PersonalRecipesService,
    private readonly plans: MealPlansService,
  ) {}

  /**
   * Preview an ingredient substitution inside a planned meal's recipe. Returns
   * the calorie/macro delta; the caller confirms before persisting a variant.
   */
  async previewIngredientSwap(userId: string, req: SwapIngredientRequest): Promise<SwapPreview> {
    const meal = await this.plans.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const mealRecipeId = swappableRecipeOf(meal);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: mealRecipeId },
      include: { ingredients: true },
    });
    const line = recipe.ingredients.find((i) => i.ingredientId === req.fromIngredientId);
    if (!line) throw new NotFoundException({ error: 'INGREDIENT_NOT_IN_RECIPE', message: 'Ingredient not in recipe.' });

    const [from, to] = await Promise.all([
      this.loadEngineIngredient(req.fromIngredientId),
      this.loadEngineIngredient(req.toIngredientId),
    ]);
    const prefs = meal.day.plan.profile.preferences;

    const r = substituteIngredient(from, to, line.quantity, line.unit, {
      dietType: meal.day.plan.dietType,
      allergens: (prefs?.allergens ?? []) as EngineIngredient['allergens'],
      excludedIngredientIds: prefs?.excludedIngredientIds ?? [],
    });

    return {
      before: r.before,
      after: r.after,
      calorieDelta: r.calorieDelta,
      macroDelta: r.macroDelta,
      adjustedQuantity: r.adjustedQuantity,
      explanation: r.explanation,
      valid: r.valid,
    };
  }

  /**
   * Persist an ingredient substitution. The original recipe stays canonical —
   * we clone it as a private `user`-origin variant with the new line in place,
   * recompute per-serving nutrition deterministically, and repoint the planned
   * meal at the clone. Servings are kept; the substitute is calorie-scaled.
   */
  async applyIngredientSwap(
    userId: string,
    locale: Locale,
    req: SwapIngredientRequest,
  ): Promise<SwapIngredientResponse> {
    const meal = await this.plans.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const mealRecipeId = swappableRecipeOf(meal);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: mealRecipeId },
      include: {
        ingredients: { include: { ingredient: true } },
        translations: true,
      },
    });
    const line = recipe.ingredients.find((i) => i.ingredientId === req.fromIngredientId);
    if (!line) {
      throw new NotFoundException({
        error: 'INGREDIENT_NOT_IN_RECIPE',
        message: 'Ingredient not in recipe.',
      });
    }

    const [from, to] = await Promise.all([
      this.loadEngineIngredient(req.fromIngredientId),
      this.loadEngineIngredient(req.toIngredientId),
    ]);
    const prefs = meal.day.plan.profile.preferences;
    const sub = substituteIngredient(from, to, line.quantity, line.unit, {
      dietType: meal.day.plan.dietType,
      allergens: (prefs?.allergens ?? []) as EngineIngredient['allergens'],
      excludedIngredientIds: prefs?.excludedIngredientIds ?? [],
    });
    if (!sub.valid) {
      throw new BadRequestException({
        error: 'INVALID_SUBSTITUTION',
        message: sub.explanation,
      });
    }

    // Build the variant's ingredient lines + load full ingredient rows: those
    // of the variant for its nutrition, and the one swapped out as well, whose
    // names the text of the variant is searched for.
    const ingredientRows = await this.prisma.ingredient.findMany({
      where: { id: { in: [...recipe.ingredients.map((i) => i.ingredientId), req.toIngredientId] } },
      include: { translations: true },
    });
    const ingredientById = new Map(ingredientRows.map((i) => [i.id, i]));

    const variantIngredients = recipe.ingredients.map((i) => {
      if (i.ingredientId !== req.fromIngredientId) {
        return { ingredientId: i.ingredientId, quantity: i.quantity, unit: i.unit, note: i.note };
      }
      return {
        ingredientId: req.toIngredientId,
        quantity: sub.adjustedQuantity,
        unit: sub.adjustedUnit,
        note: i.note,
      };
    });

    // The variant's nutrition, allergens and diets follow from its own
    // ingredients: the one swapped out may have been the only source of an
    // allergen, and the one swapped in may not suit a diet the source did.
    let facts: RecipeFacts;
    try {
      facts = recipeFacts(
        variantIngredients.map((line) => ({
          quantity: line.quantity,
          unit: line.unit,
          ingredient: ingredientById.get(line.ingredientId)!,
        })),
        recipe.servings,
      );
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      throw new BadRequestException({
        error: 'UNIT_CONVERSION_FAILED',
        message: 'An ingredient of this recipe cannot be converted from the unit it is written in.',
      });
    }
    // The substitute was judged as an ingredient; the gate judges what the
    // meal becomes. A recipe can stop fitting a diet through quantities alone:
    // a low-carbohydrate dish with rice in place of chicken is no longer one.
    // What the meal already was by the user's own choice (an off-diet
    // favourite, a recipe of another meal) is not held against the swap.
    const restrictions = await restrictionsFor(this.prisma, meal.day.plan);
    assertMayEnter(
      {
        id: recipe.id,
        mealTypes: recipe.mealTypes,
        dietTags: facts.dietTags,
        allergens: facts.allergens,
        createdByUserId: userId,
        deletedAt: null,
        retiredAt: null,
        ingredients: variantIngredients,
      },
      // The variant is a new recipe: no avoid mark is on it yet.
      { ...restrictions, avoidedRecipeIds: [] },
      meal.mealType,
      'INVALID_SUBSTITUTION',
      {
        diet: !fitsDiet(recipe.dietTags, meal.day.plan.dietType),
        meal: !recipe.mealTypes.includes(meal.mealType),
      },
    );

    // The text of the variant: the substitute's name in place of the old one,
    // by plain replacement, or reworded by a model when the user asked for it.
    const variant = await this.buildVariantTranslations(
      userId,
      locale,
      recipe,
      ingredientById.get(req.fromIngredientId)!,
      ingredientById.get(req.toIngredientId)!,
      req.rewriteWithAi,
    );

    // Stored as the user's own recipe, or recognised as one that exists
    // already. A shared recipe the profile avoids is not handed back for it.
    const variantId = await this.personalRecipes.save(
      {
        userId,
        origin: 'user',
        text: variant.text,
        modelWrote: variant.modelWrote,
        servings: recipe.servings,
        mealTypes: recipe.mealTypes,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        difficulty: recipe.difficulty,
        reuseScore: recipe.reuseScore,
        ingredients: variantIngredients,
        facts,
      },
      restrictions.avoidedRecipeIds,
    );

    const summary = await writePlan(this.prisma, req.planId, meal.day.plan.revision, async (tx) => {
      await tx.plannedMeal.update({
        where: { id: req.plannedMealId },
        data: { recipeId: variantId },
      });
      // The substitution changed the meal's macros, so the day total moved —
      // run the same rebalance pipeline as every other edit.
      return this.plans.rebalanceDayInternal(meal.dayId, tx);
    });
    return {
      ...(await this.plans.buildRebalanceResult(userId, locale, req.planId, 'day', summary)),
      aiMeta: variant.aiMeta,
    };
  }

  /**
   * Resolve per-locale display name maps for old / new ingredient from their
   * `IngredientTranslation` rows + canonical `name` fallback, then run Mode A
   * substitution against every translation row that the source recipe carries.
   * The output is the per-locale slice we'll write into `RecipeTranslation`
   * for the variant.
   */
  private async buildVariantTranslations(
    userId: string,
    locale: Locale,
    source: { title: string; description: string; steps: string[]; translations: { locale: string; title: string; description: string; steps: string[] }[] },
    oldIngredient: { name: string; translations: { locale: string; name: string }[] },
    newIngredient: { name: string; translations: { locale: string; name: string }[] },
    rewriteWithAi: boolean,
  ): Promise<{ text: Map<Locale, RecipeLocaleSlice>; aiMeta: AiGenerationMeta | null; modelWrote: Set<Locale> }> {
    const localeOptions = LocaleEnum.options;
    // The recipe row itself holds the English text; a translation row for `en` wins over it.
    const sourceSlices = new Map<Locale, RecipeLocaleSlice>([
      ['en', { title: source.title, description: source.description, steps: source.steps }],
    ]);
    for (const tr of source.translations) {
      if (!localeOptions.includes(tr.locale as Locale)) continue;
      sourceSlices.set(tr.locale as Locale, {
        title: tr.title,
        description: tr.description,
        steps: tr.steps,
      });
    }
    const input = {
      source: sourceSlices,
      oldName: nameByLocale(oldIngredient),
      newName: nameByLocale(newIngredient),
    };

    // A model rewords the text only when the user asked for it in this
    // request: it costs them a call and time they did not otherwise spend.
    if (!rewriteWithAi) return { text: rewriteSwapModeA(input), aiMeta: null, modelWrote: new Set() };

    // One call, for the language the user reads the recipe in: their own, or
    // English when the recipe is not written in it. Where the model delivers
    // nothing usable the plain replacement stands, and the answer says why.
    let aiMeta: AiGenerationMeta | null = null;
    // The languages a model's rewording went into: stored as a model's text.
    const modelWrote = new Set<Locale>();
    const text = await rewriteSwapModeB({
      ...input,
      locale: sourceSlices.has(locale) ? locale : 'en',
      rewrite: async (rewritten, slice) => {
        const answer = await this.aiRewriteSwapSentences(userId, rewritten, slice);
        aiMeta = answer.aiMeta;
        if (answer.text) modelWrote.add(rewritten);
        return answer.text;
      },
    });
    return { text, aiMeta, modelWrote };
  }

  /**
   * Ask the model to rewrite `description + steps` in one language so the
   * prose matches the new ingredient. The model must return JSON in the shape
   * `{description, steps}`; everything is validated by `validateModeBOutput`
   * before the caller decides to splice. The text is null on any failure, and
   * `aiMeta` then says which.
   */
  private async aiRewriteSwapSentences(
    userId: string,
    locale: Locale,
    source: { description: string; steps: string[]; oldName: string; newName: string },
  ): Promise<{ text: { description: string; steps: string[] } | null; aiMeta: AiGenerationMeta }> {
    const system =
      'You polish cooking-recipe prose for an ingredient swap. ' +
      'You are given a description, a list of steps, the ingredient that was ' +
      'swapped out, and the ingredient that replaces it. ' +
      'Rewrite so the prose matches the new ingredient, keeping the technique ' +
      'verbs, every quantity, and every other ingredient unchanged. ' +
      'You must return EXACTLY the same number of steps. ' +
      `Write entirely in ${LANGUAGE[locale]}; do not switch language. ` +
      'Never invent calories, weights, temperatures, or times. ' +
      'Respond with valid JSON exactly matching this shape — no prose, no ' +
      'markdown fences, no extra keys:\n' +
      '{"description":string,"steps":string[]}';
    const user = JSON.stringify({
      description: source.description,
      steps: source.steps,
      swappedOut: source.oldName,
      swappedIn: source.newName,
    });

    const { text, meta } = await this.ai.chat(
      userId,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      SWAP_REWRITE,
      true,
    );
    if (!text) return { text: null, aiMeta: meta };
    const parsed = parseSwapRewritePayload(text);
    if (!parsed || !validateModeBOutput(source, parsed)) return { text: null, aiMeta: withUnusableAnswer(meta) };
    return { text: parsed, aiMeta: meta };
  }

  /**
   * AI-rank a replacement ingredient for a planned-meal line. The engine builds
   * the candidate pool (same category, diet/allergen-safe, excluding what's
   * already in the recipe); AI picks one id. The UI then runs the existing
   * preview/apply pipeline so nutrition is recomputed deterministically.
   */
  async aiSuggestIngredient(
    userId: string,
    locale: Locale,
    req: AiSuggestIngredientRequest,
  ): Promise<AiSuggestIngredientResponse> {
    const meal = await this.plans.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const mealRecipeId = swappableRecipeOf(meal);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: mealRecipeId },
      include: { ingredients: true },
    });
    const line = recipe.ingredients.find((i) => i.ingredientId === req.fromIngredientId);
    if (!line) {
      throw new NotFoundException({
        error: 'INGREDIENT_NOT_IN_RECIPE',
        message: 'Ingredient not in recipe.',
      });
    }
    const from = await this.prisma.ingredient.findUniqueOrThrow({
      where: { id: req.fromIngredientId },
    });
    const prefs = meal.day.plan.profile.preferences;
    const userAllergens = new Set(prefs?.allergens ?? []);
    const excludedIds = new Set([
      ...recipe.ingredients.map((i) => i.ingredientId),
      ...(prefs?.excludedIngredientIds ?? []),
    ]);
    const dietType = meal.day.plan.dietType;

    // Same category as the source line — keeps the swap culinarily sensible
    // (sub a meat for a meat, a vegetable for a vegetable).
    // Filtered in the query and in a fixed order, so that the cut below never
    // drops an ingredient the profile could have had.
    const rawCandidates = await this.prisma.ingredient.findMany({
      where: {
        category: from.category,
        id: { notIn: [...excludedIds] },
        // A custom diet filters nothing.
        ...(dietType === 'custom' ? {} : { dietCompatibility: { has: dietType } }),
        NOT: { allergens: { hasSome: [...userAllergens] } },
        retiredAt: null,
      },
      select: {
        id: true,
        name: true,
        caloriesPer100: true,
        proteinPer100: true,
        fatPer100: true,
        carbsPer100: true,
        allergens: true,
      },
      orderBy: { id: 'asc' },
    });
    let pool = rawCandidates;
    if (pool.length === 0) {
      throw new NotFoundException({
        error: 'NO_ALTERNATIVE',
        message: 'No alternative ingredient found.',
      });
    }
    // Surface pantry-friendly substitutes first. The AI sees them at the
    // top of the list AND the deterministic fallback (hashIndex on pool
    // order) prefers them.
    const pantryHits = await this.ingredientPantryHit(
      meal.day.plan.profileId,
      pool.map((c) => c.id),
      req.respectInventory !== false,
    );
    if (pantryHits) {
      pool = [...pool].sort((a, b) => {
        const aHit = pantryHits.has(a.id) ? 1 : 0;
        const bHit = pantryHits.has(b.id) ? 1 : 0;
        return bHit - aHit || a.id.localeCompare(b.id);
      });
    }
    pool = pool.slice(0, AI_SWAP_POOL);

    const prompt = buildIngredientSwapPrompt({
      currentName: from.name,
      currentCategory: from.category,
      currentKcalPer100: Math.round(from.caloriesPer100),
      candidates: pool,
      hint: req.hint,
      locale,
    });
    const { text, meta } = await this.ai.chat(
      userId,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      INGREDIENT_SWAP,
      true,
    );

    const fallbackPick = (): string => {
      const idx = pickIndex(`${req.plannedMealId}:${req.fromIngredientId}`, pool.length);
      return pool[idx]!.id;
    };

    const offered = text === null ? null : parseAiIngredientPick(text);
    const pick = offered && pool.some((c) => c.id === offered.id) ? offered : null;
    const toIngredientId = pick?.id ?? fallbackPick();
    const aiMeta = pick ? { ...meta, reason: pick.reason } : text === null ? meta : withUnusableAnswer(meta);

    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    const toIngredient = await this.prisma.ingredient.findUniqueOrThrow({
      where: { id: toIngredientId },
      include: { translations: { where: { locale: { in: locales } } } },
    });
    return { toIngredient: toIngredientDto(toIngredient, locale), aiMeta };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async loadEngineIngredient(id: string): Promise<EngineIngredient> {
    const i = await this.prisma.ingredient.findUnique({ where: { id } });
    if (!i) throw new NotFoundException({ error: 'INGREDIENT_NOT_FOUND', message: 'Ingredient not found.' });
    return {
      id: i.id,
      name: i.name,
      category: i.category,
      canonicalUnit: i.canonicalUnit,
      gramsPerPiece: i.gramsPerPiece,
      density: i.density,
      caloriesPer100: i.caloriesPer100,
      proteinPer100: i.proteinPer100,
      fatPer100: i.fatPer100,
      carbsPer100: i.carbsPer100,
      allergens: i.allergens as EngineIngredient['allergens'],
      dietCompatibility: i.dietCompatibility as EngineIngredient['dietCompatibility'],
    };
  }

  /**
   * Which of the given ingredients the pantry holds any of. Used by the AI
   * ingredient suggestion to put what is at home first. Null when the toggle
   * is off or the pantry holds none of them.
   */
  private async ingredientPantryHit(
    profileId: string,
    ingredientIds: string[],
    respectInventory: boolean,
  ): Promise<Set<string> | null> {
    if (!respectInventory || ingredientIds.length === 0) return null;
    const stock = await stockByIngredient(this.prisma, profileId, { ingredientId: { in: ingredientIds } });
    return stock.size === 0 ? null : new Set(stock.keys());
  }
}

/**
 * Parse the AI's JSON response for swap-rewrite Mode B. Returns null on any
 * shape mismatch; caller takes that as the signal to fall back to Mode A.
 */
function parseSwapRewritePayload(text: string): { description: string; steps: string[] } | null {
  const reply = readModelReply(text, SwapRewrite);
  return reply.ok ? reply.value : null;
}

/**
 * What to call an ingredient in each locale: its translation, or its English
 * name where it has none. The second-best name is still the right ingredient.
 */
function nameByLocale(ingredient: { name: string; translations: { locale: string; name: string }[] }): ReadonlyMap<Locale, string> {
  const translated = new Map(ingredient.translations.map((tr) => [tr.locale, tr.name]));
  return new Map(LocaleEnum.options.map((locale) => [locale, translated.get(locale) ?? ingredient.name]));
}

interface IngredientSwapPromptCandidate {
  id: string;
  name: string;
  caloriesPer100: number;
  proteinPer100: number;
  fatPer100: number;
  carbsPer100: number;
}

/**
 * Build the system + user prompt for the ingredient-swap ranker. Macros are
 * rounded and pinned into the prompt; the deterministic engine recomputes the
 * recipe nutrition after the pick, so the model can't move numbers.
 */
function buildIngredientSwapPrompt(input: {
  currentName: string;
  currentCategory: string;
  currentKcalPer100: number;
  candidates: IngredientSwapPromptCandidate[];
  hint?: string;
  locale: Locale;
}): { system: string; user: string } {
  const lines = input.candidates.map(
    (c) =>
      `- id=${c.id} | ${c.name} | ${Math.round(c.caloriesPer100)} kcal/100g · ${Math.round(c.proteinPer100)}P/${Math.round(c.fatPer100)}F/${Math.round(c.carbsPer100)}C`,
  );

  const system =
    'You rank ingredient-swap candidates for a deterministic meal-planning app. ' +
    'You never invent ingredients or macros — your only job is to pick the best ' +
    'id from the list provided. ' +
    'Respond with valid JSON exactly matching ' +
    '{"ingredientId":"<id>","reason":"<one short sentence>"} — no prose, no ' +
    'markdown, no other keys. The reason tells the cook why you picked it; ' +
    `write it in ${LANGUAGE[input.locale]}.`;

  const user = [
    `Category: ${input.currentCategory}`,
    `Currently using: ${input.currentName} (${input.currentKcalPer100} kcal/100g)`,
    input.hint ? `User hint: ${input.hint}` : null,
    '',
    'Pick the candidate that:',
    '1. is the closest culinary substitute,',
    '2. honours the user hint if any,',
    '3. has macros in the same ballpark unless the hint says otherwise.',
    '',
    'Candidates:',
    ...lines,
    '',
    'Respond with the JSON object only.',
  ]
    .filter((s): s is string => s !== null)
    .join('\n');

  return { system, user };
}

/**
 * The ingredient the model picked and why, as far as its answer says. Null
 * when the answer holds no id, so the service can fall back deterministically.
 */
function parseAiIngredientPick(text: string): { id: string; reason: string | null } | null {
  const reply = readModelReply(text, IngredientPick);
  if (!reply.ok) return null;
  return { id: reply.value.ingredientId, reason: modelText(reply.value.reason, MAX_REASON_CHARS) };
}
