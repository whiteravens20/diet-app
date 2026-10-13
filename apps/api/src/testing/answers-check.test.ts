// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { StreamableFile, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnswersCheck, answersOutsideTheContract, fieldsThatDiffer } from './answers-check.js';

const Plan = z.object({ id: z.string(), days: z.array(z.object({ date: z.string(), target: z.number().default(2000) })), note: z.string().nullable() });

/** What a route with `schema` answering with `answer` leaves noted. */
async function notedFor(schema: z.ZodType | undefined, answer: unknown): Promise<string[]> {
  const check = new AnswersCheck({ get: () => schema } as unknown as Reflector);
  const context = { getHandler: () => () => undefined, switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/api/plans/1', route: { path: '/api/plans/:id' } }) }) } as unknown as ExecutionContext;
  await lastValueFrom(check.intercept(context, { handle: () => of(answer) } as CallHandler));
  return answersOutsideTheContract();
}

describe('what an answer and its schema differ in', () => {
  it('names a field the schema does not, and one the schema has and the answer lacks, wherever they are', () => {
    expect(fieldsThatDiffer({ id: 'a', days: [{ date: 'x', kcal: 1 }], secret: 1 }, { id: 'a', days: [{ date: 'x', target: 2000 }] })).toEqual({
      unnamed: ['days[].kcal', 'secret'],
      missing: ['days[].target'],
    });
  });

  it('finds nothing in an answer that is what the schema says', () => {
    expect(fieldsThatDiffer({ id: 'a', days: [], note: null }, { id: 'a', days: [], note: null })).toEqual({ unnamed: [], missing: [] });
  });
});

describe('the check of what a route answers', () => {
  beforeEach(() => {
    answersOutsideTheContract();
  });

  it('notes nothing for an answer that is what the route declares, a date sent as a text included', async () => {
    const WithADate = z.object({ at: z.string().datetime() });
    expect(await notedFor(Plan, { id: 'a', days: [{ date: '2026-01-05', target: 1800 }], note: null })).toEqual([]);
    expect(await notedFor(WithADate, { at: new Date('2026-01-05T10:00:00Z') })).toEqual([]);
  });

  it('notes an answer its schema refuses, with where', async () => {
    expect(await notedFor(Plan, { id: 7, days: [], note: null })).toEqual([expect.stringMatching(/^GET \/api\/plans\/:id answers with what its schema refuses: id: /)]);
  });

  it('notes a field the schema does not name, and a field it says is there and the answer leaves out', async () => {
    expect(await notedFor(Plan, { id: 'a', days: [{ date: 'x', target: 1 }], note: null, ownerId: 'u' })).toEqual(['GET /api/plans/:id answers with fields its schema does not name: ownerId']);
    expect(await notedFor(Plan, { id: 'a', days: [{ date: 'x' }], note: null })).toEqual(['GET /api/plans/:id leaves out fields its schema says are there: days[].target']);
  });

  it('notes a body from a route that declares none, and nothing for a route that answers with no body or with a file', async () => {
    expect(await notedFor(undefined, { ok: true })).toEqual(['GET /api/plans/:id answers with a body and declares none']);
    expect(await notedFor(undefined, undefined)).toEqual([]);
    expect(await notedFor(undefined, new StreamableFile(Buffer.from('{}')))).toEqual([]);
  });
});
