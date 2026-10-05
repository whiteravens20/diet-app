// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { requiredUuid, ZodValidationPipe } from './zod-validation.pipe.js';

interface Rejection {
  statusCode: number;
  error: string;
  issues: { path: string; message: string }[];
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
    expect(body.issues.map((i) => i.path)).toEqual(['profileId']);
  });
});
