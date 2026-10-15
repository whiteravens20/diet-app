// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The published contract (`docs/api/`) is what the API says now: the four
 * files are what `npm run contract` would write, every route declares what it
 * answers with and says what it does, and the description holds together.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_DIRECTORY, contractFiles } from '../../scripts/contract.js';
import { readRoutes, type Route } from '../../scripts/contract/routes.js';

describe('the published contract of the API', () => {
  let routes: Route[];
  let files: Record<string, string>;

  beforeAll(async () => {
    routes = await readRoutes();
    files = await contractFiles();
  }, 60_000);

  it.each(['openapi.json', 'routes.md', 'errors.md', 'errors.json'])('docs/api/%s is what `npm run contract` writes', (name) => {
    // A difference is a route, a schema, a comment above a handler or a text of the catalogue that changed: run the command and commit the result.
    expect(readFileSync(join(CONTRACT_DIRECTORY, name), 'utf8') === files[name], `docs/api/${name} is stale`).toBe(true);
  });

  it('has every route say what it does and who may ask', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.filter((route) => route.description === '').map((route) => `${route.controller}.${route.handler}`)).toEqual([]);
    // The four ways in: nobody's session, an account's, the administrator's, a reviewer's.
    expect(new Set(routes.map((route) => route.asks))).toEqual(new Set(['anyone', 'account', 'administrator', 'reviewer']));
  });

  it('has every route that answers with a body declare the schema of it', () => {
    // Without a declaration a route answers with no body: 204, or 202 for what is done later.
    const silent = routes.filter((route) => !route.answers && !route.answersWithAFile);
    expect(silent.filter((route) => route.status !== 204 && route.status !== 202).map((route) => `${route.method} ${route.path} answers ${route.status}`)).toEqual([]);
  });

  it('holds every value of a path and every query string to a check', () => {
    expect(routes.flatMap((route) => [...route.pathValues, ...route.queryValues].filter((value) => !value.schema).map((value) => `${route.method} ${route.path}: ${value.name}`))).toEqual([]);
  });

  it('describes every route once, with every schema it points at', () => {
    const document = JSON.parse(files['openapi.json']!) as {
      paths: Record<string, Record<string, { operationId: string; parameters?: { name: string; in: string }[] }>>;
      components: { schemas: Record<string, unknown> };
    };
    const operations = Object.entries(document.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ path, method, operation })));
    expect(operations).toHaveLength(routes.length);
    expect(new Set(operations.map(({ operation }) => operation.operationId)).size).toBe(operations.length);

    const pointedAt = new Set([...files['openapi.json']!.matchAll(/"#\/components\/schemas\/([A-Za-z0-9]+)"/g)].map(([, name]) => name!));
    expect([...pointedAt].filter((name) => !(name in document.components.schemas))).toEqual([]);
    expect(Object.keys(document.components.schemas).filter((name) => !pointedAt.has(name))).toEqual([]);

    // What a path names is a parameter of each of its operations.
    for (const { path, operation } of operations) {
      const named = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();
      expect((operation.parameters ?? []).filter((parameter) => parameter.in === 'path').map((parameter) => parameter.name).sort(), path).toEqual(named);
    }
  });
});
