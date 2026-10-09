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
