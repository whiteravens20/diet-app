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
import {
  Allergen,
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

interface AiDraftPayload {
  title: string;
  description: string;
  servings: number;
  mealTypes: MealType[];
  dietTags: DietType[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: Difficulty;
  ingredients: AiDraftLine[];
  steps: string[];
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
    const servings = req.servings ?? 2;
    const allergens = new Set((profile.preferences?.allergens ?? []) as string[]);
    const excludedIds = new Set(profile.preferences?.excludedIngredientIds ?? []);

    // Curated catalogue, filtered by the user's constraints and capped to keep
    // the prompt small enough for cheap models. Names are unique in the DB so
    // we ask the AI to return names; we resolve back to ids server-side.
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

    const prompt = buildDraftPrompt({
      userPrompt: req.prompt,
      mealType: req.mealType,
      dietType,
      servings,
      catalogue,
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
      throw new ServiceUnavailableException({
        error: 'AI_UNAVAILABLE',
        message: 'AI is unavailable — try again or configure a provider.',
      });
    }

    const payload = parseDraftPayload(text);
    if (!payload) {
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

    const created = await this.prisma.recipe.create({
      data: {
        title: payload.title,
        description: payload.description,
        servings: payload.servings,
        mealTypes: payload.mealTypes,
        dietTags: payload.dietTags,
        steps: payload.steps,
        prepMinutes: payload.prepMinutes,
        cookMinutes: payload.cookMinutes,
        difficulty: payload.difficulty,
        allergens: recipeAllergens as Allergen[],
        origin: 'ai',
        createdByUserId: userId,
        caloriesPerServing: perServing.calories,
        proteinPerServing: perServing.protein,
        fatPerServing: perServing.fat,
        carbsPerServing: perServing.carbs,
        ingredients: {
          create: resolved.map((r) => ({
            ingredientId: r.ingredientId,
            quantity: r.quantity,
            unit: r.unit,
            note: r.note,
          })),
        },
      },
      include: {
        ingredients: {
          include: { ingredient: { include: this.translationsInclude(locale) } },
        },
        ...this.translationsInclude(locale),
      },
    });

    if (req.addToFavorites) {
      await this.prisma.favorite.upsert({
        where: { profileId_recipeId: { profileId: profile.id, recipeId: created.id } },
        create: {
          profileId: profile.id,
          recipeId: created.id,
          tags: ['ai-drafted'],
          sentiment: 'favorite',
        },
        update: { tags: ['ai-drafted'] },
      });
    }

    const recipe = toRecipeDto(created, locale);
    this.writeSidecar(userId, recipe, { prompt: req.prompt, aiMeta: meta });

    return { recipe, aiMeta: meta };
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
    extra: { prompt: string; aiMeta: AiDraftRecipeResponse['aiMeta'] },
  ): void {
    try {
      const raw = this.config.get('INSTANCE_DATA_DIR', { infer: true }) ?? 'instance-data';
      const root = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
      const path = join(root, 'user-recipes', userId, `${recipe.id}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify(
          { ...recipe, draftedAt: new Date().toISOString(), prompt: extra.prompt, aiMeta: extra.aiMeta },
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

function buildDraftPrompt(input: {
  userPrompt: string;
  mealType?: MealType;
  dietType: DietType;
  servings: number;
  catalogue: { id: string; name: string; category: string; caloriesPer100: number; proteinPer100: number }[];
}): { system: string; user: string } {
  const lines = input.catalogue.map(
    (c) => `- ${c.name} (${c.category}, ${Math.round(c.caloriesPer100)} kcal/100g · ${Math.round(c.proteinPer100)} g protein)`,
  );

  const system =
    'You draft cooking recipes for a deterministic meal-planning app. ' +
    'You ONLY pick from the ingredient catalogue provided — never invent ' +
    'ingredients, never propose substitutions. You never write or estimate ' +
    'calories, protein, fat, or carbs; the app recomputes those from the ' +
    'catalogue values. ' +
    'Respond with valid JSON exactly matching this shape — no prose, no ' +
    'markdown fences, no extra keys:\n' +
    '{"title":string,"description":string,"servings":int,' +
    '"mealTypes":string[],"dietTags":string[],"prepMinutes":int,' +
    '"cookMinutes":int,"difficulty":"easy"|"medium"|"hard",' +
    '"ingredients":[{"ingredientName":string,"quantity":number,' +
    '"unit":"g"|"ml"|"piece","note":string|null}],"steps":string[]}';

  const user = [
    `User prompt: ${input.userPrompt}`,
    `Target diet type: ${input.dietType}`,
    input.mealType ? `Target meal type: ${input.mealType}` : null,
    `Target servings: ${input.servings}`,
    '',
    'Constraints:',
    '1. Pick 3-12 ingredients from the catalogue below (use the exact name).',
    '2. Quantity > 0; unit is g, ml or piece — match the ingredient\'s natural form.',
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
function parseDraftPayload(text: string): AiDraftPayload | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const candidates: string[] = [];
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);
  candidates.push(trimmed);
  for (const c of candidates) {
    try {
      const raw = JSON.parse(c) as unknown;
      const normalised = normalise(raw);
      if (normalised) return normalised;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function normalise(raw: unknown): AiDraftPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const title = strField(o.title);
  const description = strField(o.description);
  const servings = intField(o.servings, 1, 12);
  const prepMinutes = intField(o.prepMinutes, 0, 480);
  const cookMinutes = intField(o.cookMinutes, 0, 480);
  if (!title || !description || servings == null || prepMinutes == null || cookMinutes == null) {
    return null;
  }
  const difficulty = ALLOWED_DIFFICULTIES.includes(o.difficulty as Difficulty)
    ? (o.difficulty as Difficulty)
    : null;
  if (!difficulty) return null;

  const mealTypes = arrField(o.mealTypes, (v) => (ALLOWED_MEALS.includes(v) ? (v as MealType) : null));
  const dietTags = arrField(o.dietTags, (v) => (ALLOWED_DIETS.includes(v) ? (v as DietType) : null));
  if (mealTypes.length === 0 || dietTags.length === 0) return null;

  const steps = arrField(o.steps, (v) => (v.trim().length > 0 ? v.trim() : null));
  if (steps.length < 2 || steps.length > 20) return null;

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
    title,
    description,
    servings,
    mealTypes,
    dietTags,
    prepMinutes,
    cookMinutes,
    difficulty,
    ingredients,
    steps,
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

