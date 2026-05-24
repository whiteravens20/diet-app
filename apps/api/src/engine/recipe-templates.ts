/**
 * Deterministic recipe-template composition.
 *
 * The no-AI fallback needs a large, varied meal library. Rather than authoring
 * hundreds of recipes by hand, a small set of structural *templates* (e.g.
 * "protein + grain + vegetable bowl") is filled from the curated ingredient
 * database. Given the same database this always yields the same recipe set, so
 * the fallback is fully reproducible (PLAN.md: "recipe templates + database-
 * driven composition"). Hand-curated "anchor" recipes are seeded alongside.
 */
import type { DietType, MealType, ProductCategory, Unit } from '@diet-app/shared';

/** Ingredient metadata the composer needs — a subset of the full record. */
export interface ComposableIngredient {
  name: string;
  category: ProductCategory;
  tags: string[];
  dietCompatibility: DietType[];
}

/** A composed recipe, shaped to match the hand-authored anchor recipe seed. */
export interface ComposedRecipe {
  title: string;
  description: string;
  servings: number;
  mealTypes: MealType[];
  dietTags: DietType[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  ingredients: { name: string; quantity: number; unit: Unit }[];
  steps: string[];
}

/** A slot in a template: an ingredient role + the per-serving quantity (grams). */
interface Slot {
  role: string;
  match: (ing: ComposableIngredient) => boolean;
  grams: number;
}

interface Template {
  name: string;
  mealTypes: MealType[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: ComposedRecipe['difficulty'];
  /** First slot is the "hero" — every matching ingredient yields one recipe. */
  slots: Slot[];
  step: (picks: string[]) => string[];
}

// ── Role matchers ─────────────────────────────────────────────────────────────
const isAnimalProtein = (i: ComposableIngredient): boolean =>
  i.category === 'meat' || i.category === 'fish' || (i.category === 'dairy' && i.tags.includes('protein'));
const isPlantProtein = (i: ComposableIngredient): boolean =>
  i.category === 'legumes' || i.tags.includes('plant-protein');
const isAnyProtein = (i: ComposableIngredient): boolean => isAnimalProtein(i) || isPlantProtein(i);
const isGrain = (i: ComposableIngredient): boolean => i.category === 'grains';
const isVegetable = (i: ComposableIngredient): boolean => i.category === 'vegetables';
const isLeafy = (i: ComposableIngredient): boolean => i.tags.includes('leafy') || i.tags.includes('green');
const isFruit = (i: ComposableIngredient): boolean => i.category === 'fruits';
const isNut = (i: ComposableIngredient): boolean => i.category === 'nuts_seeds';
const isFat = (i: ComposableIngredient): boolean => i.category === 'fats_oils';
const isDairyProtein = (i: ComposableIngredient): boolean =>
  i.category === 'dairy' && i.tags.includes('protein');
const isBreakfastGrain = (i: ComposableIngredient): boolean =>
  i.category === 'grains' && i.tags.includes('breakfast');

const TEMPLATES: Template[] = [
  {
    name: 'power bowl',
    mealTypes: ['lunch', 'dinner'],
    prepMinutes: 10,
    cookMinutes: 20,
    difficulty: 'medium',
    slots: [
      { role: 'protein', match: isAnyProtein, grams: 150 },
      { role: 'grain', match: isGrain, grams: 65 },
      { role: 'vegetable', match: isVegetable, grams: 150 },
      { role: 'fat', match: isFat, grams: 12 },
    ],
    step: ([p, g, v]) => [
      `Cook the ${g?.toLowerCase()} according to package directions.`,
      `Season and cook the ${p?.toLowerCase()} until done.`,
      `Steam the ${v?.toLowerCase()} and assemble the bowl, finishing with a drizzle of oil.`,
    ],
  },
  {
    name: 'low-carb skillet',
    mealTypes: ['lunch', 'dinner'],
    prepMinutes: 8,
    cookMinutes: 18,
    difficulty: 'easy',
    slots: [
      { role: 'protein', match: isAnimalProtein, grams: 170 },
      { role: 'vegetable', match: isVegetable, grams: 160 },
      { role: 'vegetable2', match: isVegetable, grams: 120 },
      { role: 'fat', match: isFat, grams: 15 },
    ],
    step: ([p, v, v2]) => [
      `Heat the oil and sear the ${p?.toLowerCase()}.`,
      `Add the ${v?.toLowerCase()} and ${v2?.toLowerCase()}; cook until tender-crisp.`,
      'Season well and serve straight from the skillet.',
    ],
  },
  {
    name: 'hearty stew',
    mealTypes: ['lunch', 'dinner'],
    prepMinutes: 10,
    cookMinutes: 25,
    difficulty: 'easy',
    slots: [
      { role: 'legume', match: isPlantProtein, grams: 200 },
      { role: 'vegetable', match: isVegetable, grams: 150 },
      { role: 'vegetable2', match: isVegetable, grams: 120 },
      { role: 'fat', match: isFat, grams: 15 },
    ],
    step: ([l, v, v2]) => [
      `Soften the ${v?.toLowerCase()} and ${v2?.toLowerCase()} in the oil.`,
      `Add the ${l?.toLowerCase()} and water; simmer 20 minutes.`,
      'Season and serve hot.',
    ],
  },
  {
    name: 'breakfast bowl',
    mealTypes: ['breakfast'],
    prepMinutes: 5,
    cookMinutes: 6,
    difficulty: 'easy',
    slots: [
      { role: 'grain', match: isBreakfastGrain, grams: 60 },
      { role: 'fruit', match: isFruit, grams: 110 },
      { role: 'nut', match: isNut, grams: 20 },
      { role: 'dairy', match: isDairyProtein, grams: 150 },
    ],
    step: ([g, f, n]) => [
      `Cook the ${g?.toLowerCase()} until creamy.`,
      `Fold through the yogurt and sliced ${f?.toLowerCase()}.`,
      `Top with ${n?.toLowerCase()}.`,
    ],
  },
  {
    name: 'protein parfait',
    mealTypes: ['snack', 'second_breakfast'],
    prepMinutes: 4,
    cookMinutes: 0,
    difficulty: 'easy',
    slots: [
      { role: 'dairy', match: isDairyProtein, grams: 170 },
      { role: 'fruit', match: isFruit, grams: 100 },
      { role: 'nut', match: isNut, grams: 20 },
    ],
    step: ([d, f, n]) => [
      `Spoon the ${d?.toLowerCase()} into a glass.`,
      `Layer with the ${f?.toLowerCase()}.`,
      `Scatter ${n?.toLowerCase()} on top.`,
    ],
  },
  {
    name: 'stir-fry',
    mealTypes: ['lunch', 'dinner'],
    prepMinutes: 12,
    cookMinutes: 15,
    difficulty: 'medium',
    slots: [
      { role: 'protein', match: isAnyProtein, grams: 160 },
      { role: 'vegetable', match: isVegetable, grams: 150 },
      { role: 'vegetable2', match: isVegetable, grams: 110 },
      { role: 'grain', match: isGrain, grams: 60 },
    ],
    step: ([p, v, v2, g]) => [
      `Cook the ${g?.toLowerCase()}.`,
      `Stir-fry the ${p?.toLowerCase()} over high heat, then set aside.`,
      `Stir-fry the ${v?.toLowerCase()} and ${v2?.toLowerCase()}, return the protein and combine.`,
    ],
  },
  {
    name: 'fresh salad',
    mealTypes: ['lunch'],
    prepMinutes: 12,
    cookMinutes: 10,
    difficulty: 'easy',
    slots: [
      { role: 'leafy', match: isLeafy, grams: 80 },
      { role: 'protein', match: isAnyProtein, grams: 140 },
      { role: 'vegetable', match: isVegetable, grams: 120 },
      { role: 'fat', match: isFat, grams: 12 },
    ],
    step: ([l, p, v]) => [
      `Cook and slice the ${p?.toLowerCase()}.`,
      `Toss the ${l?.toLowerCase()} with the ${v?.toLowerCase()}.`,
      'Top with the protein and dress with oil.',
    ],
  },
  // Savoury — no fruit, no grain — so it composes for restrictive diets too
  // (keto, low_carb) where the fruit-based morning templates yield nothing.
  {
    name: 'savoury morning plate',
    mealTypes: ['breakfast', 'second_breakfast'],
    prepMinutes: 4,
    cookMinutes: 8,
    difficulty: 'easy',
    slots: [
      { role: 'protein', match: isAnimalProtein, grams: 120 },
      { role: 'vegetable', match: isVegetable, grams: 90 },
      { role: 'fat', match: isFat, grams: 10 },
    ],
    step: ([p, v, f]) => [
      `Warm the ${f?.toLowerCase()} in a pan.`,
      `Sauté the ${v?.toLowerCase()} until tender.`,
      `Add the ${p?.toLowerCase()} and cook through; serve hot.`,
    ],
  },
];

/** Diet tags shared by every picked ingredient — the recipe's compatibility. */
function intersectDiets(picks: ComposableIngredient[]): DietType[] {
  if (picks.length === 0) return [];
  return picks
    .map((p) => p.dietCompatibility)
    .reduce((acc, list) => acc.filter((d) => list.includes(d)));
}

/** Variants generated per (template, hero) — each rotates the supporting cast. */
const VARIANTS_PER_HERO = 3;

/**
 * Compose the full template-generated recipe set from the curated ingredient
 * database. Bounded and deterministic: for each (template, hero ingredient) a
 * few variants are produced by rotating the supporting cast. Recipes with
 * duplicate titles are dropped so the result is a clean, stable library.
 */
export function composeRecipes(ingredients: ComposableIngredient[]): ComposedRecipe[] {
  const recipes: ComposedRecipe[] = [];
  const seenTitles = new Set<string>();

  for (const tpl of TEMPLATES) {
    const heroSlot = tpl.slots[0]!;
    const heroes = ingredients.filter(heroSlot.match);
    const supportCandidates = tpl.slots.map((s) => ingredients.filter(s.match));

    heroes.forEach((hero, heroIndex) => {
      for (let variant = 0; variant < VARIANTS_PER_HERO; variant++) {
        const picks: ComposableIngredient[] = [hero];
        const lines: ComposedRecipe['ingredients'] = [
          { name: hero.name, quantity: heroSlot.grams, unit: 'g' },
        ];

        let skip = false;
        for (let s = 1; s < tpl.slots.length; s++) {
          const slot = tpl.slots[s]!;
          const candidates = supportCandidates[s]!.filter(
            (c) => !picks.some((p) => p.name === c.name),
          );
          if (candidates.length === 0) {
            skip = true;
            break;
          }
          const pick = candidates[(heroIndex + s + variant) % candidates.length]!;
          picks.push(pick);
          lines.push({ name: pick.name, quantity: slot.grams, unit: 'g' });
        }
        if (skip) continue;

        const diets = intersectDiets(picks);
        if (diets.length === 0) continue;

        const title = `${hero.name} & ${picks[1]!.name.toLowerCase()} ${tpl.name}`;
        if (seenTitles.has(title)) continue;
        seenTitles.add(title);

        recipes.push({
          title,
          description: `A ${tpl.name} built around ${hero.name.toLowerCase()} with ${picks
            .slice(1)
            .map((p) => p.name.toLowerCase())
            .join(', ')}.`,
          servings: 1,
          mealTypes: tpl.mealTypes,
          dietTags: diets,
          prepMinutes: tpl.prepMinutes,
          cookMinutes: tpl.cookMinutes,
          difficulty: tpl.difficulty,
          ingredients: lines,
          steps: tpl.step(picks.map((p) => p.name)),
        });
      }
    });
  }

  return recipes;
}
