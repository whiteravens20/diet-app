import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import {
  Allergen,
  type CookingMethod,
  type Complexity,
  type Cuisine,
  DietType,
  MealType,
  Unit,
  type AiDraftRecipeRequest,
  type AiDraftRecipeResponse,
  type Locale,
  type Recipe,
} from '@diet-app/shared';
import {
  nutritionFor,
  toCanonical,
  type EngineIngredient,
} from '../engine/index.js';
import type { Env } from '../config/env.js';
import { AiRouterService } from '../ai/ai-router.service.js';
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
const ALLOWED_DIETS = DietType.options as readonly string[];
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
  dietTags: DietType[];
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
 * the requester (`origin='ai'` + `createdByUserId`); on creation we also drop
 * a sidecar JSON in `INSTANCE_DATA_DIR/user-recipes/<userId>/<recipeId>.json`
 * so the operator's volume-backup picks it up alongside other curated data.
 */
@Injectable()
export class AiRecipeDraftService {
  private readonly logger = new Logger(AiRecipeDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiRouterService,
    private readonly config: ConfigService<Env, true>,
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
      'recipe-draft',
      true,
    );
    if (!text) {
      if (meta.fallbackReason === 'provider_timeout') {
        throw new ServiceUnavailableException({
          error: 'AI_PROVIDER_TIMEOUT',
          message:
            'AI provider was too slow — model may need a faster machine, or pick a smaller model.',
        });
      }
      throw new ServiceUnavailableException({
        error: 'AI_UNAVAILABLE',
        message: 'AI is unavailable — try again or configure a provider.',
      });
    }

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
        throw new BadRequestException({
          error: 'AI_DRAFT_UNKNOWN_INGREDIENT',
          message: `Unknown ingredient in draft: ${line.ingredientName}.`,
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

    const totals = resolved.reduce(
      (acc, ri) => {
        const ing = ingById.get(ri.ingredientId);
        if (!ing) return acc;
        const engineIng: EngineIngredient = {
          id: ing.id,
          name: ing.name,
          category: ing.category,
          canonicalUnit: ing.canonicalUnit,
          gramsPerPiece: ing.gramsPerPiece,
          density: ing.density,
          caloriesPer100: ing.caloriesPer100,
          proteinPer100: ing.proteinPer100,
          fatPer100: ing.fatPer100,
          carbsPer100: ing.carbsPer100,
          allergens: ing.allergens as EngineIngredient['allergens'],
          dietCompatibility: ing.dietCompatibility as EngineIngredient['dietCompatibility'],
        };
        let canonical: number;
        try {
          canonical = toCanonical(ri.quantity, ri.unit, engineIng);
        } catch {
          throw new BadRequestException({
            error: 'UNIT_CONVERSION_FAILED',
            message: `Cannot convert ${ri.unit} to canonical unit for ${ing.name}.`,
          });
        }
        const n = nutritionFor(canonical, {
          calories: ing.caloriesPer100,
          protein: ing.proteinPer100,
          fat: ing.fatPer100,
          carbs: ing.carbsPer100,
        });
        return {
          calories: acc.calories + n.calories,
          protein: acc.protein + n.protein,
          fat: acc.fat + n.fat,
          carbs: acc.carbs + n.carbs,
        };
      },
      { calories: 0, protein: 0, fat: 0, carbs: 0 },
    );
    const perServing = {
      calories: Math.round(totals.calories / payload.servings),
      protein: Math.round(totals.protein / payload.servings),
      fat: Math.round(totals.fat / payload.servings),
      carbs: Math.round(totals.carbs / payload.servings),
    };

    // Allergens auto-detected from ingredients — AI never authors them.
    const recipeAllergens = Array.from(
      new Set(resolved.flatMap((r) => (ingById.get(r.ingredientId)?.allergens ?? []) as string[])),
    );

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
            dietTags: payload.dietTags,
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
    const recipe = toRecipeDto(created, locale);
    this.writeSidecar(userId, recipe, { request: req, aiMeta: meta });

    return { recipe, aiMeta: meta };
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
          dietTags: input.payload.dietTags,
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
        dietTags: input.payload.dietTags,
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

  /**
   * Drop a sidecar JSON under `INSTANCE_DATA_DIR/user-recipes/<userId>/<id>.json`
   * so the operator's volume-backup captures user-authored AI recipes alongside
   * the rest of the curated data. Best-effort — a sidecar failure must not roll
   * back the DB write.
   */
  private writeSidecar(
    userId: string,
    recipe: Recipe,
    extra: { request: AiDraftRecipeRequest; aiMeta: AiDraftRecipeResponse['aiMeta'] },
  ): void {
    try {
      const raw = this.config.get('INSTANCE_DATA_DIR', { infer: true }) ?? 'instance-data';
      const root = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
      const path = join(root, 'user-recipes', userId, `${recipe.id}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify(
          {
            ...recipe,
            draftedAt: new Date().toISOString(),
            request: extra.request,
            aiMeta: extra.aiMeta,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch (err) {
      this.logger.warn(`Sidecar write failed for ${recipe.id}: ${(err as Error).message}`);
    }
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
    '"mealTypes":string[],"dietTags":string[],"prepMinutes":int,' +
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
    '4. dietTags must include the target diet; mealTypes is one or two slots.',
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
 * Parse + lightly validate the model's response. Returns null when the shape
 * isn't usable — the caller throws so the user sees a clear error rather than
 * a half-broken recipe.
 */
function parseDraftPayload(text: string, targetLocales: Locale[]): AiDraftPayload | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const candidates: string[] = [];
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);
  candidates.push(trimmed);
  for (const c of candidates) {
    try {
      const raw = JSON.parse(c) as unknown;
      const normalised = normalise(raw, targetLocales);
      if (normalised) return normalised;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function normalise(raw: unknown, targetLocales: Locale[]): AiDraftPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

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
      const t = strField(titlesRaw[lc]);
      const d = strField(descsRaw[lc]);
      const s = arrField(stepsRaw[lc], (v) => (v.trim().length > 0 ? v.trim() : null));
      if (!t || !d || s.length < 2 || s.length > 20) return null;
      titles[lc] = t;
      descriptions[lc] = d;
      stepsByLocale[lc] = s;
    }
  } else {
    // Legacy single-string shape — only EN. Fold into the locale-keyed
    // payload so downstream code is uniform.
    const title = strField(o.title);
    const description = strField(o.description);
    const steps = arrField(o.steps, (v) => (v.trim().length > 0 ? v.trim() : null));
    if (!title || !description || steps.length < 2 || steps.length > 20) return null;
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
  const dietTags = arrField(o.dietTags, (v) => (ALLOWED_DIETS.includes(v) ? (v as DietType) : null));
  if (mealTypes.length === 0 || dietTags.length === 0) return null;

  if (!Array.isArray(o.ingredients) || o.ingredients.length === 0 || o.ingredients.length > 20) {
    return null;
  }
  const ingredients: AiDraftLine[] = [];
  for (const line of o.ingredients) {
    if (!line || typeof line !== 'object') return null;
    const l = line as Record<string, unknown>;
    const name = strField(l.ingredientName);
    const quantity = typeof l.quantity === 'number' && l.quantity > 0 ? l.quantity : null;
    const unit = typeof l.unit === 'string' && ALLOWED_UNITS.includes(l.unit) ? (l.unit as 'g' | 'ml' | 'piece') : null;
    const note = typeof l.note === 'string' && l.note.trim().length > 0 ? l.note.trim() : null;
    if (!name || quantity == null || unit == null) return null;
    ingredients.push({ ingredientName: name, quantity, unit, note });
  }

  return {
    titles,
    descriptions,
    steps: stepsByLocale,
    servings,
    mealTypes,
    dietTags,
    prepMinutes,
    cookMinutes,
    difficulty,
    ingredients,
    locales: targetLocales,
  };
}

function strField(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
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

