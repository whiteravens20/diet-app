// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The database the integration tests run against.
 *
 * It is always a database of its own, named `diet_app_it`, on the server that
 * TEST_DATABASE_URL (or DATABASE_URL) points at. The name is fixed here and is
 * never taken from the environment: a URL that names a development database
 * only tells the tests which server to use, so they cannot empty it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export const TEST_DATABASE = 'diet_app_it';

/** The PostgreSQL of the development Compose file, used when no URL is given. */
const DEFAULT_SERVER_URL = 'postgresql://diet:diet@localhost:5432/postgres';

/** Tables the catalogue seed fills; everything else is created by users. */
const CATALOGUE_TABLES = [
  'Allergen',
  'Ingredient',
  'IngredientTranslation',
  'NutritionFact',
  'Recipe',
  'RecipeIngredient',
  'RecipeTranslation',
  'SeedMeta',
  'SubstitutionRule',
];

function serverUrl(): URL {
  return new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_SERVER_URL);
}

/** Connection string of the test database. */
export function testDatabaseUrl(): string {
  const url = serverUrl();
  url.pathname = `/${TEST_DATABASE}`;
  return url.toString();
}

/** The API package root: vitest runs from it, and the Prisma CLI needs it as its working directory. */
function apiRoot(): string {
  const root = process.cwd();
  if (!existsSync(join(root, 'prisma', 'schema.prisma'))) {
    throw new Error(`Integration tests must run from apps/api (no prisma/schema.prisma under ${root}).`);
  }
  return root;
}

/** Create the test database when it is missing, then bring it to the current schema. */
export async function prepareTestDatabase(): Promise<void> {
  const server = serverUrl();
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: server.toString() }) });
  try {
    const found = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${TEST_DATABASE}`;
    if (found.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${TEST_DATABASE}"`);
  } catch (cause) {
    throw new Error(
      `Integration tests need a PostgreSQL server at ${server.host}. Start the one in ` +
        'infra/docker-compose.dev.yml or point TEST_DATABASE_URL at another.',
      { cause },
    );
  } finally {
    await admin.$disconnect();
  }

  const root = apiRoot();
  const prismaCli = createRequire(join(root, 'package.json')).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}

async function truncateAllExcept(prisma: PrismaClient, kept: string[]): Promise<void> {
  const [{ name }] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (name !== TEST_DATABASE) {
    throw new Error(`Refusing to empty "${name}": the integration tests only reset "${TEST_DATABASE}".`);
  }
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const names = tables.map((t) => t.tablename).filter((t) => !kept.includes(t));
  if (names.length === 0) return;
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${names.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

/** Empty every table. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await truncateAllExcept(prisma, []);
}

/** Empty everything users create and keep the catalogue, so a test file seeds it once. */
export async function resetUserData(prisma: PrismaClient): Promise<void> {
  await truncateAllExcept(prisma, CATALOGUE_TABLES);
  await prisma.recipe.deleteMany({ where: { createdByUserId: { not: null } } });
}
