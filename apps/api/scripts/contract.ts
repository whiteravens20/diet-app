// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Writes the contract of the API into `docs/api/`: the OpenAPI description,
 * the list of routes and the list of the codes a request is refused with, as a
 * document to read and as data a client copies.
 *
 *   npm run contract            write the four files
 *   npm run contract -- --check say which of them is not what would be written, and fail if one is
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApiDocument, routesDocument } from './contract/document.js';
import { errorsData, errorsDocument, readErrorCodes } from './contract/errors.js';
import { readRoutes } from './contract/routes.js';

const ROOT = join(__dirname, '../../..');
export const CONTRACT_DIRECTORY = join(ROOT, 'docs/api');

/** The files of the contract as they would be written now: name → text. */
export async function contractFiles(): Promise<Record<string, string>> {
  const routes = await readRoutes();
  const codes = readErrorCodes();
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  return {
    'openapi.json': `${JSON.stringify(openApiDocument(routes, version), null, 2)}\n`,
    'routes.md': routesDocument(routes),
    'errors.md': errorsDocument(codes),
    'errors.json': errorsData(codes),
  };
}

async function main(): Promise<void> {
  const files = await contractFiles();
  if (process.argv.includes('--check')) {
    const stale = Object.entries(files).filter(([name, text]) => !existsSync(join(CONTRACT_DIRECTORY, name)) || readFileSync(join(CONTRACT_DIRECTORY, name), 'utf8') !== text);
    if (stale.length > 0) {
      console.error(`Not what \`npm run contract\` writes: ${stale.map(([name]) => `docs/api/${name}`).join(', ')}. Run it and commit the result.`);
      process.exit(1);
    }
    console.log('The contract in docs/api/ is what the API says now.');
    return;
  }
  mkdirSync(CONTRACT_DIRECTORY, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(CONTRACT_DIRECTORY, name), text);
  console.log(`Wrote ${Object.keys(files).map((name) => `docs/api/${name}`).join(', ')}.`);
}

if (require.main === module) void main();
