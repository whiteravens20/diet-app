// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Holds what the application answers to what its routes declare
 * (`@Answers`): every answer of a test application is read as a client would
 * read it and checked against the route's schema. An answer the schema
 * refuses, a field the schema does not name, a field it names and the answer
 * lacks, and a body from a route that declares none are noted here, and
 * `hold-answers.ts` fails the test in which one was noted.
 */
import {
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { tap, type Observable } from 'rxjs';
import type { ZodType } from 'zod';
import { ANSWERS } from '../common/answers.decorator.js';

let held = false;
const noted: string[] = [];

/** Have the test applications of this file check their answers. */
export function holdAnswers(): void {
  held = true;
}

/** Whether test applications are to check their answers. */
export function answersAreHeld(): boolean {
  return held;
}

/** What was noted since this was last asked. */
export function answersOutsideTheContract(): string[] {
  return noted.splice(0);
}

/** Where `sent` and what the schema made of it differ in the fields they have: `a.b`, `items[].c`. */
export function fieldsThatDiffer(
  sent: unknown,
  read: unknown,
  at = '',
): { unnamed: string[]; missing: string[] } {
  const found = { unnamed: new Set<string>(), missing: new Set<string>() };
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (Array.isArray(a) && Array.isArray(b)) {
      a.forEach((item, index) => walk(item, b[index], `${path}[]`));
    } else if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      const [had, has] = [a as Record<string, unknown>, b as Record<string, unknown>];
      for (const key of Object.keys(had)) {
        if (!(key in has)) found.unnamed.add(path ? `${path}.${key}` : key);
        else walk(had[key], has[key], path ? `${path}.${key}` : key);
      }
      for (const key of Object.keys(has))
        if (!(key in had)) found.missing.add(path ? `${path}.${key}` : key);
    }
  };
  walk(sent, read, at);
  return { unnamed: [...found.unnamed], missing: [...found.missing] };
}

export class AnswersCheck implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.get<ZodType | undefined>(ANSWERS, context.getHandler());
    const request = context
      .switchToHttp()
      .getRequest<{ method: string; url: string; route?: { path?: string } }>();
    const route = `${request.method} ${request.route?.path ?? request.url}`;
    return next.handle().pipe(
      tap((answer: unknown) => {
        // A file is sent as it is; what it holds is not the answer of the route.
        if (answer instanceof StreamableFile) return;
        if (!schema) {
          if (answer !== undefined) noted.push(`${route} answers with a body and declares none`);
          return;
        }
        // As a client gets it: a date is a text, and what is undefined is not there.
        const sent: unknown = answer === undefined ? undefined : JSON.parse(JSON.stringify(answer));
        const read = schema.safeParse(sent);
        if (!read.success) {
          noted.push(
            `${route} answers with what its schema refuses: ${read.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join('.') || '(the whole)'}: ${issue.message}`)
              .join('; ')}`,
          );
          return;
        }
        const { unnamed, missing } = fieldsThatDiffer(sent, read.data);
        if (unnamed.length > 0)
          noted.push(
            `${route} answers with fields its schema does not name: ${unnamed.join(', ')}`,
          );
        if (missing.length > 0)
          noted.push(`${route} leaves out fields its schema says are there: ${missing.join(', ')}`);
      }),
    );
  }
}
