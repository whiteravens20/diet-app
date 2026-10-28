// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApiErrorIssue } from '@diet-app/shared';
import { requiredUuid, ZodValidationPipe } from './zod-validation.pipe.js';

interface Rejection {
  statusCode: number;
  error: string;
  issues: ApiErrorIssue[];
}

function rejection(run: () => unknown): Rejection {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Rejection;
  }
  throw new Error('expected the pipe to reject the value');
}

describe('ZodValidationPipe', () => {
  const Body = z.object({ name: z.string().min(1), age: z.number().int() });

  it('returns the parsed payload', () => {
    expect(new ZodValidationPipe(Body).transform({ name: 'Ann', age: 30 })).toEqual({
      name: 'Ann',
      age: 30,
    });
  });

  it('reports each failing field of a body by its path', () => {
    const body = rejection(() =>
      new ZodValidationPipe(Body).transform({ name: '', age: 1.5 }, { type: 'body' }),
    );
    expect(body).toMatchObject({ statusCode: 400, error: 'VALIDATION_FAILED' });
    expect(body.issues.map((i) => i.path)).toEqual(['name', 'age']);
  });

  it('says of each field the kind of refusal, and the bound a value, a length or a list is held to', () => {
    const Bounded = z.object({
      weight: z.number().min(30).max(400),
      pack: z.number().positive(),
      name: z.string().max(3),
      steps: z.array(z.string()).min(1),
      kind: z.enum(['normal', 'rest']),
      count: z.number().int(),
    });
    const body = rejection(() =>
      new ZodValidationPipe(Bounded).transform(
        { weight: 500, pack: 0, name: 'Anna', steps: [], kind: 'fast', count: 1.5 },
        { type: 'body' },
      ),
    );
    expect(body.issues).toEqual([
      {
        path: 'weight',
        message: expect.any(String),
        code: 'too_big',
        maximum: 400,
        inclusive: true,
      },
      {
        path: 'pack',
        message: expect.any(String),
        code: 'too_small',
        minimum: 0,
        inclusive: false,
      },
      { path: 'name', message: expect.any(String), code: 'too_big', maximum: 3, inclusive: true },
      {
        path: 'steps',
        message: expect.any(String),
        code: 'too_small',
        minimum: 1,
        inclusive: true,
      },
      { path: 'kind', message: expect.any(String), code: 'invalid_value' },
      { path: 'count', message: expect.any(String), code: 'invalid_type' },
    ]);
  });

  it('says the lower bound of a value under it', () => {
    const body = rejection(() =>
      new ZodValidationPipe(z.object({ weight: z.number().min(30) })).transform({ weight: 12 }),
    );
    expect(body.issues).toEqual([
      {
        path: 'weight',
        message: expect.any(String),
        code: 'too_small',
        minimum: 30,
        inclusive: true,
      },
    ]);
  });
});

describe('requiredUuid', () => {
  const query = { type: 'query', data: 'profileId' } as const;

  it('passes a UUID through', () => {
    const id = '3f2b8a52-6f0e-4c1d-9b7a-2d1c5e8f9a10';
    expect(requiredUuid.transform(id, query)).toBe(id);
  });

  it('rejects a missing parameter and names it', () => {
    const body = rejection(() => requiredUuid.transform(undefined, query));
    expect(body).toMatchObject({ statusCode: 400, error: 'VALIDATION_FAILED' });
    expect(body.issues.map((i) => i.path)).toEqual(['profileId']);
  });

  it('rejects a value that is not a UUID', () => {
    const body = rejection(() => requiredUuid.transform('not-a-uuid', query));
    expect(body.issues).toEqual([
      { path: 'profileId', message: expect.any(String), code: 'invalid_format' },
    ]);
  });
});
