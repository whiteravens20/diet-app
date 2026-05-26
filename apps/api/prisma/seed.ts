/**
 * CLI entrypoint for the curated-DB seeder — `npm run db:seed`.
 *
 * The same logic also powers `POST /api/admin/db/update` in the running app
 * (see `src/admin/seed/seeder.ts`). This file just wires a standalone Prisma
 * client to the shared seeder so an operator can populate a fresh DB from a
 * shell without going through the admin panel.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { runSeed } from '../src/admin/seed/seeder.js';

// Load the repo-root .env for local runs; containers inject the env directly.
try {
  process.loadEnvFile('../../.env');
} catch {
  /* environment already provided */
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

runSeed(prisma)
  .then((counts) => {
    console.log(
      `Seed complete: ${counts.ingredients} ingredients, ` +
        `${counts.recipes} recipes (${counts.anchorRecipes} anchor + ${counts.composedRecipes} composed), ` +
        `${counts.substitutions} substitutions.`,
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
