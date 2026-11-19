// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AiFailure } from '../provider.interface.js';

/**
 * The codes OpenAI gives a 429 with when the account is spent, not the rate
 * too high: no credit left, a limit of spending or of use reached. Waiting
 * does not help with them (its list of error codes, read on 2026-11-19).
 */
const OPENAI_SPENT = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'insufficient_quota',
]);

/** A refusal of a request as it is, by the status alone: what it asks, of what model, with what permission. */
const REFUSED_AS_ASKED = new Set([400, 403, 404, 409, 413, 422]);

/** A provider overloaded, down or out of time for now, by the status alone. */
const BUSY = new Set([408, 429, 502, 503, 504, 529]);

function byStatus(status: number): AiFailure {
  if (status === 401) return 'key_refused';
  if (status === 402) return 'no_credits';
  if (BUSY.has(status)) return 'busy';
  if (REFUSED_AS_ASKED.has(status)) return 'request_refused';
  return 'other';
}

/**
 * OpenAI's refusal: a 429 is a spent account when its code or type says so,
 * and the rate otherwise; a 403 is a country or a permission the key lacks.
 */
export function openAiFailure(err: unknown): AiFailure {
  if (!(err instanceof OpenAI.APIError) || err.status === undefined) return 'other';
  if (
    err.status === 429 &&
    (OPENAI_SPENT.has(String(err.code)) || OPENAI_SPENT.has(String(err.type)))
  )
    return 'no_credits';
  return byStatus(err.status);
}

/**
 * OpenRouter's refusal (its list of error codes, read on 2026-11-19): a 403 is
 * a spent budget or limit of the key when its metadata names the limit, and a
 * guardrail, a moderation or a permission otherwise; a 503 means no provider
 * of the model can take the request now.
 */
export function openRouterFailure(err: unknown): AiFailure {
  if (!(err instanceof OpenAI.APIError) || err.status === undefined) return 'other';
  const metadata = (err.error as { metadata?: { limit_source?: unknown } } | undefined)?.metadata;
  if (err.status === 403 && typeof metadata?.limit_source === 'string') return 'no_credits';
  return byStatus(err.status);
}

/**
 * Anthropic's refusal (its list of errors, read on 2026-11-19): 402 is billing,
 * 529 an overloaded API, and a 429 without `retry-after` a spend cap that keeps
 * failing until access resumes, where one with it is the rate.
 */
export function anthropicFailure(err: unknown): AiFailure {
  if (!(err instanceof Anthropic.APIError) || err.status === undefined) return 'other';
  if (err.status === 429 && !err.headers?.get('retry-after')) return 'no_credits';
  return byStatus(err.status);
}
