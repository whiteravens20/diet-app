// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  type ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

/** Run the filter on `exception` and return the status and body it wrote. */
function answerTo(exception: unknown): { status: number; body: Record<string, unknown> } {
  const written = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    status(code: number) {
      written.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      written.body = body;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  const filter = new AllExceptionsFilter();
  // The filter logs what it could not classify; keep the test output quiet.
  vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  vi.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
  filter.catch(exception, host);
  return written;
}

const databaseError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('refused', { code, clientVersion: 'test' });

describe('AllExceptionsFilter', () => {
  it('passes a coded error through unchanged', () => {
    const { status, body } = answerTo(
      new ConflictException({ error: 'EMAIL_TAKEN', message: 'Email already registered.' }),
    );
    expect(status).toBe(409);
    expect(body).toEqual({ statusCode: 409, error: 'EMAIL_TAKEN', message: 'Email already registered.' });
  });

  it('keeps the field issues of a validation failure', () => {
    const issues = [{ path: 'email', message: 'Invalid email' }];
    const { body } = answerTo(
      new BadRequestException({ error: 'VALIDATION_FAILED', message: 'Request payload failed validation.', issues }),
    );
    expect(body.issues).toEqual(issues);
  });

  it.each([
    [new UnauthorizedException(), 401, 'UNAUTHORIZED'],
    [new NotFoundException('Cannot GET /api/nowhere'), 404, 'NOT_FOUND'],
    [new BadRequestException('Unexpected end of JSON input'), 400, 'BAD_REQUEST'],
    [new HttpException('ThrottlerException: Too Many Requests', 429), 429, 'RATE_LIMITED'],
  ])('gives a framework error a stable code and message (%#)', (exception, expectedStatus, code) => {
    const { status, body } = answerTo(exception);
    expect(status).toBe(expectedStatus);
    expect(body.error).toBe(code);
    // The framework's own text can echo the request; the answer does not.
    expect(body.message).not.toMatch(/Cannot GET|JSON input|ThrottlerException/);
  });

  it.each([
    ['P2002', 409, 'CONFLICT'],
    ['P2003', 409, 'REFERENCE_CONFLICT'],
    ['P2025', 404, 'NOT_FOUND'],
    ['P2034', 409, 'WRITE_CONFLICT'],
  ])('answers database error %s as %i %s', (code, expectedStatus, error) => {
    const { status, body } = answerTo(databaseError(code));
    expect(status).toBe(expectedStatus);
    expect(body).toMatchObject({ statusCode: expectedStatus, error });
    expect(JSON.stringify(body)).not.toContain('refused');
  });

  it('answers a body over the parser limit as 413', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 });
    const { status, body } = answerTo(tooLarge);
    expect(status).toBe(413);
    expect(body.error).toBe('PAYLOAD_TOO_LARGE');
  });

  it.each([
    [new Error('connection string postgresql://user:secret@db/app is wrong')],
    [databaseError('P1001')],
    ['a thrown string'],
  ])('answers anything else as a 500 that says nothing about the cause (%#)', (exception) => {
    const { status, body } = answerTo(exception);
    expect(status).toBe(500);
    expect(body).toEqual({ statusCode: 500, error: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
  });
});
