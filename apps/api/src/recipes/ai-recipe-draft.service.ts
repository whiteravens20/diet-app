// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type CookingMethod,
  type Complexity,
  type Cuisine,
  type DietType,
  fitsDiet,
  MealType,
  type AiDraftRecipeRequest,
  type AiDraftRecipeResponse,
  type AiFallbackReason,
  type Locale,
} from '@diet-app/shared';
import { recipeFacts, UnitConversionError, type RecipeFacts } from '../engine/index.js';
import { AiRouterService } from '../ai/ai-router.service.js';
import { readModelObject } from '../ai/model-json.js';
import { recipeDraft } from '../ai/operations.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { draftCatalogue } from './draft-catalogue.js';
import { PersonalRecipesService } from './personal-recipes.service.js';
import { checkRecipe, type CheckedRecipe } from './recipe-rules.js';
import { toRecipeDto } from './recipes.service.js';

const ALLOWED_MEALS = MealType.options as readonly string[];

/**
 * Drafts a brand-new recipe from the preferences a user picked. AI picks
 * ingredients + writes title/description/steps; the deterministic engine
 * recomputes per-serving nutrition before the row is persisted. The recipe is
 * private to the requester (`origin='ai'` + `createdByUserId`) and lives in
 * the database only: nothing about a user is written to the instance's data
 * files. It is stored, and kept out of the curation queue, the way
 * `PersonalRecipesService` describes.
 */
@Injectable()
export class AiRecipeDraftService {
  private readonly logger = new Logger(AiRecipeDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiRouterService,
    private readonly personalRecipes: PersonalRecipesService,
  ) {}

  async draftFromPrompt(
    userId: string,
    locale: Locale,
    req: AiDraftRecipeRequest,
  ): Promise<AiDraftRecipeResponse> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: req.profileId },
      include: { preferences: true },
    });
    if (!profile || profile.userId !== userId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Profile belongs to another user.',
      });
    }

    // Asked before the model is: a draft the account has no room for, or one
    // past the day's limit, would be paid for and then thrown away.
    await this.personalRecipes.assertRoomFor(userId, 'ai');

    const dietType = req.dietType ?? profile.dietType;
    // Drafts are always single-serving. The user's per-day kcal target lives
    // on the meal plan, not the recipe — keeping recipes at servings=1 keeps
    // engine recompute trivial and the prompt small.
    const servings = 1;
    const allergens = (profile.preferences?.allergens ?? []) as string[];
    // Allergens are ALWAYS excluded. Other exclusions only when the user
    // asked for it (defaults to true on the request shape).
    const excludedIds = new Set(
      req.respectExclusions ? (profile.preferences?.excludedIngredientIds ?? []) : [],
    );
    const favouriteIds = new Set(
      req.useFavoriteIngredients ? (profile.preferences?.favoriteIngredientIds ?? []) : [],
    );

    // Every ingredient the profile may eat: the hard constraints (diet,
    // allergens, exclusions) are applied in the query, so nothing eligible is
    // lost to a cut made before them. Cuisine / cooking method / complexity
    // are NOT hard-filtered here — they're rendered into the prompt as
    // preferences and the model is free to broaden.
    const eligible = await this.prisma.ingredient.findMany({
      where: {
        // The model names its picks by slug, and a recipe is recognised by them.
        slug: { not: null },
        retiredAt: null,
        id: { notIn: [...excludedIds] },
        // A custom diet filters nothing.
        ...(dietType === 'custom' ? {} : { dietCompatibility: { has: dietType } }),
        NOT: { allergens: { hasSome: allergens } },
      },
      select: {
        id: true,
        slug: true,
        name: true,
        category: true,
        caloriesPer100: true,
        proteinPer100: true,
      },
    });
    if (eligible.length === 0) {
      throw new BadRequestException({
        error: 'NO_ELIGIBLE_INGREDIENTS',
        message: 'No ingredients are eligible for this profile.',
      });
    }
    // What the model is offered: the same list for the same request, with the
    // favourites in it and something of every category.
    const catalogue = draftCatalogue(
      eligible.map((row) => ({ ...row, slug: row.slug! })),
      favouriteIds,
      [profile.id, dietType, req.mealType, req.cuisine, req.cookingMethod, req.complexity].join(':'),
    );

    // Target locales: always EN (canonical for nutrition / ingredient mapping
    // + slot-resolution invariant) and, when the user's locale is non-EN, the
    // user's locale so the recipe renders natively in their plan without a
    // round-trip through the translation runner. Adding a new locale to the
    // Locale enum auto-extends this without code changes.
    const targetLocales: Locale[] = locale === 'en' ? ['en'] : ['en', locale];

    const prompt = buildDraftPrompt({
      mealType: req.mealType,
      dietType,
      cuisine: req.cuisine,
      cookingMethod: req.cookingMethod,
      complexity: req.complexity,
      kcalTarget: req.kcalTarget,
      prepTimeMaxMinutes: req.prepTimeMaxMinutes,
      servings,
      catalogue,
      favouriteIds,
      targetLocales,
    });
    const { text, meta } = await this.ai.chat(
      userId,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      recipeDraft(targetLocales.length),
      true,
    );
    // A draft has no engine fallback, so each reason the model was not asked,
    // or did not answer, is an error of its own: trying again helps with some
    // of them and not with others.
    if (!text) throw draftUnavailable(meta.fallbackReason);

    // The model's picks are resolved among the ingredients it was offered, and
    // only among those: that is what keeps an allergen, an excluded ingredient
    // or one outside the diet out of the draft. A model that wrote the name
    // where the slug was asked for is still understood. Anything else rejects
    // the whole draft — we never invent rows or guess substitutions silently.
    const offered = new Map<string, (typeof catalogue)[number]>();
    for (const ingredient of catalogue) {
      offered.set(ingredient.name.toLowerCase(), ingredient);
      offered.set(ingredient.slug, ingredient);
    }
    const draft = readDraft(text, targetLocales, (written) => offered.get(written.trim().toLowerCase())?.slug ?? null);
    if ('unknownIngredient' in draft) {
      // The name goes to the log, not to the client: it is the model's text.
      this.logger.warn(`AI_DRAFT_UNKNOWN_INGREDIENT: ${draft.unknownIngredient.slice(0, 80)}`);
      throw new BadRequestException({
        error: 'AI_DRAFT_UNKNOWN_INGREDIENT',
        message: 'The draft uses an ingredient that was not on offer.',
      });
    }
    if ('problem' in draft) {
      // Log what was wrong and the raw response so the operator can see what
      // the model produced — small Ollama models often return free-text or
      // break the locale-keyed shape, and the user-facing "malformed draft"
      // toast is too opaque to diagnose without this.
      this.logger.warn(
        `AI_DRAFT_INVALID (provider=${meta.provider ?? '?'}, model=${meta.model ?? '?'}): ${draft.problem}: ${text.slice(0, 500).replace(/\s+/g, ' ')}`,
      );
      throw new BadRequestException({
        error: 'AI_DRAFT_INVALID',
        message: 'AI returned a malformed draft.',
      });
    }
    const payload = draft.recipe;
    const resolved = payload.ingredients.map((line) => ({
      ingredientId: offered.get(line.slug)!.id,
      quantity: line.quantity,
      unit: line.unit,
      note: line.note,
    }));

    // Re-fetch full ingredient rows so the engine can recompute nutrition.
    const ingredientRows = await this.prisma.ingredient.findMany({
      where: { id: { in: resolved.map((r) => r.ingredientId) } },
    });
    const ingById = new Map(ingredientRows.map((i) => [i.id, i]));

    // Nutrition, allergens and diets are the engine's, from the ingredient
    // table: the model authors none of them.
    let facts: RecipeFacts;
    try {
      facts = recipeFacts(
        resolved.map((line) => ({ quantity: line.quantity, unit: line.unit, ingredient: ingById.get(line.ingredientId)! })),
        payload.servings,
      );
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      throw new BadRequestException({
        error: 'UNIT_CONVERSION_FAILED',
        message: 'The draft measures an ingredient in a unit it cannot be converted from.',
      });
    }
    const perServing = facts.perServing;

    // Whether this is a serving is judged by the engine's number, not by what
    // the model meant: a draft that is no meal at all is refused, and so is one
    // far from the calories the user asked for.
    const asked = req.kcalTarget;
    if (
      perServing.calories < SERVING_KCAL.min ||
      perServing.calories > SERVING_KCAL.max ||
      (asked !== undefined && (perServing.calories < asked / 2 || perServing.calories > asked * 2))
    ) {
      this.logger.warn(
        `AI_DRAFT_OFF_TARGET (provider=${meta.provider ?? '?'}, model=${meta.model ?? '?'}): ${perServing.calories} kcal per serving, asked for ${asked ?? 'no target'}`,
      );
      throw new BadRequestException({
        error: 'AI_DRAFT_OFF_TARGET',
        message: 'The draft is far from the calories of a serving, or from the calories asked for.',
      });
    }

    // The ingredients offered were all compatible with the diet, but whether a
    // recipe is low in carbohydrate depends on how much of each it uses.
    if (!fitsDiet(facts.dietTags, dietType)) {
      this.logger.warn(
        `AI_DRAFT_OFF_DIET (provider=${meta.provider ?? '?'}, model=${meta.model ?? '?'}): asked for ${dietType}, the draft qualifies for [${facts.dietTags.join(', ')}]`,
      );
      throw new BadRequestException({
        error: 'AI_DRAFT_OFF_DIET',
        message: 'The draft does not fit the diet that was asked for.',
      });
    }
    // Stored as the user's own recipe, or recognised as one that exists
    // already: a model that writes the same recipe twice gives the same
    // recipe. A shared recipe the profile avoids is not handed back for it.
    const avoided = await this.prisma.favorite.findMany({
      where: { profileId: profile.id, sentiment: 'avoid' },
      select: { recipeId: true },
    });
    const recipeId = await this.personalRecipes.save(
      {
        userId,
        origin: 'ai',
        text: new Map(
          targetLocales.map((lc) => [
            lc,
            { title: payload.titles[lc]!, description: payload.descriptions[lc]!, steps: payload.steps[lc]! },
          ]),
        ),
        servings: payload.servings,
        mealTypes: payload.mealTypes,
        prepMinutes: payload.prepMinutes,
        cookMinutes: payload.cookMinutes,
        difficulty: payload.difficulty,
        ingredients: resolved,
        facts,
      },
      avoided.map((row) => row.recipeId),
    );

    if (req.addToFavorites) {
      await this.prisma.favorite.upsert({
        where: { profileId_recipeId: { profileId: profile.id, recipeId } },
        create: {
          profileId: profile.id,
          recipeId,
          tags: ['ai-drafted'],
          sentiment: 'favorite',
        },
        update: { tags: ['ai-drafted'] },
      });
    }

    const created = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: recipeId },
      include: {
        ingredients: {
          include: { ingredient: { include: this.translationsInclude(locale) } },
        },
        ...this.translationsInclude(locale),
      },
    });
    return { recipe: toRecipeDto(created, locale), aiMeta: meta };
  }

  private translationsInclude(locale: Locale) {
    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    return { translations: { where: { locale: { in: locales } } } } as const;
  }
}

/**
 * Build the model prompt from the structured request. There is no user
 * free-text path — every preference is a fixed enum / number, so this
 * function is the entire surface the model sees beyond the system rules.
 *
 * Preferences are rendered as soft hints ("prefer", "lean toward"), never
 * as hard constraints. The model knows the only hard constraints are: pick
 * ingredients from the catalogue, name each by its slug, no invented macros.
 */
function buildDraftPrompt(input: {
  mealType?: MealType;
  dietType: DietType;
  cuisine?: Cuisine;
  cookingMethod?: CookingMethod;
  complexity?: Complexity;
  kcalTarget?: number;
  prepTimeMaxMinutes?: number;
  servings: number;
  catalogue: { id: string; slug: string; name: string; category: string; caloriesPer100: number; proteinPer100: number }[];
  favouriteIds: Set<string>;
  targetLocales: Locale[];
}): { system: string; user: string } {
  const lines = input.catalogue.map((c) => {
    const star = input.favouriteIds.has(c.id) ? ' ⭐' : '';
    return `- ${c.slug}: ${c.name} (${c.category}, ${Math.round(c.caloriesPer100)} kcal/100g · ${Math.round(c.proteinPer100)} g protein)${star}`;
  });

  // Locale-keyed shape only when more than one locale is requested. For pure
  // EN ('en' only), keep the legacy single-string shape so we don't pay a
  // prompt-size and parser tax for monolingual operators.
  const multi = input.targetLocales.length > 1;
  const localeList = input.targetLocales.join(', ');
  const titlesShape = multi
    ? `"titles":{${input.targetLocales.map((l) => `"${l}":string`).join(',')}}`
    : '"title":string';
  const descShape = multi
    ? `"descriptions":{${input.targetLocales.map((l) => `"${l}":string`).join(',')}}`
    : '"description":string';
  const stepsShape = multi
    ? `"steps":{${input.targetLocales.map((l) => `"${l}":string[]`).join(',')}}`
    : '"steps":string[]';

  const localeRule = multi
    ? `You write title, description, and steps in EVERY one of these locales: ${localeList}. ` +
      'Translations are natural per locale — not literal word-for-word renderings. ' +
      'Keep the cooking technique and ingredient choices identical across locales. '
    : '';

  const system =
    'You draft cooking recipes for a deterministic meal-planning app. ' +
    'You ONLY pick from the ingredient catalogue provided — never invent ' +
    'ingredients, never propose substitutions. You never write or estimate ' +
    'calories, protein, fat, or carbs; the app recomputes those from the ' +
    'catalogue values. ' +
    localeRule +
    'Respond with valid JSON exactly matching this shape — no prose, no ' +
    'markdown fences, no extra keys:\n' +
    `{${titlesShape},${descShape},"servings":int,` +
    '"mealTypes":string[],"prepMinutes":int,' +
    '"cookMinutes":int,"difficulty":"easy"|"medium"|"hard",' +
    '"ingredients":[{"slug":string,"quantity":number,' +
    `"unit":"g"|"ml"|"piece","note":string|null}],${stepsShape}}`;

  const preferences: string[] = [];
  if (input.cuisine) preferences.push(`- Cuisine: ${input.cuisine.replace(/_/g, ' ')}`);
  if (input.cookingMethod) {
    preferences.push(`- Cooking method: ${input.cookingMethod.replace(/_/g, ' ')}`);
  }
  if (input.complexity) preferences.push(`- Complexity: ${input.complexity}`);
  if (input.kcalTarget) preferences.push(`- Aim for roughly ${input.kcalTarget} kcal per serving`);
  if (input.prepTimeMaxMinutes) {
    preferences.push(`- Keep prep + cook ≤ ${input.prepTimeMaxMinutes} minutes`);
  }
  if (input.favouriteIds.size > 0) {
    preferences.push(
      '- Favourite ingredients are marked with ⭐ in the catalogue — prefer them when they fit.',
    );
  }
  const preferenceBlock = preferences.length > 0
    ? ['', 'Soft preferences (use when sensible, ignore when they conflict with what makes a good recipe):', ...preferences]
    : ['', '(No additional preferences — pick any cuisine, method or complexity that fits the diet + meal type.)'];

  const user = [
    `Target diet type: ${input.dietType}`,
    input.mealType ? `Target meal type: ${input.mealType}` : null,
    `Target servings: ${input.servings}`,
    ...preferenceBlock,
    '',
    'Hard rules:',
    '1. Pick 3-12 ingredients from the catalogue below. Name each by its slug: the part of its line before the colon.',
    "2. Quantity > 0; unit is g, ml or piece — match the ingredient's natural form.",
    '3. 2-12 cooking steps, imperative ("Slice the chicken", "Combine and stir").',
    '4. mealTypes is one or two slots.',
    '5. Difficulty reflects step count + technique.',
    '',
    'Ingredient catalogue:',
    ...lines,
    '',
    'Respond with the JSON object only.',
  ]
    .filter((s): s is string => s !== null)
    .join('\n');

  return { system, user };
}

/** The calories of anything that can be called a serving of a meal. */
const SERVING_KCAL = { min: 30, max: 2_500 } as const;

function draftUnavailable(reason: AiFallbackReason | null): HttpException {
  switch (reason) {
    case 'quota_exhausted':
      return new ForbiddenException({
        error: 'AI_MONTHLY_LIMIT_REACHED',
        message: 'Monthly AI request limit reached.',
      });
    case 'instance_quota_exhausted':
      return new ForbiddenException({
        error: 'AI_INSTANCE_LIMIT_REACHED',
        message: "This instance's shared AI requests for the month are used up.",
      });
    case 'key_unreadable':
      return new ConflictException({
        error: 'AI_KEY_UNREADABLE',
        message: 'A saved AI provider key can no longer be read. Enter it again.',
      });
    case 'no_provider':
      return new ConflictException({
        error: 'AI_NOT_CONFIGURED',
        message: 'No AI provider is set up for your account.',
      });
    case 'provider_timeout':
      return new ServiceUnavailableException({
        error: 'AI_PROVIDER_TIMEOUT',
        message: 'AI provider was too slow — model may need a faster machine, or pick a smaller model.',
      });
    default:
      return new ServiceUnavailableException({
        error: 'AI_UNAVAILABLE',
        message: 'The AI provider did not respond — try again in a moment.',
      });
  }
}

/**
 * The recipe in a model's answer, held to the rules of every recipe. The model
 * is met half-way first: an answer in one language may use plain fields, a
 * whole number may come with a fraction, a meal the planner does not know is
 * left out, an ingredient may be called by its name, and a note the rules
 * refuse is dropped. What is left has to pass like any other recipe, and has
 * to be more than a single step.
 */
function readDraft(
  text: string,
  locales: Locale[],
  slugOf: (written: string) => string | null,
): { recipe: CheckedRecipe } | { unknownIngredient: string } | { problem: string } {
  const reply = readModelObject(text);
  if (!reply.ok) return { problem: 'no JSON object' };
  const o = reply.value;

  const lines: unknown[] = [];
  for (const line of Array.isArray(o.ingredients) ? o.ingredients : []) {
    if (!isRecord(line) || typeof line.slug !== 'string') {
      lines.push(line);
      continue;
    }
    const slug = slugOf(line.slug);
    if (slug === null) return { unknownIngredient: line.slug };
    lines.push({ ...line, slug });
  }

  const only = locales.length === 1 ? locales[0]! : null;
  const whole = (value: unknown): unknown => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : value);
  const candidate: Record<string, unknown> = {
    titles: only ? { [only]: o.title } : o.titles,
    descriptions: only ? { [only]: o.description } : o.descriptions,
    steps: only ? { [only]: o.steps } : o.steps,
    servings: whole(o.servings),
    prepMinutes: whole(o.prepMinutes),
    cookMinutes: whole(o.cookMinutes),
    difficulty: o.difficulty,
    mealTypes: Array.isArray(o.mealTypes) ? o.mealTypes.filter((meal) => ALLOWED_MEALS.includes(meal as string)) : o.mealTypes,
    ingredients: lines,
  };

  let checked = checkRecipe(candidate, locales);
  if (!checked.ok && checked.problems.every((problem) => problem.path.endsWith('.note'))) {
    // A note is optional: one the rules refuse is left out, and the recipe stays.
    const refused = new Set(checked.problems.map((problem) => problem.path));
    candidate.ingredients = lines.map((line, index) => (refused.has(`ingredients[${index}].note`) && isRecord(line) ? { ...line, note: null } : line));
    checked = checkRecipe(candidate, locales);
  }
  if (!checked.ok) return { problem: checked.problems.map((problem) => `${problem.path}: ${problem.rule}`).join(', ') };
  if (Object.values(checked.recipe.steps).some((steps) => steps.length < 2)) return { problem: 'a single step' };
  return { recipe: checked.recipe };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
