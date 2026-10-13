// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { statementForLog } from './prisma.service.js';

describe('a statement the database is slow over, on an instance told to say so', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ SLOW_QUERY_MS: '40' });
  });

  afterAll(async () => {
    await t.close();
  });

  it('is logged with how long it took and without its values, and a quick one is not', async () => {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await t.prisma.$queryRaw`SELECT pg_sleep(0.06)::text, ${'what a user typed'}::text`;
    await t.prisma.user.count();

    const lines = warned.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('A statement took'));
    warned.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^A statement took \d+ ms: SELECT pg_sleep\(0\.06\)::text, \$1::text$/);
    expect(Number(/took (\d+) ms/.exec(lines[0]!)![1])).toBeGreaterThanOrEqual(40);
    expect(lines[0]).not.toContain('what a user typed');
  });

  it('is written as one line of a length', () => {
    expect(statementForLog('SELECT "id"\n  FROM "User"\n  WHERE "id" = $1')).toBe('SELECT "id" FROM "User" WHERE "id" = $1');
    expect(statementForLog(`SELECT ${'"column", '.repeat(200)}1`)).toHaveLength(401);
  });
});
