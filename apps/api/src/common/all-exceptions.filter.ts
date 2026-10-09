// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

interface Answer {
  status: number;
  error: string;
  message: string;
}

/** A code the web and mobile clients translate: `EMAIL_TAKEN`, not `Conflict`. */
const STABLE_CODE = /^[A-Z][A-Z0-9_]+$/;

/**
 * Answers for errors that arrive without a code of their own: raised by the
 * framework, a guard, the rate limiter or the body parser.
 */
const BY_STATUS: Record<number, Omit<Answer, 'status'>> = {
  400: { error: 'BAD_REQUEST', message: 'The request could not be understood.' },
  401: { error: 'UNAUTHORIZED', message: 'Sign in to continue.' },
  403: { error: 'FORBIDDEN', message: "You don't have access to that." },
  404: { error: 'NOT_FOUND', message: 'That does not exist.' },
  405: { error: 'METHOD_NOT_ALLOWED', message: 'That action is not available here.' },
  413: { error: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' },
  415: { error: 'UNSUPPORTED_MEDIA_TYPE', message: 'The server does not accept that format.' },
  429: { error: 'RATE_LIMITED', message: 'Too many requests. Try again in a moment.' },
};

/**
 * Database errors a request can cause while the code is right: two requests
 * race, or a row disappears between a check and a write. A service that knows
 * what the conflict means catches it first and throws its own code.
 */
const BY_DATABASE_CODE: Record<string, Answer> = {
  // Unique constraint: something with that value already exists.
  P2002: { status: 409, error: 'CONFLICT', message: 'That already exists.' },
  // Foreign key: the request names a record that is not there, or removes one still in use.
  P2003: {
    status: 409,
    error: 'REFERENCE_CONFLICT',
    message: 'The request refers to something that does not exist or is still in use.',
  },
  // The row an update or delete expected is gone.
  P2025: { status: 404, error: 'NOT_FOUND', message: 'That does not exist.' },
  // Two transactions wrote the same rows, or deadlocked.
  P2034: {
    status: 409,
    error: 'WRITE_CONFLICT',
    message: 'The data changed while the request was running. Try again.',
  },
};

/** The body parser's own errors carry a `type` and the status the client should get. */
function bodyParserStatus(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const { type, status } = exception as { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number') return null;
  return status >= 400 && status < 500 ? status : null;
}

/**
 * Translates every thrown error into the shared `ApiError` envelope.
 * Sensitive details are never leaked — unexpected errors become a generic 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : { message: String(body) };
      const coded = typeof payload.error === 'string' && STABLE_CODE.test(payload.error);
      const generic = coded ? undefined : BY_STATUS[status];
      res.status(status).json({
        statusCode: status,
        error: generic?.error ?? payload.error ?? exception.name,
        message: generic?.message ?? payload.message ?? exception.message,
        ...(payload.issues ? { issues: payload.issues } : {}),
      });
      return;
    }

    const database =
      exception instanceof Prisma.PrismaClientKnownRequestError
        ? BY_DATABASE_CODE[exception.code]
        : undefined;
    if (database) {
      this.logger.warn(`Database error ${(exception as Prisma.PrismaClientKnownRequestError).code} answered as ${database.status} ${database.error}`);
      res.status(database.status).json({
        statusCode: database.status,
        error: database.error,
        message: database.message,
      });
      return;
    }

    const parserStatus = bodyParserStatus(exception);
    if (parserStatus !== null) {
      const answer = BY_STATUS[parserStatus] ?? BY_STATUS[400]!;
      res.status(parserStatus).json({ statusCode: parserStatus, ...answer });
      return;
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  }
}
