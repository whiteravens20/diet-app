// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Taking recipes in from a document the operator has.
 *
 * Each recipe of the document is resolved against the catalogue: every line
 * of its ingredient list read as an amount of an ingredient the catalogue
 * has, its figures worked out by the engine, its text held to the rules of
 * every recipe. One that resolves becomes a draft in the curation queue, in
 * English, with where it is from and the licence it may be passed on under;
 * people review it like any other draft, and it gets its other languages
 * from the run that fills them. One that does not resolve is refused, with
 * every reason named, and never reaches a reviewer: the refusal is kept for
 * the administrator to look through.
 *
 * No model has a part in this, and nothing is fetched: the instance reads
 * what it is handed.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MOST_RECIPES_PER_IMPORT, WebAddress, type ImportRejection, type MealType, type RecipeImportRequest, type RecipeImportResult, type StoredImportRejection } from '@diet-app/shared';
import { recipeFacts, type RecipeFacts } from '../../../engine/recipe-facts.js';
import { UnitConversionError } from '../../../engine/units.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { checkRecipe } from '../../../recipes/recipe-rules.js';
import { resolveDataDir } from '../../seed/data-hash.js';
import { slugify } from '../../seed/catalogue.js';
import { computeFingerprint } from '../fingerprint.js';
import { classifyComplexity } from '../recipe-generator.complexity.js';
import type { ExternalRecipe } from './external-recipe.js';
import { IMPORT_ALIASES_FILE, readImportAliases } from './import-aliases.js';
import { parseIngredientLine, type LineProblem } from './ingredient-line.js';
import { schemaOrgRecipes } from './schema-org.adapter.js';
import { slugMapper, type SlugMapper } from './slug-mapper.js';

/** How many rejections are kept: the latest, the oldest going first. */
const REJECTIONS_KEPT = 500;

/** How much is said of one refused recipe: so many reasons, and so much of what each is about. */
const MOST_REASONS = 25;
const MOST_OF_A_REASON = 160;
const MOST_OF_A_TITLE = 200;

/** A refusal as it is answered and kept: of a length, however long the recipe it is about. */
function refusal(recipe: ExternalRecipe, request: RecipeImportRequest, reasons: readonly string[]): ImportRejection {
  const said = reasons.slice(0, MOST_REASONS).map((reason) => (reason.length > MOST_OF_A_REASON ? `${reason.slice(0, MOST_OF_A_REASON)}…` : reason));
  if (reasons.length > MOST_REASONS) said.push(`more-reasons: ${reasons.length - MOST_REASONS}`);
  return { title: (recipe.title || '(no title)').slice(0, MOST_OF_A_TITLE), sourceUrl: addressOf(recipe.url) ?? request.sourceUrl ?? null, reasons: said };
}

/** The document a text holds: JSON that can hold recipes is an object or a list. */
function documentOf(text: string): object {
  let document: unknown = null;
  try {
    document = JSON.parse(text);
  } catch {
    // No JSON at all, or lists within lists beyond what the parser follows: no document either way.
  }
  if (typeof document !== 'object' || document === null) {
    throw new BadRequestException({ error: 'IMPORT_NOT_JSON', message: 'The document is not JSON that can hold recipes: an object or a list.' });
  }
  return document;
}

/** What a source files a recipe under, and the meals of the application it then is for. */
const MEALS_BY_CATEGORY: Record<string, MealType[]> = {
  breakfast: ['breakfast'],
  brunch: ['breakfast'],
  lunch: ['lunch'],
  dinner: ['dinner'],
  supper: ['dinner'],
  'main course': ['lunch', 'dinner'],
  'main dish': ['lunch', 'dinner'],
  main: ['lunch', 'dinner'],
  entree: ['lunch', 'dinner'],
  snack: ['snack'],
  appetizer: ['snack'],
  starter: ['snack'],
};

const LINE_RULE: Record<LineProblem, string> = {
  'no-quantity': 'line-without-amount',
  'range-for-quantity': 'line-with-a-range',
  'unknown-unit': 'line-with-unknown-unit',
  'no-name': 'line-without-name',
};

type Ingredient = Awaited<ReturnType<RecipeImportService['catalogue']>>[number];

/** A recipe that resolved: what its draft holds. */
interface Resolved {
  title: string;
  slug: string;
  fingerprint: string;
  data: {
    titles: { en: string };
    descriptions: { en: string };
    steps: { en: string[] };
    servings: number;
    mealTypes: MealType[];
    prepMinutes: number;
    cookMinutes: number;
    difficulty: 'easy' | 'medium' | 'hard';
    complexity: string;
    ingredientsJson: { slug: string; quantity: number; unit: 'g' | 'ml' | 'piece'; note: string | null }[];
    facts: RecipeFacts;
    provenanceUrl: string | null;
    provenanceLicense: string;
  };
}

@Injectable()
export class RecipeImportService {
  private readonly logger = new Logger(RecipeImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  async import(request: RecipeImportRequest): Promise<RecipeImportResult> {
    const found = schemaOrgRecipes.read(documentOf(request.document));
    // The first of a document are looked at. Of the others it is said how many there were, and nothing is kept.
    const taken = found.slice(0, MOST_RECIPES_PER_IMPORT);
    const catalogue = await this.catalogue();
    const bySlug = new Map(catalogue.map((ingredient) => [ingredient.slug!, ingredient]));
    const slugOf = slugMapper(
      catalogue.map((ingredient) => ({ slug: ingredient.slug!, names: [ingredient.name, ...ingredient.translations.map((translation) => translation.name)] })),
      this.aliases(),
    );
    const held = await this.held();

    const drafted: Resolved[] = [];
    const rejected: ImportRejection[] = [];
    for (const recipe of taken) {
      const outcome = this.resolve(recipe, request, slugOf, bySlug, held);
      if ('reasons' in outcome) rejected.push(refusal(recipe, request, outcome.reasons));
      else {
        drafted.push(outcome);
        // What this import drafts is taken for the recipes after it in the same document.
        held.slugs.add(outcome.slug);
        held.titles.add(outcome.title.toLowerCase());
        held.makings.set(outcome.fingerprint, outcome.slug);
      }
    }

    const result = { found: found.length, drafted: drafted.map(({ slug, title }) => ({ slug, title })), rejected, dryRun: request.dryRun };
    if (request.dryRun) return { ...result, batchId: null };

    const batchId = `imp-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    await this.prisma.$transaction(async (tx) => {
      for (const { slug, data } of drafted) {
        const { facts, ...draft } = data;
        await tx.recipeDraft.create({
          data: {
            ...draft,
            slug,
            locales: ['en'],
            dietTags: facts.dietTags,
            caloriesPerServing: facts.perServing.calories,
            proteinPerServing: facts.perServing.protein,
            fatPerServing: facts.perServing.fat,
            carbsPerServing: facts.perServing.carbs,
            allergens: facts.allergens,
            source: 'EXTERNAL',
            batchId,
            generatorPrompt: schemaOrgRecipes.name,
          },
        });
      }
      if (rejected.length > 0) await tx.recipeImportRejection.createMany({ data: rejected.map((rejection) => ({ ...rejection, batchId })) });
      // The latest are kept; what an import of long ago refused is of no use to anybody.
      const oldest = await tx.recipeImportRejection.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: REJECTIONS_KEPT, select: { id: true } });
      if (oldest.length > 0) await tx.recipeImportRejection.deleteMany({ where: { id: { in: oldest.map((row) => row.id) } } });
    });
    return { ...result, batchId };
  }

  /** The rejections that are kept, the latest first. */
  async rejections(): Promise<StoredImportRejection[]> {
    const rows = await this.prisma.recipeImportRejection.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: REJECTIONS_KEPT });
    return rows.map((row) => ({ id: row.id, batchId: row.batchId, title: row.title, sourceUrl: row.sourceUrl, reasons: row.reasons, createdAt: row.createdAt.toISOString() }));
  }

  /** Forget the rejections that are kept. */
  async clearRejections(): Promise<void> {
    await this.prisma.recipeImportRejection.deleteMany();
  }

  /** One recipe of the document as a draft, or every reason it is none. */
  private resolve(
    recipe: ExternalRecipe,
    request: RecipeImportRequest,
    slugOf: SlugMapper,
    bySlug: ReadonlyMap<string, Ingredient>,
    held: { slugs: Set<string>; titles: Set<string>; makings: Map<string, string> },
  ): Resolved | { reasons: string[] } {
    const reasons: string[] = [];
    if (recipe.title === '') reasons.push('no-title');
    if (recipe.steps.length === 0) reasons.push('no-steps');
    if (recipe.ingredientLines.length === 0) reasons.push('no-ingredients');
    if (recipe.servings === null) reasons.push('no-servings');
    if (recipe.prepMinutes === null && recipe.cookMinutes === null) reasons.push('no-times');
    const license = recipe.license ?? request.license ?? null;
    if (license === null) reasons.push('no-licence');
    const mealTypes = [...new Set(recipe.categories.flatMap((category) => MEALS_BY_CATEGORY[category] ?? []))];
    const meals = mealTypes.length > 0 ? mealTypes : (request.mealTypes ?? []);
    if (meals.length === 0) reasons.push('no-meal');

    const lines: Resolved['data']['ingredientsJson'] = [];
    for (const text of recipe.ingredientLines) {
      const parsed = parseIngredientLine(text);
      if (!parsed.ok) {
        reasons.push(`${LINE_RULE[parsed.problem]}: ${text}`);
        continue;
      }
      const slug = slugOf(parsed.line.name);
      if (slug === null) reasons.push(`unknown-ingredient: ${parsed.line.name}`);
      else lines.push({ slug, quantity: parsed.line.quantity, unit: parsed.line.unit, note: null });
    }
    if (reasons.length > 0 || license === null || recipe.servings === null) return { reasons };

    let facts: RecipeFacts;
    try {
      facts = recipeFacts(lines.map((line) => ({ quantity: line.quantity, unit: line.unit, ingredient: bySlug.get(line.slug)! })), recipe.servings);
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      return { reasons: [`unit-not-convertible: ${err.message}`] };
    }

    const prepMinutes = recipe.prepMinutes ?? 0;
    const cookMinutes = recipe.cookMinutes ?? 0;
    const checked = checkRecipe(
      { titles: { en: recipe.title }, descriptions: { en: recipe.description || recipe.title }, steps: { en: recipe.steps }, servings: recipe.servings, mealTypes: meals, prepMinutes, cookMinutes, difficulty: 'easy', ingredients: lines },
      ['en'],
    );
    if (!checked.ok) return { reasons: [`invalid-draft: ${checked.problems.map((problem) => `${problem.path}: ${problem.rule}`).join('; ')}`] };
    const sound = checked.recipe;

    const title = sound.titles.en!;
    const fingerprint = computeFingerprint({ ingredients: sound.ingredients, mealTypes: sound.mealTypes, servings: sound.servings });
    if (held.titles.has(title.toLowerCase())) return { reasons: [`title-taken: ${title}`] };
    const twin = held.makings.get(fingerprint);
    if (twin !== undefined) return { reasons: [`same-making-as: ${twin}`] };

    const complexity = classifyComplexity({ ingredientCount: sound.ingredients.length, stepCount: sound.steps.en!.length, totalMinutes: prepMinutes + cookMinutes }) ?? 'medium';
    return {
      title,
      slug: freeSlug(slugify(title) || 'imported-recipe', held.slugs),
      fingerprint,
      data: {
        titles: { en: title },
        descriptions: { en: sound.descriptions.en! },
        steps: { en: sound.steps.en! },
        servings: sound.servings,
        mealTypes: sound.mealTypes,
        prepMinutes,
        cookMinutes,
        // A source says nothing of how hard a recipe is; how much there is to it is what there is to go by.
        difficulty: complexity === 'simple' ? 'easy' : complexity === 'complex' ? 'hard' : 'medium',
        complexity,
        ingredientsJson: sound.ingredients,
        facts,
        provenanceUrl: addressOf(recipe.url) ?? request.sourceUrl ?? null,
        provenanceLicense: license.slice(0, 200),
      },
    };
  }

  /** The ingredients a recipe may be made of, with what each can be called in English. */
  private catalogue() {
    return this.prisma.ingredient.findMany({
      where: { retiredAt: null, slug: { not: null } },
      select: {
        slug: true,
        name: true,
        canonicalUnit: true,
        gramsPerPiece: true,
        density: true,
        caloriesPer100: true,
        proteinPer100: true,
        fatPer100: true,
        carbsPer100: true,
        allergens: true,
        dietCompatibility: true,
        translations: { where: { locale: 'en' }, select: { name: true } },
      },
    });
  }

  /** The slugs, titles and makings that are taken: by the shared recipes and by the drafts that wait. */
  private async held(): Promise<{ slugs: Set<string>; titles: Set<string>; makings: Map<string, string> }> {
    const [recipes, drafts] = await Promise.all([
      this.prisma.recipe.findMany({ where: { OR: [{ slug: { not: null } }, { createdByUserId: null, deletedAt: null, retiredAt: null }] }, select: { slug: true, title: true, fingerprint: true, createdByUserId: true, deletedAt: true, retiredAt: true } }),
      this.prisma.recipeDraft.findMany({ where: { status: { in: ['PENDING', 'APPROVED'] } }, select: { slug: true, titles: true, ingredientsJson: true, mealTypes: true, servings: true } }),
    ]);
    const slugs = new Set<string>();
    const titles = new Set<string>();
    const makings = new Map<string, string>();
    for (const recipe of recipes) {
      // A slug is one recipe's among all of them; a title and a making among the shared ones people are given.
      if (recipe.slug) slugs.add(recipe.slug);
      if (recipe.createdByUserId !== null || recipe.deletedAt !== null || recipe.retiredAt !== null) continue;
      titles.add(recipe.title.toLowerCase());
      if (recipe.fingerprint) makings.set(recipe.fingerprint, recipe.slug ?? recipe.title);
    }
    for (const draft of drafts) {
      slugs.add(draft.slug);
      const title = (draft.titles as { en?: unknown } | null)?.en;
      if (typeof title === 'string') titles.add(title.toLowerCase());
      const lines = Array.isArray(draft.ingredientsJson) ? (draft.ingredientsJson as { slug: string; quantity: number; unit: 'g' | 'ml' | 'piece' }[]) : [];
      if (lines.length > 0) makings.set(computeFingerprint({ ingredients: lines, mealTypes: draft.mealTypes as MealType[], servings: draft.servings }), draft.slug);
    }
    return { slugs, titles, makings };
  }

  /** The operator's other names for ingredients: those of the file that are sound. What is wrong with the file is said in the log. */
  private aliases(): Record<string, string> {
    const { aliases, problems } = readImportAliases(resolveDataDir());
    for (const problem of problems) this.logger.warn(`${IMPORT_ALIASES_FILE}: ${problem}`);
    return aliases;
  }
}

/** An address a recipe gave for itself, when it is one the contract takes: of the web, and of a length. */
const addressOf = (url: string | null): string | null => (WebAddress.safeParse(url).success ? url : null);

/** `slug`, or the first of `slug-2`, `slug-3`, … that nothing has. */
function freeSlug(slug: string, taken: ReadonlySet<string>): string {
  const base = slug.slice(0, 180);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
