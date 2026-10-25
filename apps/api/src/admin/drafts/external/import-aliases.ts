// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The other names of the catalogue's ingredients: a file of the data
 * directory that says which ingredient a name in somebody else's recipe
 * means, where the catalogue's own names do not say it.
 *
 *   { "courgette": "zucchini", "prawns": "shrimp" }
 *
 * A name is given in any form a recipe might write it in; it is compared in
 * its plain form (`slug-mapper.ts`). The file is no part of the catalogue: an
 * update of the database does not read it, and a change to it changes no
 * recipe that exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const IMPORT_ALIASES_FILE = 'import-aliases.json';

/**
 * The aliases of the directory, and what is wrong with the file. No file is
 * no alias and nothing wrong. With `slugs`, an alias for an ingredient the
 * catalogue does not have is named: it would never be used.
 */
export function readImportAliases(
  dataDir: string,
  slugs?: ReadonlySet<string>,
): { aliases: Record<string, string>; problems: string[] } {
  const path = join(dataDir, IMPORT_ALIASES_FILE);
  if (!existsSync(path)) return { aliases: {}, problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { aliases: {}, problems: [`invalid JSON: ${(err as Error).message}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return {
      aliases: {},
      problems: ['expected an object of names, each with the slug of an ingredient'],
    };

  const aliases: Record<string, string> = {};
  const problems: string[] = [];
  for (const [name, slug] of Object.entries(parsed)) {
    if (typeof slug !== 'string' || slug === '')
      problems.push(`"${name}": expected the slug of an ingredient`);
    else if (slugs && !slugs.has(slug))
      problems.push(`"${name}": the catalogue has no ingredient "${slug}"`);
    else aliases[name] = slug;
  }
  return { aliases, problems };
}
