// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Pulling the names of ingredients from an address the administrator types.
 * Two servers stand in for sources on the operator's own network: one whose
 * host the settings name, and one they do not.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../../testing/database.js';
import { asAdmin } from '../../../testing/factories.js';
import { createTestApp, type TestApp } from '../../../testing/test-app.js';

interface Source {
  server: Server;
  port: number;
  /** What the server does with the next request. */
  respond: (req: IncomingMessage, res: ServerResponse) => void;
  requests: IncomingMessage[];
}

async function aSource(): Promise<Source> {
  const source = {
    requests: [] as IncomingMessage[],
    respond: (_req: IncomingMessage, res: ServerResponse) => void res.end('{}'),
  } as Source;
  source.server = createServer((req, res) => {
    source.requests.push(req);
    source.respond(req, res);
  });
  await new Promise<void>((listening) => source.server.listen(0, '127.0.0.1', listening));
  source.port = (source.server.address() as AddressInfo).port;
  return source;
}

const json = (body: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('pulling the names of ingredients from an address', () => {
  let t: TestApp;
  let named: Source;
  let unnamed: Source;

  beforeAll(async () => {
    named = await aSource();
    unnamed = await aSource();
    t = await createTestApp({
      OVERRIDES_PULL_ALLOWED_HOSTS: `127.0.0.1:${named.port}`,
      OVERRIDES_PULL_TOKEN: 'a-token-for-github-only',
    });
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
    for (const source of [named, unnamed]) {
      source.server.closeAllConnections();
      await new Promise((closed) => source.server.close(closed));
    }
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    await t.prisma.ingredientTranslation.deleteMany({ where: { source: 'MANUAL' } });
    named.requests = [];
    unnamed.requests = [];
  });

  const pull = (source: string) =>
    t.http().post('/api/admin/drafts/ship/current-overrides/pull').set(asAdmin).send({ source });
  const manual = () =>
    t.prisma.ingredientTranslation.findMany({
      where: { source: 'MANUAL' },
      select: { locale: true, name: true },
      orderBy: { name: 'asc' },
    });

  it('is refused for an address that is not public, and the server there is never asked', async () => {
    for (const address of [
      `http://127.0.0.1:${unnamed.port}/overrides.json`,
      `http://localhost:${unnamed.port}/overrides.json`,
      `http://[::1]:${unnamed.port}/x.json`,
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      const res = await pull(address);
      expect([address, res.status, res.body.error]).toEqual([
        address,
        409,
        'PULL_ADDRESS_NOT_PUBLIC',
      ]);
    }
    expect(unnamed.requests).toHaveLength(0);
    expect(await manual()).toEqual([]);
  });

  it('fetches from a host the operator named, and stores the names as approved by people', async () => {
    named.respond = json({
      'chicken-breast': { name: { pl: ' Filet  z kurczaka ' }, storageHint: { pl: 'W lodówce.' } },
      'no-such-ingredient': { name: { pl: 'Nic' } },
    });

    const res = await pull(`http://127.0.0.1:${named.port}/overrides.json`).expect(201);

    expect(res.body).toMatchObject({
      total: 2,
      applied: 1,
      rowsWritten: 1,
      skippedSlugs: ['no-such-ingredient'],
      refused: [],
    });
    // Stored as a plain line, like a name that ships from the queue.
    expect(await manual()).toEqual([{ locale: 'pl', name: 'Filet z kurczaka' }]);
  });

  it('refuses an entry that breaks a rule for names, stores the rest, and says which', async () => {
    named.respond = json({
      salmon: { name: { pl: '<img src=x onerror=alert(1)>' } },
      banana: { name: { pl: 'B'.repeat(121) } },
      tomato: { name: { pl: 'Pomidor malinowy' } },
    });

    const res = await pull(`http://127.0.0.1:${named.port}/overrides.json`).expect(201);

    expect(res.body.applied).toBe(1);
    expect(res.body.refused).toEqual([
      { slug: 'salmon', reason: 'invalid-draft: name.pl: markup' },
      { slug: 'banana', reason: 'invalid-draft: name.pl: text-too-long' },
    ]);
    expect(await manual()).toEqual([{ locale: 'pl', name: 'Pomidor malinowy' }]);
  });

  it('does not follow a redirect to wherever it points', async () => {
    named.respond = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${unnamed.port}/overrides.json` });
      res.end();
    };
    unnamed.respond = json({ tomato: { name: { pl: 'Pomidor' } } });

    const res = await pull(`http://127.0.0.1:${named.port}/moved.json`);

    expect([res.status, res.body.error]).toEqual([409, 'PULL_FETCH_FAILED']);
    expect(unnamed.requests).toHaveLength(0);
    expect(await manual()).toEqual([]);
  });

  it('does not read a file that is too large, or one that is no override file', async () => {
    named.respond = json({ tomato: { name: { pl: 'P'.repeat(2_100_000) } } });
    const large = await pull(`http://127.0.0.1:${named.port}/large.json`);
    expect([large.status, large.body.error]).toEqual([409, 'PULL_FETCH_FAILED']);

    named.respond = json({ tomato: 'Pomidor' });
    const shapeless = await pull(`http://127.0.0.1:${named.port}/other.json`);
    expect([shapeless.status, shapeless.body.error]).toEqual([409, 'PULL_SHAPE_INVALID']);
    expect(await manual()).toEqual([]);
  });

  it("sends the token to no host but GitHub's", async () => {
    named.respond = json({});

    await pull(`http://127.0.0.1:${named.port}/overrides.json`).expect(201);

    expect(named.requests).toHaveLength(1);
    expect(named.requests[0]!.headers.authorization).toBeUndefined();
    expect(named.requests[0]!.headers['user-agent']).toBe('diet-app');
  });
});
