/**
 * Prisma 7 configuration. The connection URL lives here (for Migrate) and is
 * also passed to PrismaClient via the pg adapter — Prisma 7 no longer accepts
 * `url` in the schema. Read straight from the environment so `prisma generate`
 * (which needs no database) still works when DATABASE_URL is unset.
 */
import { defineConfig } from 'prisma/config';

// Load the repo-root .env for local CLI runs (Migrate / Studio). In CI and
// containers the environment is already populated, so a missing file is fine.
try {
  process.loadEnvFile('../../.env');
} catch {
  /* environment already provided */
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    // Optional shadow DB for `prisma migrate diff` / `migrate dev` in non-
    // interactive mode (e.g. CI). When unset, `migrate dev` still works
    // interactively because it creates its own shadow DB transiently.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
