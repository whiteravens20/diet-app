// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Which ingredients each way of writing names takes on. The panel's counts and
 * what a run then does are read here, so a button never promises another number
 * than the run works on, and no way of writing leaves two proposals for one
 * ingredient.
 */
import type { PrismaService } from '../../prisma/prisma.service.js';
import { INGREDIENT_NAMER_PROMPT_VERSION, type RefusedName } from './ingredient-namer.prompt.js';

/** An imported ingredient a run can name. */
export interface NameTarget {
  id: string;
  slug: string;
  rawDescription: string;
}

/** An ingredient of a draft that waits, and the draft as it stood when it was read. */
export interface WaitingName extends NameTarget {
  draftId: string;
  updatedAt: Date;
}

export interface NameQueue {
  /** Imported ingredients that never had a proposal. */
  missing: NameTarget[];
  /** Imported ingredients whose last proposal was rejected, with none in its place. */
  rejected: NameTarget[];
  /** Drafts of imported ingredients that wait, and that no person changed or approved in a language. */
  unapproved: WaitingName[];
  /** Drafts that wait for a decision. */
  pending: number;
  /** Approved, and not shipped yet. */
  approved: number;
}

/** Imported ingredients that are still in the catalogue: the only ones a run names. */
export async function importedIngredients(prisma: PrismaService): Promise<NameTarget[]> {
  const ingredients = await prisma.ingredient.findMany({
    where: { tags: { has: 'usda-imported' }, slug: { not: null }, retiredAt: null },
    select: { id: true, slug: true, name: true },
  });
  return ingredients
    .filter((i): i is { id: string; slug: string; name: string } => i.slug !== null)
    .map((i) => ({ id: i.id, slug: i.slug, rawDescription: i.name }));
}

export async function readNameQueue(prisma: PrismaService): Promise<NameQueue> {
  const imported = await importedIngredients(prisma);
  const drafts = await prisma.ingredientNameDraft.findMany({
    select: {
      id: true,
      ingredientSlug: true,
      status: true,
      generatorPrompt: true,
      editedAt: true,
      updatedAt: true,
      localeReviews: { where: { supersededAt: null, action: 'APPROVE' }, select: { id: true } },
    },
  });

  // A shipped name of an earlier prompt is no reason to leave an ingredient out,
  // since that prompt was improved on. One that waits is, whichever prompt wrote it.
  const live = new Set(
    drafts
      .filter(
        (draft) =>
          draft.status === 'PENDING' ||
          draft.status === 'APPROVED' ||
          (draft.status === 'SHIPPED' && draft.generatorPrompt === INGREDIENT_NAMER_PROMPT_VERSION),
      )
      .map((draft) => draft.ingredientSlug),
  );
  const refused = new Set(
    drafts.filter((draft) => draft.status === 'REJECTED').map((draft) => draft.ingredientSlug),
  );
  const importedBySlug = new Map(imported.map((ingredient) => [ingredient.slug, ingredient]));

  const unapproved: WaitingName[] = [];
  for (const draft of drafts) {
    const ingredient = importedBySlug.get(draft.ingredientSlug);
    if (!ingredient || draft.status !== 'PENDING') continue;
    if (draft.editedAt !== null || draft.localeReviews.length > 0) continue;
    unapproved.push({ ...ingredient, draftId: draft.id, updatedAt: draft.updatedAt });
  }

  return {
    missing: imported.filter((i) => !live.has(i.slug) && !refused.has(i.slug)),
    rejected: imported.filter((i) => !live.has(i.slug) && refused.has(i.slug)),
    unapproved,
    pending: drafts.filter((draft) => draft.status === 'PENDING').length,
    approved: drafts.filter((draft) => draft.status === 'APPROVED').length,
  };
}

/** The drafts of these ids that wait, for imported ingredients, as a run takes them on. */
export async function waitingNames(
  prisma: PrismaService,
  ids: readonly string[],
): Promise<WaitingName[]> {
  const imported = new Map((await importedIngredients(prisma)).map((i) => [i.slug, i]));
  const drafts = await prisma.ingredientNameDraft.findMany({
    where: { id: { in: [...ids] }, status: 'PENDING' },
    select: { id: true, ingredientSlug: true, updatedAt: true },
  });
  return drafts.flatMap((draft) => {
    const ingredient = imported.get(draft.ingredientSlug);
    return ingredient ? [{ ...ingredient, draftId: draft.id, updatedAt: draft.updatedAt }] : [];
  });
}

/** How many refused names of one ingredient the model is told, the newest first. */
const REFUSED_TOLD = 5;

/**
 * What the model is told it may not give again: for each ingredient its rejected
 * proposals, in the languages rejected, and the drafts this run takes the place of.
 */
export async function refusedNames(
  prisma: PrismaService,
  slugs: readonly string[],
  replacing: { ids: readonly string[]; reason?: string },
): Promise<Record<string, RefusedName[]>> {
  const rows = await prisma.ingredientNameDraft.findMany({
    where: {
      ingredientSlug: { in: [...slugs] },
      OR: [{ status: 'REJECTED' }, { id: { in: [...replacing.ids] } }],
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      ingredientSlug: true,
      suggestions: true,
      localeReviews: {
        where: { supersededAt: null, action: 'REJECT' },
        select: { locale: true, reason: true },
      },
    },
  });

  const replaced = new Set(replacing.ids);
  const told: Record<string, RefusedName[]> = {};
  for (const row of rows) {
    const names = (row.suggestions as { name?: Record<string, string> } | null)?.name ?? {};
    const refused: RefusedName = replaced.has(row.id)
      ? { name: names, reason: replacing.reason }
      : {
          name: Object.fromEntries(
            row.localeReviews.flatMap(({ locale }) =>
              names[locale] === undefined ? [] : [[locale, names[locale]]],
            ),
          ),
          reason: row.localeReviews.find(({ reason }) => reason)?.reason ?? undefined,
        };
    if (Object.keys(refused.name).length === 0) continue;
    const ofIngredient = (told[row.ingredientSlug] ??= []);
    if (ofIngredient.length < REFUSED_TOLD) ofIngredient.push(refused);
  }
  return told;
}
