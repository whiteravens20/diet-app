// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The traits of recipe drafts as their ingredients and titles suggest them,
 * read with today's catalogue: what a draft without traits is taken for, and
 * what the drafts written before drafts had traits are given once.
 */
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DishTraits, type Unit } from '@diet-app/shared';
import { proposeTraits, traitsOf } from '../../engine/dish-traits.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { localeMap } from './drafts.mapper.js';

type RecipeLine = { slug: string; quantity: number; unit: Unit };

/** A draft as far as its proposed traits go: its titles and its ingredient lines. */
interface Proposable {
  id: string;
  titles: Prisma.JsonValue;
  ingredientsJson: Prisma.JsonValue;
}

/** The traits each draft's ingredients and titles suggest, by its id: one read of the catalogue for all of them. */
async function proposedTraitsOf(
  db: Pick<Prisma.TransactionClient, 'ingredient'>,
  drafts: readonly Proposable[],
): Promise<Map<string, DishTraits>> {
  if (drafts.length === 0) return new Map();
  const slugs = new Set(
    drafts.flatMap((draft) => (draft.ingredientsJson as RecipeLine[]).map((line) => line.slug)),
  );
  const rows = await db.ingredient.findMany({
    where: { slug: { in: [...slugs] } },
    select: {
      slug: true,
      name: true,
      category: true,
      caloriesPer100: true,
      canonicalUnit: true,
      gramsPerPiece: true,
      density: true,
    },
  });
  const bySlug = new Map(rows.map((row) => [row.slug!, row]));
  return new Map(
    drafts.map((draft) => [
      draft.id,
      proposeTraits(
        Object.values(localeMap(draft.titles)),
        (draft.ingredientsJson as RecipeLine[]).flatMap((line) => {
          const ingredient = bySlug.get(line.slug);
          return ingredient
            ? [
                {
                  quantity: line.quantity,
                  unit: line.unit,
                  ingredient: { ...ingredient, canonicalUnit: ingredient.canonicalUnit as Unit },
                },
              ]
            : [];
        }),
      ),
    ]),
  );
}

/**
 * A draft's traits as it is read: those set on it, each it lacks (or has one
 * no longer known) as its ingredients and titles suggest, the catalogue read
 * only then.
 */
export async function draftTraitsOf(
  db: Pick<Prisma.TransactionClient, 'ingredient'>,
  draft: Proposable & { taste: string | null; form: string | null; starchBase: string | null },
): Promise<DishTraits> {
  const complete = DishTraits.safeParse({
    taste: draft.taste,
    form: draft.form,
    starchBase: draft.starchBase,
  }).success;
  const proposed = complete ? null : (await proposedTraitsOf(db, [draft])).get(draft.id)!;
  return traitsOf(draft, () => proposed!);
}

/**
 * The drafts not shipped yet that have no traits, written before drafts had
 * them, are given those their ingredients and titles suggest, once, when the
 * application starts: the administrator sees them and approves or corrects
 * them as those of any draft. A trait set meanwhile is never written over, and
 * a start that finds none to give writes nothing.
 */
@Injectable()
export class DraftTraitsFill implements OnApplicationBootstrap {
  private readonly logger = new Logger('Drafts');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const filled = await this.fill();
      if (filled > 0) {
        this.logger.log(`Gave ${filled} drafts the traits their ingredients and titles suggest.`);
      }
    } catch (err) {
      // A start goes on without it: such a draft is read with the same traits meanwhile.
      this.logger.error(`Could not give drafts their traits: ${String(err)}`);
    }
  }

  /** Writes the proposed traits into every draft not shipped that has none; answers how many it wrote. */
  async fill(): Promise<number> {
    const drafts = await this.prisma.recipeDraft.findMany({
      where: { status: { not: 'SHIPPED' }, taste: null, form: null, starchBase: null },
      select: { id: true, titles: true, ingredientsJson: true },
    });
    const proposed = await proposedTraitsOf(this.prisma, drafts);
    let filled = 0;
    for (const [id, traits] of proposed) {
      const written = await this.prisma.recipeDraft.updateMany({
        where: { id, taste: null, form: null, starchBase: null },
        data: traits,
      });
      filled += written.count;
    }
    return filled;
  }
}
