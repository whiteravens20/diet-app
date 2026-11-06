// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import {
  type DietType,
  fitsDiet,
  MealType,
  RecipeDietTag,
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
import { buildDraftPrompt } from './ai-recipe-draft.prompt.js';
import { draftCatalogue } from './draft-catalogue.js';
import {
  listedButNotUsed,
  mealsOfTwoKinds,
  namedButNotListed,
  namedByOneWord,
  stepsDiffer,
  titleSaysMore,
} from './model-recipe-rules.js';
import { PersonalRecipesService } from './personal-recipes.service.js';
import { checkRecipe, type CheckedRecipe } from './recipe-rules.js';
import { toRecipeDto } from './recipes.service.js';

const ALLOWED_MEALS = MealType.options as readonly string[];

/**
 * Drafts a brand-new recipe from the choices a user made. The model picks the
 * ingredients from the curated catalogue and writes the title, description
 * and steps; the engine works out the nutrition before the row is stored, and
 * the draft is held to what was asked (the meal, the time, the calories) and
 * to the rules every recipe a model writes keeps (`model-recipe-rules.ts`).
 * The recipe is private to the requester (`origin='ai'` + `createdByUserId`)
 * and lives in the database only: nothing about a user is written to the
 * instance's data files. It is stored the way `PersonalRecipesService`
 * describes, and one the instance's model wrote goes before the curators as
 * well, with nothing that names who asked for it.
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
    if (!profile || profile.userId !== userId)
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });

    // Asked before the model is: a draft the account has no room for, or one
    // past the day's limit, would be paid for and then thrown away.
    await this.personalRecipes.assertRoomFor(userId, 'ai');

    const dietType = req.dietType ?? profile.dietType;
    const allergens = (profile.preferences?.allergens ?? []) as string[];
    // Allergens are ALWAYS excluded. Other exclusions only when the user
    // asked for it (defaults to true on the request shape). What the profile
    // would rather not eat is not offered either: a recipe that is written
    // for somebody has no reason to begin with it.
    const excludedIds = new Set([
      ...(req.respectExclusions ? (profile.preferences?.excludedIngredientIds ?? []) : []),
      ...(profile.preferences?.dislikedIngredientIds ?? []),
    ]);
    const favouriteIds = new Set(
      req.useFavoriteIngredients ? (profile.preferences?.favoriteIngredientIds ?? []) : [],
    );

    // Target locales: always EN (canonical for nutrition / ingredient mapping
    // + slot-resolution invariant) and, when the user's locale is non-EN, the
    // user's locale so the recipe renders natively in their plan without a
    // round-trip through the translation runner. Adding a new locale to the
    // Locale enum auto-extends this without code changes.
    const targetLocales: Locale[] = locale === 'en' ? ['en'] : ['en', locale];

    // Every curated ingredient the profile may eat, and the favourites the
    // request asks for whatever they are: the hard constraints (diet,
    // allergens, exclusions) are applied in the query, so nothing eligible is
    // lost to a cut made before them. The foods of a USDA import are left out
    // as the panel's batches leave them out: their names are the import's,
    // and among hundreds of them the model misses the staples a dish needs.
    const eligible = await this.prisma.ingredient.findMany({
      where: {
        // The model names its picks by slug, and a recipe is recognised by them.
        slug: { not: null },
        retiredAt: null,
        id: { notIn: [...excludedIds] },
        // A custom diet filters nothing.
        ...(dietType === 'custom' ? {} : { dietCompatibility: { has: dietType } }),
        NOT: { allergens: { hasSome: allergens } },
        OR: [{ NOT: { tags: { has: IMPORTED } } }, { id: { in: [...favouriteIds] } }],
      },
      select: {
        id: true,
        slug: true,
        name: true,
        category: true,
        canonicalUnit: true,
        caloriesPer100: true,
        proteinPer100: true,
        gramsPerPiece: true,
        perTeaspoon: true,
        translations: {
          where: { locale: { in: targetLocales } },
          select: { locale: true, name: true },
        },
      },
    });
    if (eligible.length === 0) {
      throw new BadRequestException({
        error: 'NO_ELIGIBLE_INGREDIENTS',
        message: 'No ingredients are eligible for this profile.',
      });
    }
    // A dry spice the account's last dish of this meal and cuisine was
    // seasoned with is not offered again, so that the dishes of one kitchen do
    // not all taste of it; salt, pepper and the favourites stay.
    const already = await this.recipesAlready(userId, dietType, req);
    const lastDish = new Set(already.own[0] ?? []);
    const rested = (row: (typeof eligible)[number]): boolean =>
      row.category === 'spices' &&
      row.perTeaspoon !== null &&
      !ALWAYS_OFFERED.has(row.slug!) &&
      lastDish.has(row.slug!) &&
      !favouriteIds.has(row.id);

    // What the model is offered: the same list for the same request, with the
    // favourites in it and something of every category.
    const catalogue = draftCatalogue(
      eligible
        .filter((row) => !rested(row))
        .map((row) => ({
          id: row.id,
          slug: row.slug!,
          names: {
            ...Object.fromEntries(row.translations.map((t) => [t.locale, t.name])),
            en: row.name,
          },
          category: row.category,
          canonicalUnit: row.canonicalUnit,
          caloriesPer100: row.caloriesPer100,
          proteinPer100: row.proteinPer100,
          gramsPerPiece: row.gramsPerPiece,
        })),
      favouriteIds,
      [profile.id, dietType, req.mealType, req.cuisine, req.cookingMethod, req.complexity].join(
        ':',
      ),
    );

    const prompt = buildDraftPrompt({
      mealType: req.mealType,
      dietType,
      cuisine: req.cuisine,
      cookingMethod: req.cookingMethod,
      complexity: req.complexity,
      kcalTarget: req.kcalTarget,
      prepTimeMaxMinutes: req.prepTimeMaxMinutes,
      catalogue,
      favouriteIds,
      targetLocales,
      existing: [...already.own, ...already.library],
      rested: eligible.filter(rested).map((row) => row.name),
    });
    const { text, meta, owner } = await this.ai.chat(
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
      offered.set(ingredient.names.en.toLowerCase(), ingredient);
      offered.set(ingredient.slug, ingredient);
    }
    const draft = readDraft(
      text,
      targetLocales,
      (written) => offered.get(written.trim().toLowerCase())?.slug ?? null,
    );
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

    // What every recipe a model writes keeps, and what this request asked for.
    const broken = await this.brokenRule(payload, req, catalogue);
    if (broken) {
      this.logger.warn(
        `AI_DRAFT_INVALID (provider=${meta.provider ?? '?'}, model=${meta.model ?? '?'}): ${broken}`,
      );
      throw new BadRequestException({
        error: 'AI_DRAFT_INVALID',
        message: 'AI returned a malformed draft.',
      });
    }

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
        resolved.map((line) => ({
          quantity: line.quantity,
          unit: line.unit,
          ingredient: ingById.get(line.ingredientId)!,
        })),
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
    // more than a fifth away from the calories the user asked for.
    const asked = req.kcalTarget;
    if (
      perServing.calories < SERVING_KCAL.min ||
      perServing.calories > SERVING_KCAL.max ||
      (asked !== undefined && Math.abs(perServing.calories - asked) > asked * KCAL_TOLERANCE)
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
            {
              title: payload.titles[lc]!,
              description: payload.descriptions[lc]!,
              steps: payload.steps[lc]!,
            },
          ]),
        ),
        // Every word of it is the model's.
        modelWrote: new Set(targetLocales),
        // What the instance's model writes, the operator paid for.
        forCurators: owner === 'operator',
        servings: payload.servings,
        mealTypes: payload.mealTypes,
        prepMinutes: payload.prepMinutes,
        cookMinutes: payload.cookMinutes,
        difficulty: payload.difficulty,
        // The cuisine it was asked for: the prompt asks for a dish of that kitchen.
        cuisine: req.cuisine ?? null,
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
          orderBy: { position: 'asc' },
          include: { ingredient: { include: this.translationsInclude(locale) } },
        },
        ...this.translationsInclude(locale),
      },
    });
    return { recipe: toRecipeDto(created, locale), aiMeta: meta };
  }

  /**
   * The recipes the account has already for the meal and the cuisine asked
   * for, and the library's the profile's diet takes, each by the slugs of its
   * ingredients, the newest first.
   */
  private async recipesAlready(
    userId: string,
    dietType: DietType,
    req: AiDraftRecipeRequest,
  ): Promise<{ own: string[][]; library: string[][] }> {
    const alike = {
      deletedAt: null,
      ...(req.mealType ? { mealTypes: { has: req.mealType } } : {}),
      ...(req.cuisine ? { cuisine: req.cuisine } : {}),
    };
    const ofEach = {
      orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
      select: {
        ingredients: {
          orderBy: { position: 'asc' as const },
          select: { ingredient: { select: { slug: true } } },
        },
      },
    };
    const [own, library] = await Promise.all([
      this.prisma.recipe.findMany({
        ...ofEach,
        where: { ...alike, createdByUserId: userId },
        take: OWN_RECIPES_SHOWN,
      }),
      this.prisma.recipe.findMany({
        ...ofEach,
        where: {
          ...alike,
          createdByUserId: null,
          retiredAt: null,
          // Balanced, high-protein and custom take any recipe.
          ...(RecipeDietTag.safeParse(dietType).success ? { dietTags: { has: dietType } } : {}),
        },
        take: LIBRARY_RECIPES_SHOWN,
      }),
    ]);
    const slugs = (recipes: typeof own): string[][] =>
      recipes.map((recipe) =>
        recipe.ingredients.flatMap((line) => (line.ingredient.slug ? [line.ingredient.slug] : [])),
      );
    return { own: slugs(own), library: slugs(library) };
  }

  /**
   * The first rule the draft breaks, said for the log, or null: those of every
   * recipe a model writes, and the meal and the time the request asked for.
   * A text is held to the English one, the language every draft is written in.
   */
  private async brokenRule(
    recipe: CheckedRecipe,
    req: AiDraftRecipeRequest,
    offered: readonly { slug: string; names: { en: string } }[],
  ): Promise<string | null> {
    const steps = stepsDiffer(recipe.steps);
    if (steps) return `steps differ between languages (${steps})`;
    if (req.mealType && !recipe.mealTypes.includes(req.mealType))
      return `not for the meal asked for (${recipe.mealTypes.join(', ')}, asked ${req.mealType})`;
    if (mealsOfTwoKinds(recipe.mealTypes))
      return `a main dish and a small one (${recipe.mealTypes.join(', ')})`;
    if (titleSaysMore(recipe.titles.en ?? '')) return 'the title names a diet, a band or praise';

    // Held to every curated ingredient's name, not only to those offered: a
    // text that names one the profile does not eat describes another dish.
    const curated = await this.prisma.ingredient.findMany({
      where: { slug: { not: null }, retiredAt: null, NOT: { tags: { has: IMPORTED } } },
      select: { slug: true, name: true },
    });
    const names = [
      ...curated.map((row) => ({ slug: row.slug!, name: row.name })),
      ...offered.map((row) => ({ slug: row.slug, name: row.names.en })),
    ];
    const nameOf = new Map(names.map(({ slug, name }) => [slug, name]));
    const listed = recipe.ingredients.map((line) => line.slug);
    const lacking = namedButNotListed(
      [recipe.titles.en ?? '', recipe.descriptions.en ?? '', ...(recipe.steps.en ?? [])].join(' '),
      listed,
      namedByOneWord(names),
      nameOf,
    );
    if (lacking) return `names ${lacking}, which its list does not hold`;
    const unused = listedButNotUsed((recipe.steps.en ?? []).join(' '), listed, nameOf);
    if (unused) return `lists ${unused}, which no step uses`;

    const minutes = recipe.prepMinutes + recipe.cookMinutes;
    if (req.prepTimeMaxMinutes !== undefined && minutes > req.prepTimeMaxMinutes)
      return `takes ${minutes} minutes, asked at most ${req.prepTimeMaxMinutes}`;
    return null;
  }

  private translationsInclude(locale: Locale) {
    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    return { translations: { where: { locale: { in: locales } } } } as const;
  }
}

/** The calories of anything that can be called a serving of a meal. */
const SERVING_KCAL = { min: 30, max: 2_500 } as const;

/** How far a draft may be from the calories asked for, as a share of them. */
const KCAL_TOLERANCE = 0.2;

/** The tag a food of a USDA import carries (`admin/usda/importer.ts`). */
const IMPORTED = 'usda-imported';

/** How many of the account's own recipes, and of the library's, a prompt lists for the draft to be another dish. */
const OWN_RECIPES_SHOWN = 10;
const LIBRARY_RECIPES_SHOWN = 20;

/** The seasonings of nearly every dish, which are never rested. */
const ALWAYS_OFFERED: ReadonlySet<string> = new Set(['salt', 'black-pepper']);

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
    case 'new_accounts_quota_exhausted':
      return new ForbiddenException({
        error: 'AI_NEW_ACCOUNTS_LIMIT_REACHED',
        message:
          "The part of this instance's AI requests that new accounts share is used up for now.",
      });
    case 'not_permitted':
      return new ForbiddenException({
        error: 'AI_NOT_PERMITTED',
        message: "This instance's AI is not open to this account.",
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
        message:
          'AI provider was too slow — model may need a faster machine, or pick a smaller model.',
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
  const whole = (value: unknown): unknown =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : value;
  const candidate: Record<string, unknown> = {
    titles: only ? { [only]: o.title } : o.titles,
    descriptions: only ? { [only]: o.description } : o.descriptions,
    steps: only ? { [only]: o.steps } : o.steps,
    servings: whole(o.servings),
    prepMinutes: whole(o.prepMinutes),
    cookMinutes: whole(o.cookMinutes),
    difficulty: o.difficulty,
    mealTypes: Array.isArray(o.mealTypes)
      ? o.mealTypes.filter((meal) => ALLOWED_MEALS.includes(meal as string))
      : o.mealTypes,
    ingredients: lines,
  };

  let checked = checkRecipe(candidate, locales);
  if (!checked.ok && checked.problems.every((problem) => problem.path.endsWith('.note'))) {
    // A note is optional: one the rules refuse is left out, and the recipe stays.
    const refused = new Set(checked.problems.map((problem) => problem.path));
    candidate.ingredients = lines.map((line, index) =>
      refused.has(`ingredients[${index}].note`) && isRecord(line) ? { ...line, note: null } : line,
    );
    checked = checkRecipe(candidate, locales);
  }
  if (!checked.ok)
    return {
      problem: checked.problems.map((problem) => `${problem.path}: ${problem.rule}`).join(', '),
    };
  if (Object.values(checked.recipe.steps).some((steps) => steps.length < 2))
    return { problem: 'a single step' };
  return { recipe: checked.recipe };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
