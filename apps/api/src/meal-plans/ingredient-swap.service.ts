// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import {
  fitsDiet,
  Locale as LocaleEnum,
  SubstitutionViolation,
  type AiGenerationMeta,
  type AiSuggestIngredientRequest,
  type AiSuggestIngredientResponse,
  type Locale,
  type MovedNutrient,
  type Nutrition,
  type PlannedIngredient,
  type SubstituteSuggestion,
  type SwapIngredientRequest,
  type SwapIngredientResponse,
  type SwapPreview,
  type Unit,
} from '@diet-app/shared';
import { AiRouterService, withUnusableAnswer } from '../ai/ai-router.service.js';
import { modelText, readModelReply } from '../ai/model-json.js';
import { INGREDIENT_SWAP, SWAP_REWRITE } from '../ai/operations.js';
import {
  energyShares,
  movedBy,
  recipeFacts,
  splitDistance,
  substituteAmount,
  toCanonical,
  UnitConversionError,
  type RecipeFacts,
} from '../engine/index.js';
import { toIngredientDto } from '../ingredients/ingredients.service.js';
import { stockByIngredient } from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PersonalRecipesService } from '../recipes/personal-recipes.service.js';
import { toPlannedIngredients } from '../recipes/recipes.service.js';
import { assertMayEnter, pickIndex, restrictionsFor, violations } from './eligibility.js';
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

  /** What a substitution would do to the meal, for the user to decide on. Nothing is written. */
  async previewIngredientSwap(userId: string, locale: Locale, req: SwapIngredientRequest): Promise<SwapPreview> {
    const s = await this.substitution(userId, req);
    // The servings of the recipe that are on the plate.
    const portion = s.meal.servings * s.meal.quantityScale;
    const held = (perServing: Nutrition): Nutrition => ({
      calories: Math.round(perServing.calories * portion),
      protein: Math.round(perServing.protein * portion),
      fat: Math.round(perServing.fat * portion),
      carbs: Math.round(perServing.carbs * portion),
    });
    const before = held(s.before);
    const after = held(s.facts.perServing);
    const taken = (ingredient: typeof s.from, amount: number): PlannedIngredient =>
      toPlannedIngredients(
        [{ ingredientId: ingredient.id, quantity: amount, unit: ingredient.canonicalUnit, note: null, ingredient }],
        portion / s.recipe.servings,
        locale,
      )[0]!;
    return {
      before,
      after,
      calorieDelta: after.calories - before.calories,
      macroDelta: { protein: after.protein - before.protein, fat: after.fat - before.fat, carbs: after.carbs - before.carbs },
      from: taken(s.from, s.amountLeaving),
      to: taken(s.to, s.amountComing),
      sizing: s.sizing,
      merged: s.merged,
      violations: s.violations,
      moved: s.moved,
      valid: s.violations.length === 0,
    };
  }

  /**
   * Make an ingredient substitution. The recipe of the catalogue stays as it
   * is: the meal gets a recipe of the user's own with the substitute in it,
   * whose figures follow from its ingredients.
   */
  async applyIngredientSwap(userId: string, locale: Locale, req: SwapIngredientRequest): Promise<SwapIngredientResponse> {
    const s = await this.substitution(userId, req);
    const { meal, recipe, facts, lines, restrictions } = s;
    // The gate refuses in its own words what the preview listed.
    assertMayEnter(s.candidate, { ...restrictions, avoidedRecipeIds: [] }, meal.mealType, 'INVALID_SUBSTITUTION', s.waived);
    if (s.moved.length > 0 && !req.acceptChange) {
      throw new UnprocessableEntityException({
        error: 'SUBSTITUTION_MOVES_NUTRITION',
        message: `This substitution moves what a serving holds by more than a tenth: ${s.moved.join(', ')}. It is made when the request accepts the change.`,
        details: { moved: s.moved },
      });
    }

    // The text of the variant: the substitute's name in place of the old one,
    // by plain replacement, or reworded by a model when the user asked for it.
    const variant = await this.buildVariantTranslations(userId, locale, recipe, s.from, s.to, req.rewriteWithAi);

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
        ingredients: lines,
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
   * The catalogue's own suggestions for a planned meal: for each ingredient
   * of its recipe that has substitution rules (or for the `only` one asked
   * about), the substitute that may come into this plan and moves a serving
   * least. No model is asked.
   */
  async suggestions(userId: string, locale: Locale, planId: string, plannedMealId: string, only?: string): Promise<SubstituteSuggestion[]> {
    const subject = await this.subject(userId, planId, plannedMealId);
    const sources = [...new Set(subject.recipe.ingredients.map((line) => line.ingredientId))].filter((source) => only === undefined || source === only);
    const rules = await this.prisma.substitutionRule.findMany({
      where: { fromIngredientId: { in: sources }, toIngredient: { retiredAt: null } },
      include: { toIngredient: { include: { translations: true } } },
    });

    const suggestions: SubstituteSuggestion[] = [];
    for (const fromIngredientId of sources) {
      let best: { to: (typeof rules)[number]['toIngredient']; moved: MovedNutrient[]; far: number } | null = null;
      for (const rule of rules.filter((candidate) => candidate.fromIngredientId === fromIngredientId)) {
        let worked;
        try {
          worked = this.workOut(subject, fromIngredientId, rule.toIngredient);
        } catch (err) {
          if (!(err instanceof UnitConversionError)) throw err;
          continue; // A substitute whose unit cannot be converted is no suggestion.
        }
        if (worked.violations.length > 0) continue;
        // How far the substitute takes a serving from what it holds now, as shares of its energy.
        const before = energyShares(worked.before);
        const after = energyShares(worked.facts.perServing);
        const far = before && after ? splitDistance(before, after) : 1;
        const better = !best || worked.moved.length < best.moved.length || (worked.moved.length === best.moved.length && far < best.far);
        if (better) best = { to: rule.toIngredient, moved: worked.moved, far };
      }
      if (best) suggestions.push({ fromIngredientId, to: toIngredientDto(best.to, locale), moved: best.moved });
    }
    return suggestions;
  }

  /** The planned meal a substitution is made in: its recipe with every line, and what its plan's profile rules out. */
  private async subject(userId: string, planId: string, plannedMealId: string) {
    const meal = await this.plans.loadPlannedMeal(userId, planId, plannedMealId);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: swappableRecipeOf(meal) },
      include: { ingredients: { include: { ingredient: { include: { translations: true } } } }, translations: true },
    });
    return { userId, meal, recipe, restrictions: await restrictionsFor(this.prisma, meal.day.plan) };
  }

  /**
   * What a substitution would make of a meal's recipe: its lines, what a
   * serving of it holds, and what stands in its way. The preview shows this
   * and the apply writes it, so the two cannot say different things.
   */
  private async substitution(userId: string, req: SwapIngredientRequest) {
    const subject = await this.subject(userId, req.planId, req.plannedMealId);
    if (req.fromIngredientId === req.toIngredientId) {
      throw new BadRequestException({ error: 'SAME_INGREDIENT', message: 'An ingredient cannot take its own place.' });
    }
    if (!subject.recipe.ingredients.some((line) => line.ingredientId === req.fromIngredientId)) {
      throw new NotFoundException({ error: 'INGREDIENT_NOT_IN_RECIPE', message: 'Ingredient not in recipe.' });
    }
    const to =
      subject.recipe.ingredients.find((line) => line.ingredientId === req.toIngredientId)?.ingredient ??
      (await this.prisma.ingredient.findFirst({ where: { id: req.toIngredientId, retiredAt: null }, include: { translations: true } }));
    if (!to) throw new NotFoundException({ error: 'INGREDIENT_NOT_FOUND', message: 'Ingredient not found.' });
    try {
      return this.workOut(subject, req.fromIngredientId, to);
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      throw new BadRequestException({
        error: 'UNIT_CONVERSION_FAILED',
        message: 'An ingredient of this recipe cannot be converted from the unit it is written in.',
      });
    }
  }

  /**
   * The recipe a substitution leaves. Every line the recipe has of the
   * ingredient leaves, and one line of the substitute stands for them all;
   * where the recipe has the substitute already, its line takes the amount
   * on. Throws `UnitConversionError` for a line that cannot be converted.
   */
  private workOut(
    { userId, meal, recipe, restrictions }: Awaited<ReturnType<IngredientSwapService['subject']>>,
    fromIngredientId: string,
    to: (typeof recipe.ingredients)[number]['ingredient'],
  ) {
    const leaving = recipe.ingredients.filter((line) => line.ingredientId === fromIngredientId);
    const there = recipe.ingredients.filter((line) => line.ingredientId === to.id);
    const from = leaving[0]!.ingredient;

    let amountLeaving = 0;
    let amountThere = 0;
    for (const line of leaving) amountLeaving += toCanonical(line.quantity, line.unit, from);
    for (const line of there) amountThere += toCanonical(line.quantity, line.unit, to);
    const { amount: amountComing, sizing } = substituteAmount(from, to, amountLeaving);
    const merged = there.length > 0;
    const substitute = {
      ingredientId: to.id,
      quantity: Math.round((amountThere + amountComing) * 10) / 10,
      unit: to.canonicalUnit,
      note: (merged ? there[0]! : leaving[0]!).note,
    };

    // The substitute stands where the recipe already had it, or else where the first line of the ingredient that leaves stood.
    const lines: { ingredientId: string; quantity: number; unit: Unit; note: string | null }[] = [];
    let placed = false;
    for (const line of recipe.ingredients) {
      const leaves = line.ingredientId === from.id;
      const isSubstitute = line.ingredientId === to.id;
      if (merged ? isSubstitute : leaves) {
        if (!placed) lines.push(substitute);
        placed = true;
      } else if (!leaves) {
        lines.push({ ingredientId: line.ingredientId, quantity: line.quantity, unit: line.unit, note: line.note });
      }
    }

    // The variant's nutrition, allergens and diets follow from its own
    // ingredients: the one that left may have been the only source of an
    // allergen, and the one that came may not suit a diet the recipe did.
    const ingredientOf = new Map([...recipe.ingredients.map((line) => [line.ingredientId, line.ingredient] as const), [to.id, to] as const]);
    const facts: RecipeFacts = recipeFacts(
      lines.map((line) => ({ quantity: line.quantity, unit: line.unit, ingredient: ingredientOf.get(line.ingredientId)! })),
      recipe.servings,
    );
    const before: Nutrition = { calories: recipe.caloriesPerServing, protein: recipe.proteinPerServing, fat: recipe.fatPerServing, carbs: recipe.carbsPerServing };

    // The gate judges what the meal becomes. A recipe can stop fitting a diet
    // through quantities alone: a low-carbohydrate dish with rice in place of
    // chicken is no longer one. What the meal already was by the user's own
    // choice (an off-diet favourite, a recipe of another meal) is not held
    // against the substitution, and the variant is a new recipe: no avoid
    // mark is on it yet.
    const candidate = {
      id: recipe.id,
      mealTypes: recipe.mealTypes,
      dietTags: facts.dietTags,
      allergens: facts.allergens,
      createdByUserId: userId,
      deletedAt: null,
      retiredAt: null,
      ingredients: lines,
    };
    const waived = { diet: !fitsDiet(recipe.dietTags, meal.day.plan.dietType), meal: !recipe.mealTypes.includes(meal.mealType) };
    const found = violations(candidate, { ...restrictions, avoidedRecipeIds: [] }, meal.mealType, waived);

    return {
      meal,
      recipe,
      from,
      to,
      amountLeaving,
      amountComing,
      sizing,
      merged,
      lines,
      facts,
      before,
      moved: movedBy(before, facts.perServing),
      violations: SubstitutionViolation.options.filter((violation) => found.includes(violation)),
      candidate,
      waived,
      restrictions,
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
   * already in the recipe); AI picks one id. Where it names none of them, the
   * catalogue's own suggestion for the ingredient stands in, and a pick by
   * position where the catalogue has none. The UI then runs the existing
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
    // top of the list, and so does the pick by position below.
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

    const withoutModel = async (): Promise<string> => {
      const [suggested] = await this.suggestions(userId, locale, req.planId, req.plannedMealId, req.fromIngredientId);
      return suggested?.to.id ?? pool[pickIndex(`${req.plannedMealId}:${req.fromIngredientId}`, pool.length)]!.id;
    };

    const offered = text === null ? null : parseAiIngredientPick(text);
    const pick = offered && pool.some((c) => c.id === offered.id) ? offered : null;
    const toIngredientId = pick?.id ?? (await withoutModel());
    const aiMeta = pick ? { ...meta, reason: pick.reason } : text === null ? meta : withUnusableAnswer(meta);

    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    const toIngredient = await this.prisma.ingredient.findUniqueOrThrow({
      where: { id: toIngredientId },
      include: { translations: { where: { locale: { in: locales } } } },
    });
    return { toIngredient: toIngredientDto(toIngredient, locale), aiMeta };
  }

  // ── internals ───────────────────────────────────────────────────────────────

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
