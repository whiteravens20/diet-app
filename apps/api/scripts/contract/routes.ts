// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The routes of the API, read from its controllers as the framework reads
 * them: the path and the method, who may ask, how often, what a request is
 * held to and what the route answers with. Nothing is started and no database
 * is asked: a controller class carries all of it as metadata, put there by
 * the decorators above its handlers. What a handler is for is the comment
 * above it, read from the source.
 */
import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import type { ZodType } from 'zod';
import { AdminSessionGuard } from '../../src/admin/admin-session.guard.js';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard.js';
import { ANSWERS, ANSWERS_WITH_A_FILE } from '../../src/common/answers.decorator.js';
import { ClientDate } from '../../src/common/client-date.decorator.js';
import { RequestLocale } from '../../src/common/request-locale.decorator.js';
import { ZodValidationPipe } from '../../src/common/zod-validation.pipe.js';
import { CREDENTIAL_COUNTS, type CredentialCount } from '../../src/rate-limit/trackers.js';
import { ReviewerSessionGuard } from '../../src/review/reviewer-session.guard.js';

export const SOURCE = join(__dirname, '../../src');

/** Every route begins with this. */
const PREFIX = '/api';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type Method = (typeof METHODS)[number];

/** Whose session a route asks for. */
export type Asks = 'anyone' | 'account' | 'administrator' | 'reviewer';

const GUARDS = new Map<unknown, Asks>([
  [JwtAuthGuard, 'account'],
  [AdminSessionGuard, 'administrator'],
  [ReviewerSessionGuard, 'reviewer'],
]);

export interface Route {
  method: Method;
  /** As the framework matches it: `/api/meal-plans/:id`. */
  path: string;
  /** The handler: `MealPlansController.generate`, and the file it is in, from the API's source directory. */
  controller: string;
  handler: string;
  file: string;
  asks: Asks;
  /** What the route answers with when it does what it was asked. */
  status: number;
  /** How often one sender may ask within so many seconds, where the route says so; the instance's general limit otherwise. */
  limit: { times: number; seconds: number } | null;
  /** The further counts of a route that tries a credential, each by the credential it tries. */
  credentialLimits: { times: number; seconds: number }[];
  body: ZodType | null;
  /** The schema the whole query string is held to, and the single values a route reads from it. */
  query: ZodType | null;
  queryValues: { name: string; schema: ZodType | null }[];
  pathValues: { name: string; schema: ZodType | null }[];
  /** The route goes by the day it is for the client (`X-Client-Date`), and answers in the client's language (`Accept-Language`). */
  readsClientDate: boolean;
  readsLanguage: boolean;
  answers: ZodType | null;
  /** The media type of the file the route answers with, when it answers with one. */
  answersWithAFile: string | null;
  /** What the route does: the first paragraph of the comment above the handler. */
  description: string;
}

function controllerFiles(dir = SOURCE): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? controllerFiles(join(dir, entry.name)) : entry.name.endsWith('.controller.ts') ? [join(dir, entry.name)] : []))
    .sort();
}

/** What the framework keeps a parameter decorator of our own under: found by decorating a parameter with it. */
function factoryOf(decorator: () => ParameterDecorator): unknown {
  class Probe {
    handler(_value: unknown): void {}
  }
  decorator()(Probe.prototype, 'handler', 0);
  const kept = Reflect.getMetadata('__routeArguments__', Probe, 'handler') as Record<string, { factory?: unknown }>;
  return Object.values(kept)[0]!.factory;
}

/** The comment above each method of each class of a file: `Class.method` → its first paragraph, as one line. */
function comments(path: string): Map<string, string> {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name && ts.isIdentifier(node.name)) {
      // The first paragraph says what the route does; what follows it is for whoever changes the handler.
      const text = (
        ts
          .getJSDocCommentsAndTags(node)
          .filter(ts.isJSDoc)
          .map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? '')
          .join('\n')
          .split(/\n\s*\n/)[0] ?? ''
      )
        .replace(/\s*\n\s*/g, ' ')
        .trim();
      found.set(`${node.parent.name.text}.${node.name.text}`, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const paths = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : [typeof value === 'string' ? value : '/']);
const joined = (...parts: string[]): string => `/${parts.flatMap((part) => part.split('/')).filter(Boolean).join('/')}`;
const schemaOf = (pipes: unknown[] | undefined): ZodType | null => (pipes ?? []).flatMap((pipe) => (pipe instanceof ZodValidationPipe ? [pipe.schema as ZodType] : []))[0] ?? null;

/** Every route of every controller under the source directory, in the order of their paths. */
export async function readRoutes(): Promise<Route[]> {
  const clientDate = factoryOf(ClientDate);
  const language = factoryOf(RequestLocale);
  const routes: Route[] = [];

  for (const path of controllerFiles()) {
    const described = comments(path);
    const exported = (await import(path)) as Record<string, unknown>;
    for (const controller of Object.values(exported)) {
      if (typeof controller !== 'function' || !Reflect.hasMetadata('path', controller)) continue;
      const prototype = (controller as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function' || !Reflect.hasMetadata('method', handler)) continue;
        const method = METHODS[Reflect.getMetadata('method', handler) as number];
        if (!method) throw new Error(`${controller.name}.${name} answers a method the contract does not write: ${String(Reflect.getMetadata('method', handler))}`);

        const guards = [...((Reflect.getMetadata('__guards__', controller) as unknown[] | undefined) ?? []), ...((Reflect.getMetadata('__guards__', handler) as unknown[] | undefined) ?? [])];
        const asking = guards.map((guard) => {
          const asks = GUARDS.get(guard);
          if (!asks) throw new Error(`${controller.name}.${name} is guarded by something the contract cannot name.`);
          return asks;
        });
        if (new Set(asking).size > 1) throw new Error(`${controller.name}.${name} asks for more than one kind of session.`);

        const limitOf = (target: object): { times: number; seconds: number } | null => {
          const times = Reflect.getMetadata('THROTTLER:LIMITdefault', target) as number | undefined;
          const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', target) as number | undefined;
          return times !== undefined && ttl !== undefined ? { times, seconds: ttl / 1000 } : null;
        };

        const kept = (Reflect.getMetadata('__routeArguments__', controller, name) as Record<string, { data?: unknown; pipes?: unknown[]; factory?: unknown }> | undefined) ?? {};
        const route: Route = {
          method,
          path: '',
          controller: controller.name,
          handler: name,
          file: relative(SOURCE, path),
          asks: asking[0] ?? 'anyone',
          status: (Reflect.getMetadata('__httpCode__', handler) as number | undefined) ?? (method === 'POST' ? 201 : 200),
          limit: limitOf(handler) ?? limitOf(controller),
          credentialLimits: ((Reflect.getMetadata(CREDENTIAL_COUNTS, handler) as CredentialCount[] | undefined) ?? []).map((count) => ({ times: count.limit, seconds: count.ttl / 1000 })),
          body: null,
          query: null,
          queryValues: [],
          pathValues: [],
          readsClientDate: false,
          readsLanguage: false,
          answers: (Reflect.getMetadata(ANSWERS, handler) as ZodType | undefined) ?? null,
          answersWithAFile: (Reflect.getMetadata(ANSWERS_WITH_A_FILE, handler) as string | undefined) ?? null,
          description: described.get(`${controller.name}.${name}`) ?? '',
        };
        for (const [key, argument] of Object.entries(kept)) {
          if (argument.factory !== undefined) {
            if (argument.factory === clientDate) route.readsClientDate = true;
            if (argument.factory === language) route.readsLanguage = true;
            continue;
          }
          // The framework's own kinds of parameter: 3 is the body, 4 the query string, 5 the path.
          const kind = Number(key.split(':')[0]);
          const named = typeof argument.data === 'string' ? argument.data : null;
          if (kind === 3) route.body = schemaOf(argument.pipes);
          else if (kind === 4 && named === null) route.query = schemaOf(argument.pipes);
          else if (kind === 4 && named !== null) route.queryValues.push({ name: named, schema: schemaOf(argument.pipes) });
          else if (kind === 5 && named !== null) route.pathValues.push({ name: named, schema: schemaOf(argument.pipes) });
        }

        for (const ofController of paths(Reflect.getMetadata('path', controller))) {
          for (const ofHandler of paths(Reflect.getMetadata('path', handler))) routes.push({ ...route, path: joined(PREFIX, ofController, ofHandler) });
        }
      }
    }
  }
  return routes.sort((a, b) => (a.path === b.path ? METHODS.indexOf(a.method) - METHODS.indexOf(b.method) : a.path < b.path ? -1 : 1));
}
