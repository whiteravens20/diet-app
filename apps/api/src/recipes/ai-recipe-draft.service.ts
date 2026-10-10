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
import { Prisma } from '@prisma/client';
import {
  Allergen,
  type CookingMethod,
  type Complexity,
  type Cuisine,
  type DietType,
  fitsDiet,
  MealType,
  Unit,
  type AiDraftRecipeRequest,
  type AiDraftRecipeResponse,
  type AiFallbackReason,
  type Locale,
} from '@diet-app/shared';
import { recipeFacts, UnitConversionError, type RecipeFacts } from '../engine/index.js';
import { AiRouterService } from '../ai/ai-router.service.js';
import { plainLine, readModelObject } from '../ai/model-json.js';
import { recipeDraft } from '../ai/operations.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DedupService } from '../admin/drafts/dedup.js';
import {
  computeFingerprint,
  FingerprintError,
  type FingerprintIngredientLookup,
} from '../admin/drafts/fingerprint.js';
import { toRecipeDto } from './recipes.service.js';

const ALLOWED_UNITS = Unit.options as readonly string[];
const ALLOWED_MEALS = MealType.options as readonly string[];
const ALLOWED_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
type Difficulty = (typeof ALLOWED_DIFFICULTIES)[number];

interface AiDraftLine {
  ingredientName: string;
  quantity: number;
  unit: 'g' | 'ml' | 'piece';
  note: string | null;
}

/**
 * Locale-keyed slice of the AI's response. Always has `en` (canonical); other
 * locales are populated when the prompt asked for them. The DB row's `title` /
 * `description` / `steps` are written from the `en` slot; `RecipeTranslation`
 * rows are written for every locale present.
 */
interface AiDraftPayload {
  titles: Record<Locale, string>;
  descriptions: Record<Locale, string>;
  steps: Record<Locale, string[]>;
  servings: number;
  mealTypes: MealType[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: Difficulty;
  ingredients: AiDraftLine[];
  /** Locales the AI returned content for — always includes 'en'. */
  locales: Locale[];
}

/**
 * Drafts a brand-new recipe from a free-form user prompt. AI picks ingredients
 * + writes title/description/steps; the deterministic engine recomputes
 * per-serving nutrition before the row is persisted. The recipe is private to
 * the requester (`origin='ai'` + `createdByUserId`) and lives in the database
 * only: nothing about a user is written to the instance's data files.
 */
@Injectable()
export class AiRecipeDraftService {
  private readonly logger = new Logger(AiRecipeDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiRouterService,
    private readonly dedup: DedupService,
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

    const dietType = req.dietType ?? profile.dietType;
    // Drafts are always single-serving. The user's per-day kcal target lives
    // on the meal plan, not the recipe — keeping recipes at servings=1 keeps
    // engine recompute trivial and the prompt small.
    const servings = 1;
    const allergens = new Set((profile.preferences?.allergens ?? []) as string[]);
    // Allergens are ALWAYS excluded. Other exclusions only when the user
    // asked for it (defaults to true on the request shape).
    const excludedIds = new Set(
      req.respectExclusions ? (profile.preferences?.excludedIngredientIds ?? []) : [],
    );
    const favouriteIds = new Set(
      req.useFavoriteIngredients ? (profile.preferences?.favoriteIngredientIds ?? []) : [],
    );

    // Curated catalogue, filtered by the user's hard constraints (diet,
    // allergens, exclusions). Cuisine / cooking method / complexity are NOT
    // hard-filtered here — they're rendered into the prompt as preferences
    // and the model is free to broaden when the intersection is too narrow.
    const rawCatalogue = await this.prisma.ingredient.findMany({
      where: {
        dietCompatibility: { has: dietType },
        id: { notIn: [...excludedIds] },
        retiredAt: null,
      },
      select: {
        id: true,
        name: true,
        category: true,
        caloriesPer100: true,
        proteinPer100: true,
        allergens: true,
      },
      take: 200,
    });
    const catalogue = rawCatalogue
      .filter((c) => !c.allergens.some((a) => allergens.has(a)))
      .slice(0, 60);
    if (catalogue.length === 0) {
      throw new BadRequestException({
        error: 'NO_ELIGIBLE_INGREDIENTS',
        message: 'No ingredients are eligible for this profile.',
      });
    }

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

    const payload = parseDraftPayload(text, targetLocales);
    if (!payload) {
      // Log the raw response so the operator can see what the model produced
      // — small Ollama models often return free-text or break the locale-keyed
      // shape, and the user-facing "malformed draft" toast is too opaque to
      // diagnose without this.
      this.logger.warn(
        `AI_DRAFT_INVALID (provider=${meta.provider ?? '?'}, model=${meta.model ?? '?'}): ${text.slice(0, 500).replace(/\s+/g, ' ')}`,
      );
      throw new BadRequestException({
        error: 'AI_DRAFT_INVALID',
        message: 'AI returned a malformed draft.',
      });
    }

    // Resolve ingredient names → catalogue ids. Names are unique in the
    // schema; reject the whole draft if any line refers to something we don't
    // recognise — we never invent rows or guess substitutions silently.
    const catalogueByLowerName = new Map(
      catalogue.map((c) => [c.name.toLowerCase(), c]),
    );
    const resolved: { ingredientId: string; quantity: number; unit: 'g' | 'ml' | 'piece'; note: string | null }[] = [];
    for (const line of payload.ingredients) {
      const hit = catalogueByLowerName.get(line.ingredientName.trim().toLowerCase());
      if (!hit) {
        // The name goes to the log, not to the client: it is the model's text.
        this.logger.warn(`AI_DRAFT_UNKNOWN_INGREDIENT: ${line.ingredientName.slice(0, 80)}`);
        throw new BadRequestException({
          error: 'AI_DRAFT_UNKNOWN_INGREDIENT',
          message: 'The draft uses an ingredient that is not in the catalogue.',
        });
      }
      resolved.push({
        ingredientId: hit.id,
        quantity: line.quantity,
        unit: line.unit,
        note: line.note,
      });
    }

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
    const recipeAllergens = facts.allergens;
    const dietTags = facts.dietTags;

    // Fingerprint — same helper used by the swap path + admin batch generator
    // so the dedup chain catches duplicates across every on-ramp. When at
    // least one ingredient is missing a slug (legacy USDA row), we skip
    // dedup and write a fresh row without a fingerprint.
    const fingerprintLookup: FingerprintIngredientLookup = new Map(
      ingredientRows
        .filter((i): i is typeof i & { slug: string } => i.slug !== null)
        .map((i) => [
          i.slug,
          {
            canonicalUnit: i.canonicalUnit,
            gramsPerPiece: i.gramsPerPiece,
            density: i.density,
          },
        ]),
    );
    const fingerprintLines = resolved.map((r) => {
      const ing = ingById.get(r.ingredientId)!;
      return { slug: ing.slug, quantity: r.quantity, unit: r.unit };
    });
    const allSlugsResolved = fingerprintLines.every(
      (l): l is typeof l & { slug: string } => l.slug !== null,
    );
    let fingerprint: string | null = null;
    if (allSlugsResolved) {
      try {
        fingerprint = computeFingerprint(
          {
            ingredients: fingerprintLines as { slug: string; quantity: number; unit: 'g' | 'ml' | 'piece' }[],
            mealTypes: payload.mealTypes,
            dietTags,
            servings: payload.servings,
          },
          fingerprintLookup,
        );
      } catch (err) {
        if (err instanceof FingerprintError) {
          fingerprint = null;
        } else {
          throw err;
        }
      }
    }

    const recipeId = await this.persistDraftWithDedup({
      userId,
      fingerprint,
      payload,
      resolved,
      recipeAllergens,
      dietTags,
      perServing,
    });

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

  /**
   * Insert the Recipe + translations + (when AI_USER and no curated/personal
   * match exists) the parallel `RecipeDraft`, all under a fingerprint advisory
   * lock. Returns the resolved recipe id — either an existing curated /
   * personal row this user already owns, or the freshly written variant.
   */
  private async persistDraftWithDedup(input: {
    userId: string;
    fingerprint: string | null;
    payload: AiDraftPayload;
    resolved: { ingredientId: string; quantity: number; unit: 'g' | 'ml' | 'piece'; note: string | null }[];
    recipeAllergens: string[];
    dietTags: string[];
    perServing: { calories: number; protein: number; fat: number; carbs: number };
  }): Promise<string> {
    const writeFresh = async (
      tx: Prisma.TransactionClient | PrismaService,
    ): Promise<string> => {
      const created = await tx.recipe.create({
        data: {
          title: input.payload.titles.en,
          description: input.payload.descriptions.en,
          servings: input.payload.servings,
          mealTypes: input.payload.mealTypes,
          dietTags: input.dietTags,
          steps: input.payload.steps.en,
          prepMinutes: input.payload.prepMinutes,
          cookMinutes: input.payload.cookMinutes,
          difficulty: input.payload.difficulty,
          allergens: input.recipeAllergens as Allergen[],
          origin: 'ai',
          createdByUserId: input.userId,
          fingerprint: input.fingerprint,
          caloriesPerServing: input.perServing.calories,
          proteinPerServing: input.perServing.protein,
          fatPerServing: input.perServing.fat,
          carbsPerServing: input.perServing.carbs,
          ingredients: {
            create: input.resolved.map((r) => ({
              ingredientId: r.ingredientId,
              quantity: r.quantity,
              unit: r.unit,
              note: r.note,
            })),
          },
        },
      });
      for (const lc of input.payload.locales) {
        await tx.recipeTranslation.create({
          data: {
            recipeId: created.id,
            locale: lc,
            title: input.payload.titles[lc],
            description: input.payload.descriptions[lc],
            steps: input.payload.steps[lc],
            source: 'MANUAL',
          },
        });
      }
      return created.id;
    };

    if (!input.fingerprint) {
      return writeFresh(this.prisma);
    }
    const fingerprint = input.fingerprint;

    return this.dedup.withFingerprintLock(fingerprint, async (tx) => {
      const curated = await this.dedup.findCuratedByFingerprint(tx, fingerprint);
      if (curated) return curated.id;
      const userOwn = await this.dedup.findUserRecipeByFingerprint(
        tx,
        fingerprint,
        input.userId,
      );
      if (userOwn) return userOwn.id;
      const newRecipeId = await writeFresh(tx);
      const existingDraft = await this.dedup.findDraftByFingerprint(
        tx,
        fingerprint,
      );
      if (existingDraft) {
        await this.dedup.attachRecipeToDraft(tx, existingDraft.id, newRecipeId);
      } else {
        await this.createAiUserDraft(tx, {
          fingerprint,
          recipeId: newRecipeId,
          createdByUserId: input.userId,
          payload: input.payload,
          resolved: input.resolved,
          recipeAllergens: input.recipeAllergens,
          dietTags: input.dietTags,
          perServing: input.perServing,
        });
      }
      return newRecipeId;
    });
  }

  /**
   * Insert the AI_USER `RecipeDraft` mirroring the personal Recipe we just
   * wrote. Translation polish (per-locale via /review) and optional curated
   * promotion happen later via the admin/reviewer surface.
   */
  private async createAiUserDraft(
    tx: Prisma.TransactionClient,
    input: {
      fingerprint: string;
      recipeId: string;
      createdByUserId: string;
      payload: AiDraftPayload;
      resolved: { ingredientId: string; quantity: number; unit: 'g' | 'ml' | 'piece'; note: string | null }[];
      recipeAllergens: string[];
      dietTags: string[];
      perServing: { calories: number; protein: number; fat: number; carbs: number };
    },
  ): Promise<void> {
    const ingRows = await tx.ingredient.findMany({
      where: { id: { in: input.resolved.map((r) => r.ingredientId) } },
      select: { id: true, slug: true },
    });
    const slugById = new Map(ingRows.map((r) => [r.id, r.slug]));
    const titles: Record<string, string> = {};
    const descriptions: Record<string, string> = {};
    const stepsByLocale: Record<string, string[]> = {};
    for (const lc of input.payload.locales) {
      titles[lc] = input.payload.titles[lc];
      descriptions[lc] = input.payload.descriptions[lc];
      stepsByLocale[lc] = input.payload.steps[lc];
    }
    await tx.recipeDraft.create({
      data: {
        slug: `ai-draft-${input.recipeId.slice(0, 8)}`,
        titles,
        descriptions,
        steps: stepsByLocale,
        locales: input.payload.locales,
        servings: input.payload.servings,
        mealTypes: input.payload.mealTypes,
        dietTags: input.dietTags,
        prepMinutes: input.payload.prepMinutes,
        cookMinutes: input.payload.cookMinutes,
        difficulty: input.payload.difficulty,
        complexity: 'medium',
        caloriesPerServing: input.perServing.calories,
        proteinPerServing: input.perServing.protein,
        fatPerServing: input.perServing.fat,
        carbsPerServing: input.perServing.carbs,
        allergens: input.recipeAllergens,
        ingredientsJson: input.resolved.map((r) => ({
          slug: slugById.get(r.ingredientId) ?? '',
          quantity: r.quantity,
          unit: r.unit,
          note: r.note,
        })),
        status: 'PENDING',
        source: 'AI_USER',
        batchId: `user-ai-draft-${input.createdByUserId.slice(0, 8)}-${Date.now()}`,
        fingerprint: input.fingerprint,
        sourceRecipeIds: [input.recipeId],
        createdByUserId: input.createdByUserId,
      },
    });
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
 * ingredients from the catalogue, every slug must resolve, no invented
 * macros. That keeps the catalogue slug-resolution invariant intact while
 * letting the model broaden when the cuisine/method/complexity filter
 * intersection has too few ingredients.
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
  catalogue: { id: string; name: string; category: string; caloriesPer100: number; proteinPer100: number }[];
  favouriteIds: Set<string>;
  targetLocales: Locale[];
}): { system: string; user: string } {
  const lines = input.catalogue.map((c) => {
    const star = input.favouriteIds.has(c.id) ? ' ⭐' : '';
    return `- ${c.name} (${c.category}, ${Math.round(c.caloriesPer100)} kcal/100g · ${Math.round(c.proteinPer100)} g protein)${star}`;
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
    '"ingredients":[{"ingredientName":string,"quantity":number,' +
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
    '1. Pick 3-12 ingredients from the catalogue below (use the exact name).',
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

/**
 * What a drafted recipe may hold. Text beyond these lengths is not a recipe
 * card, and a quantity beyond these is not an ingredient of one serving.
 */
const TEXT_LIMITS = { title: 120, description: 600, step: 300, steps: 25, note: 120, ingredientName: 120 } as const;
const MAX_QUANTITY = { g: 2_000, ml: 2_000, piece: 50 } as const;
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
 * Parse + lightly validate the model's response. Returns null when the shape
 * isn't usable — the caller throws so the user sees a clear error rather than
 * a half-broken recipe.
 */
function parseDraftPayload(text: string, targetLocales: Locale[]): AiDraftPayload | null {
  const reply = readModelObject(text);
  return reply.ok ? normalise(reply.value, targetLocales) : null;
}

function normalise(o: Record<string, unknown>, targetLocales: Locale[]): AiDraftPayload | null {

  const multi = targetLocales.length > 1;
  const titles: Record<Locale, string> = {} as Record<Locale, string>;
  const descriptions: Record<Locale, string> = {} as Record<Locale, string>;
  const stepsByLocale: Record<Locale, string[]> = {} as Record<Locale, string[]>;

  if (multi) {
    // Locale-keyed maps required for every target locale; missing or empty
    // locale rejects the entire payload.
    const titlesRaw = o.titles as Record<string, unknown> | undefined;
    const descsRaw = o.descriptions as Record<string, unknown> | undefined;
    const stepsRaw = o.steps as Record<string, unknown> | undefined;
    if (!titlesRaw || !descsRaw || !stepsRaw) return null;
    for (const lc of targetLocales) {
      const t = textField(titlesRaw[lc], TEXT_LIMITS.title);
      const d = textField(descsRaw[lc], TEXT_LIMITS.description);
      const s = stepsField(stepsRaw[lc]);
      if (!t || !d || !s) return null;
      titles[lc] = t;
      descriptions[lc] = d;
      stepsByLocale[lc] = s;
    }
  } else {
    // Legacy single-string shape — only EN. Fold into the locale-keyed
    // payload so downstream code is uniform.
    const title = textField(o.title, TEXT_LIMITS.title);
    const description = textField(o.description, TEXT_LIMITS.description);
    const steps = stepsField(o.steps);
    if (!title || !description || !steps) return null;
    titles.en = title;
    descriptions.en = description;
    stepsByLocale.en = steps;
  }

  const servings = intField(o.servings, 1, 12);
  const prepMinutes = intField(o.prepMinutes, 0, 480);
  const cookMinutes = intField(o.cookMinutes, 0, 480);
  if (servings == null || prepMinutes == null || cookMinutes == null) return null;

  const difficulty = ALLOWED_DIFFICULTIES.includes(o.difficulty as Difficulty)
    ? (o.difficulty as Difficulty)
    : null;
  if (!difficulty) return null;

  const mealTypes = arrField(o.mealTypes, (v) => (ALLOWED_MEALS.includes(v) ? (v as MealType) : null));
  if (mealTypes.length === 0) return null;

  if (!Array.isArray(o.ingredients) || o.ingredients.length === 0 || o.ingredients.length > 20) {
    return null;
  }
  const ingredients: AiDraftLine[] = [];
  for (const line of o.ingredients) {
    if (!line || typeof line !== 'object') return null;
    const l = line as Record<string, unknown>;
    const name = textField(l.ingredientName, TEXT_LIMITS.ingredientName);
    const unit = typeof l.unit === 'string' && ALLOWED_UNITS.includes(l.unit) ? (l.unit as 'g' | 'ml' | 'piece') : null;
    if (!name || unit == null) return null;
    // `1e400` is valid JSON and reads as Infinity; a serving has a ceiling.
    const quantity = l.quantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY[unit]) {
      return null;
    }
    // A note is optional, so one that is too long is dropped, not fatal.
    const note = textField(l.note, TEXT_LIMITS.note);
    ingredients.push({ ingredientName: name, quantity, unit, note });
  }

  return {
    titles,
    descriptions,
    steps: stepsByLocale,
    servings,
    mealTypes,
    prepMinutes,
    cookMinutes,
    difficulty,
    ingredients,
    locales: targetLocales,
  };
}

/** A text field as one plain line, or null when it is missing or longer than `max`. */
function textField(v: unknown, max: number): string | null {
  const line = plainLine(v);
  return line !== null && line.length <= max ? line : null;
}

/** The steps of one language, or null when their number or the length of one is out of bounds. */
function stepsField(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > TEXT_LIMITS.steps) return null;
  const steps: string[] = [];
  for (const raw of v) {
    // An empty entry is skipped; one that is too long spoils the recipe.
    if (plainLine(raw) === null) continue;
    const step = textField(raw, TEXT_LIMITS.step);
    if (step === null) return null;
    steps.push(step);
  }
  return steps.length >= 2 ? steps : null;
}

function intField(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const i = Math.round(v);
  return i >= min && i <= max ? i : null;
}

function arrField<T>(v: unknown, map: (s: string) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const m = map(x);
    if (m != null) out.push(m);
  }
  return out;
}

