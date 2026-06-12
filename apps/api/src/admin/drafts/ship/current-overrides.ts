/**
 * Rebuilds the full `ingredient-overrides.json` shape from the live DB.
 *
 * Unlike the ship runners (which operate on draft *status* — approved rows
 * become shipped and then disappear from the queue), this reads the
 * authoritative current state: every `IngredientTranslation` row with
 * `source = 'MANUAL'`, grouped by ingredient slug. That covers everything an
 * operator has shipped locally (plus any curated overrides applied by the
 * seeder), regardless of whether the sidecar file was ever written.
 *
 * Used by the "download current overrides" and "push current overrides to a
 * repo" admin actions, so the operator can lift the accumulated override set
 * into another instance or a repo at any time — not just at ship time.
 */
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { IngredientOverrideFile } from './ingredient-overrides.writer.js';

/** Query all MANUAL ingredient translations and fold them into the slug-keyed
 *  override file shape. Keys are sorted for stable, diff-friendly output. */
export async function buildCurrentIngredientOverrides(
  prisma: PrismaService,
): Promise<IngredientOverrideFile> {
  const rows = await prisma.ingredientTranslation.findMany({
    where: { source: 'MANUAL' },
    select: {
      locale: true,
      name: true,
      storageHint: true,
      ingredient: { select: { slug: true } },
    },
    orderBy: [{ ingredientId: 'asc' }, { locale: 'asc' }],
  });

  const file: Record<
    string,
    { name: Record<string, string>; storageHint?: Record<string, string> }
  > = {};
  for (const r of rows) {
    const slug = r.ingredient?.slug;
    if (!slug || !r.name) continue;
    const entry = (file[slug] ??= { name: {} });
    entry.name[r.locale] = r.name;
    if (r.storageHint) {
      (entry.storageHint ??= {})[r.locale] = r.storageHint;
    }
  }

  const sorted = Object.fromEntries(
    Object.entries(file)
      .filter(([, e]) => Object.keys(e.name).length > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return sorted as IngredientOverrideFile;
}
