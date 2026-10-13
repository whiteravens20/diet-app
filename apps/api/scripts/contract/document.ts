// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The contract of the API as two documents, made from its routes and from
 * the schemas of `@diet-app/shared`: an OpenAPI description for programs, and
 * a list of the routes for people. Both are written from the same reading of
 * the controllers, so they say the same.
 */
import * as shared from '@diet-app/shared';
import { z, type ZodType } from 'zod';
import { ADMIN_COOKIE } from '../../src/admin/admin-session.js';
import { REVIEWER_COOKIE_NAME } from '../../src/review/session.js';
import type { Asks, Route } from './routes.js';

type Json = { [key: string]: unknown };

/** The schemas of the contract by the name they are exported under; a schema exported twice goes by its first name. */
const named = new Map<ZodType, string>();
for (const [name, value] of Object.entries(shared)) {
  if (value instanceof z.ZodType && !named.has(value)) named.set(value, name);
}

const COMPONENT = '#/components/schemas/';

/** What a format already says, a pattern need not say again; and a whole number has no other bound than the machine's. */
function tidied(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(tidied);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema as Json)) {
    if (key === '$schema' || key === '$id') continue;
    if (key === 'pattern' && typeof (schema as Json).format === 'string') continue;
    if ((key === 'maximum' && value === Number.MAX_SAFE_INTEGER) || (key === 'minimum' && value === Number.MIN_SAFE_INTEGER)) continue;
    out[key] = tidied(value);
  }
  return out;
}

/** Every schema of the contract as JSON Schema, as it is sent (`input`) or as it is answered with (`output`), one referring to another by its name. */
function components(io: 'input' | 'output'): Record<string, Json> {
  const registry = z.registry<{ id: string }>();
  for (const [schema, name] of named) registry.add(schema, { id: name });
  const made = z.toJSONSchema(registry, { io, target: 'draft-2020-12', unrepresentable: 'any', uri: (id) => `${COMPONENT}${id}` });
  return Object.fromEntries(Object.entries(made.schemas).map(([name, schema]) => [name, tidied(schema) as Json]));
}

/** The names a JSON Schema refers to. */
function referred(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) schema.forEach((part) => referred(part, into));
  else if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema as Json)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(COMPONENT)) into.add(value.slice(COMPONENT.length));
      else referred(value, into);
    }
  }
  return into;
}

/** A schema of a route as JSON Schema: a reference where it is a schema of the contract, written out where it is made of them on the spot. */
function schemaOf(schema: ZodType, io: 'input' | 'output'): Json {
  const name = named.get(schema);
  if (name) return { $ref: `${COMPONENT}${name}` };
  if (schema instanceof z.ZodArray) return { type: 'array', items: schemaOf(schema.element as ZodType, io) };
  const registry = z.registry<{ id: string }>();
  for (const [known, id] of named) registry.add(known, { id });
  const made = z.toJSONSchema(schema, { io, target: 'draft-2020-12', unrepresentable: 'any', metadata: registry }) as Json;
  // What it refers to is among the components; here it is only pointed at.
  delete made.$defs;
  return JSON.parse(JSON.stringify(tidied(made)).replaceAll('"#/$defs/', `"${COMPONENT}`)) as Json;
}

const WHO: Record<Asks, string> = {
  anyone: 'anyone',
  account: 'an account',
  administrator: 'the administrator',
  reviewer: 'a reviewer',
};

/** `/api/meal-plans/:id` as OpenAPI writes it. */
const templated = (path: string): string => path.replace(/:([A-Za-z]+)/g, '{$1}');

/** The part of the API a route belongs to: `meal-plans`, `admin/drafts`. */
function areaOf(route: Route): string {
  const [first, second] = route.path.replace(/^\/api\//, '').split('/');
  return first === 'admin' && second === 'drafts' ? 'admin/drafts' : first === 'users' ? 'users/me' : first!;
}

const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;

function limitOf(route: Route): string {
  const own = route.limit ? `${route.limit.times} in ${seconds(route.limit.seconds)}` : '';
  const tried = route.credentialLimits.map((limit) => `${limit.times} in ${seconds(limit.seconds)} for what it tries`);
  return [own, ...tried].filter(Boolean).join('; ');
}

function seconds(count: number): string {
  if (count % 3600 === 0) return count === 3600 ? 'an hour' : `${count / 3600} hours`;
  if (count % 60 === 0) return count === 60 ? 'a minute' : `${count / 60} minutes`;
  return `${count} s`;
}

/** The parameters of a route: what its path names, what it reads of the query string, and the two headers some routes go by. */
function parametersOf(route: Route, inputs: Record<string, Json>): Json[] {
  const parameters: Json[] = route.pathValues.map((value) => ({ name: value.name, in: 'path', required: true, schema: value.schema ? schemaOf(value.schema, 'input') : { type: 'string' } }));
  if (route.query) {
    let whole = schemaOf(route.query, 'input');
    if (typeof whole.$ref === 'string') whole = inputs[whole.$ref.slice(COMPONENT.length)]!;
    const properties = whole.properties as Record<string, Json> | undefined;
    if (!properties) throw new Error(`${route.method} ${route.path}: its query string is held to something that is no list of named values.`);
    const required = new Set((whole.required as string[] | undefined) ?? []);
    for (const [name, schema] of Object.entries(properties)) parameters.push({ name, in: 'query', required: required.has(name), schema });
  }
  for (const value of route.queryValues) parameters.push({ name: value.name, in: 'query', required: true, schema: value.schema ? schemaOf(value.schema, 'input') : { type: 'string' } });
  if (route.readsClientDate) {
    parameters.push({ name: 'X-Client-Date', in: 'header', required: false, description: 'The day it is for the client, as `2026-03-01`. Without it the route goes by the server\'s day.', schema: { type: 'string', format: 'date' } });
  }
  if (route.readsLanguage) {
    parameters.push({ name: 'Accept-Language', in: 'header', required: false, description: 'The language names and texts are answered in. English without it.', schema: { type: 'string' } });
  }
  return parameters;
}

/** The OpenAPI description of the API. */
export function openApiDocument(routes: readonly Route[], version: string): Json {
  const inputs = components('input');
  const outputs = components('output');

  // Which schemas the routes ask with and answer with, and all that those refer to.
  const reach = (start: Set<string>, from: Record<string, Json>): Set<string> => {
    const seen = new Set<string>();
    const walk = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const next of referred(from[name])) walk(next);
    };
    start.forEach(walk);
    return seen;
  };
  const asked = new Set<string>();
  const answered = new Set<string>(['ApiError']);
  for (const route of routes) {
    referred(parametersOf(route, inputs), asked);
    if (route.body) referred(schemaOf(route.body, 'input'), asked);
    if (route.answers) referred(schemaOf(route.answers, 'output'), answered);
  }
  const sent = reach(asked, inputs);
  const got = reach(answered, outputs);

  // A schema reads differently as it is sent and as it is answered with where a field has a value it takes when
  // left out, and where a field of it is such a schema. One that the routes use both ways is written both ways:
  // under its name as it is answered with, and with `Input` after its name as it is sent.
  const twoWays = new Set(Object.keys(inputs).filter((name) => JSON.stringify(inputs[name]) !== JSON.stringify(outputs[name])));
  for (let grew = true; grew; ) {
    grew = false;
    for (const name of Object.keys(inputs)) {
      if (!twoWays.has(name) && [...referred(inputs[name])].some((other) => twoWays.has(other))) {
        twoWays.add(name);
        grew = true;
      }
    }
  }
  const asSent = (name: string): string => (sent.has(name) && got.has(name) && twoWays.has(name) ? `${name}Input` : name);
  /** A schema of the request side, pointing at the schemas as they are sent. */
  const sending = <T>(schema: T): T =>
    JSON.parse(JSON.stringify(schema).replace(/"#\/components\/schemas\/([A-Za-z0-9]+)"/g, (_whole, name: string) => `"${COMPONENT}${asSent(name)}"`)) as T;

  const paths: Record<string, Json> = {};
  for (const route of routes) {
    const parameters = sending(parametersOf(route, inputs));
    const body = route.body ? sending(schemaOf(route.body, 'input')) : null;
    const answer = route.answers ? schemaOf(route.answers, 'output') : null;

    const limit = limitOf(route);
    const operation: Json = {
      operationId: `${route.controller.replace(/Controller$/, '')}_${route.handler}`,
      tags: [areaOf(route)],
      summary: firstSentence(route.description),
      description: [route.description, `Asked by ${WHO[route.asks]}.`, limit ? `Limited to ${limit}, for each sender.` : ''].filter(Boolean).join('\n\n'),
      security: route.asks === 'anyone' ? [] : [{ [route.asks]: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
      responses: {
        [String(route.status)]: answer
          ? { description: 'What was asked for.', content: { 'application/json': { schema: answer } } }
          : route.answersWithAFile
            ? { description: 'A file to save.', headers: { 'Content-Disposition': { schema: { type: 'string' } } }, content: { [route.answersWithAFile]: { schema: {} } } }
            : { description: 'Done; the answer has no body.' },
        default: { $ref: '#/components/responses/Refused' },
      },
      ...(route.limit ? { 'x-rate-limit': route.limit } : {}),
      ...(route.credentialLimits.length > 0 ? { 'x-credential-limits': route.credentialLimits } : {}),
    };
    const path = templated(route.path);
    paths[path] = { ...(paths[path] ?? {}), [route.method.toLowerCase()]: operation };
  }

  const written: Record<string, Json> = {};
  for (const name of got) written[name] = outputs[name]!;
  for (const name of sent) {
    if (got.has(name) && asSent(name) === name) continue;
    if (asSent(name) !== name && asSent(name) in inputs) throw new Error(`${name} is written both ways, and the contract already has another schema called ${asSent(name)}.`);
    written[asSent(name)] = sending(inputs[name]!);
  }
  const schemas = Object.fromEntries(Object.entries(written).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  return {
    openapi: '3.1.0',
    info: {
      title: 'Diet App API',
      version,
      description:
        'What the API of Diet App is asked and what it answers. Written by `npm run contract` from the controllers and from the schemas of `@diet-app/shared`; the integration tests hold every answer to the schema its route names here.',
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    paths,
    components: {
      securitySchemes: {
        account: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'The access token of a session (`POST /api/auth/login`), good for a quarter of an hour and renewed with the refresh token.' },
        administrator: { type: 'apiKey', in: 'cookie', name: ADMIN_COOKIE, description: 'The administrator\'s session (`POST /api/admin/session`).' },
        reviewer: { type: 'apiKey', in: 'cookie', name: REVIEWER_COOKIE_NAME, description: 'A reviewer\'s session (`POST /api/review/auth`).' },
      },
      responses: {
        Refused: {
          description: 'The request was refused. `error` is a code that the texts of every language have a sentence for (`errors.<code>` in the message catalogue); `message` is that sentence in English.',
          content: { 'application/json': { schema: { $ref: `${COMPONENT}ApiError` } } },
        },
      },
      schemas,
    },
  };
}

/** The name of what a route asks with or answers with, for the list. */
function called(schema: ZodType | null): string {
  if (!schema) return '';
  const name = named.get(schema);
  if (name) return `\`${name}\``;
  if (schema instanceof z.ZodArray) return `a list of ${called(schema.element as ZodType)}`;
  // A schema of the contract with something set on it for the route: it goes by the name of what it is made of.
  const inner = (schema as unknown as { def?: { innerType?: ZodType; in?: ZodType } }).def;
  return called(inner?.innerType ?? inner?.in ?? null) || 'a body of its own';
}

/** The routes of the API as a document to read: by the part of the API, each with who may ask, what it does, what it takes and what it answers. */
export function routesDocument(routes: readonly Route[]): string {
  const areas = new Map<string, Route[]>();
  for (const route of routes) areas.set(areaOf(route), [...(areas.get(areaOf(route)) ?? []), route]);
  const cell = (text: string): string => text.replaceAll('|', '\\|');

  const lines = [
    '# The routes of the API',
    '',
    'Written by `npm run contract` from the controllers; a test fails when this file is not what the command writes. The same routes with every schema in full are in [`openapi.json`](openapi.json).',
    '',
    `${routes.length} routes. Every request that is refused is answered with an \`ApiError\`: a status, a code and a sentence. A route that names no limit of its own is under the general one of the instance (\`RATE_LIMIT_MAX\` requests in \`RATE_LIMIT_WINDOW\` seconds for each sender).`,
    '',
  ];
  for (const [area, ofArea] of [...areas].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`## ${area}`, '', '| Route | Asked by | What it does | Takes | Answers | Limit |', '|---|---|---|---|---|---|');
    for (const route of ofArea) {
      const takes = [route.body ? called(route.body) : '', route.query ? `query ${called(route.query)}` : '', ...route.queryValues.map((value) => `\`?${value.name}=\``)].filter(Boolean).join(', ');
      const answers = `${route.status}${route.answers ? ` ${called(route.answers)}` : route.answersWithAFile ? ' a file' : ''}`;
      lines.push(`| \`${route.method} ${route.path}\` | ${WHO[route.asks]} | ${cell(route.description)} | ${cell(takes)} | ${cell(answers)} | ${limitOf(route)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
