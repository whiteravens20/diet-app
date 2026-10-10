// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Reading JSON out of a model reply.
 *
 * A reply is untrusted input: a user may point the app at a model they control.
 * Everything here therefore runs in time linear in the length of the reply and
 * refuses one that is too long to be an answer. A backtracking pattern over a
 * reply would let a single request stall the whole process.
 */
import type { z } from 'zod';

/** The longest reply that is read, unless the caller expects more. */
export const MAX_MODEL_REPLY_CHARS = 64_000;

/** The longest reply of an admin batch, which carries many recipes or names at once. */
export const MAX_BATCH_REPLY_CHARS = 1_000_000;

/** Why a reply could not be used. */
export type ReplyProblem = 'too_long' | 'no_json_object' | 'wrong_shape';

export type ModelReply<T> = { ok: true; value: T } | { ok: false; problem: ReplyProblem };

/**
 * The JSON object a reply holds: the text from its first `{` to its last `}`.
 * That drops a Markdown code fence around the object and any prose before or
 * after it.
 */
export function readModelObject(
  reply: string,
  maxChars: number = MAX_MODEL_REPLY_CHARS,
): ModelReply<Record<string, unknown>> {
  if (reply.length > maxChars) return { ok: false, problem: 'too_long' };
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, problem: 'no_json_object' };
  try {
    const value = JSON.parse(reply.slice(start, end + 1)) as unknown;
    // The span starts with `{`, so whatever parses is an object.
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, problem: 'no_json_object' };
  }
}

/**
 * A string a model wrote, as one line without control characters. Null when
 * the value is not a string or nothing is left of it.
 */
export function plainLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- control characters are what is being removed
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return line === '' ? null : line;
}

/**
 * Text a model wrote for the user, made fit to show: one plain line of at most
 * `max` characters, cut with a mark when it was longer.
 */
export function modelText(value: unknown, max: number): string | null {
  const line = plainLine(value);
  if (line === null) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The object a reply holds, checked against the shape the prompt asked for. */
export function readModelReply<T>(
  reply: string,
  schema: z.ZodType<T>,
  maxChars: number = MAX_MODEL_REPLY_CHARS,
): ModelReply<T> {
  const object = readModelObject(reply, maxChars);
  if (!object.ok) return object;
  const checked = schema.safeParse(object.value);
  return checked.success ? { ok: true, value: checked.data } : { ok: false, problem: 'wrong_shape' };
}
