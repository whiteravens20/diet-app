// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AiGenerationMeta } from '@diet-app/shared';
import { AiRouterService, withUnusableAnswer } from './ai-router.service.js';
import { modelText, readModelReply } from './model-json.js';
import type { Operation } from './operations.js';

/** The longest sentence of a model on an option that is passed on to the user. */
export const MAX_WEIGHED_CHARS = 200;

/** An option the engine made, as a model is shown it: a short id, and what there is to know of it in one line. */
export interface WeighedOption {
  id: string;
  facts: string;
}

/** What is put before a model. */
export interface Weighing {
  /** What is being chosen, in a sentence. */
  choice: string;
  /** What matters in the choice, the most important first. */
  matters: readonly string[];
  /** The options, in the order the engine has them. */
  options: readonly WeighedOption[];
  /** The language the model is to write its sentences in, by name. */
  language: string;
}

/** What came of it. */
export interface Weighed {
  /** The ids of all the options, the best first: in the model's order, or the engine's where no model gave one. */
  order: string[];
  /** The model's sentence on an option, for the options it said one of. */
  said: ReadonlyMap<string, string>;
  meta: AiGenerationMeta;
}

// What the prompt asks for. An order is all that is needed: a sentence is welcome and never required.
const Answer = z.object({ order: z.array(z.unknown()).max(100), reasons: z.unknown().optional() });

/**
 * A model weighs what the engine proposes: it puts options in order and says
 * a sentence of each. It is given options the engine has already checked and
 * cannot add to them, change them, or take one away: an id it names that was
 * not on offer is ignored, an option it leaves out keeps its place after the
 * ones it named, and an answer that names none leaves the engine's order as
 * it was, with `meta` saying so. Where no model answers at all the same
 * holds: asking is never what a proposal depends on.
 */
@Injectable()
export class WeighService {
  constructor(private readonly ai: AiRouterService) {}

  async weigh(userId: string, operation: Operation, asked: Weighing): Promise<Weighed> {
    const ids = asked.options.map((option) => option.id);
    const asIs = (meta: AiGenerationMeta): Weighed => ({ order: ids, said: new Map(), meta });
    const { text, meta } = await this.ai.chat(
      userId,
      [
        { role: 'system', content: systemPrompt(asked.language) },
        { role: 'user', content: userPrompt(asked) },
      ],
      operation,
      true,
    );
    if (text === null) return asIs(meta);

    const reply = readModelReply(text, Answer);
    if (!reply.ok) return asIs(withUnusableAnswer(meta));
    const named = [...new Set(reply.value.order.filter((id): id is string => typeof id === 'string' && ids.includes(id)))];
    if (named.length === 0) return asIs(withUnusableAnswer(meta));

    const reasons = reply.value.reasons;
    const said = new Map<string, string>();
    if (typeof reasons === 'object' && reasons !== null) {
      for (const id of ids) {
        const line = Object.hasOwn(reasons, id) ? modelText((reasons as Record<string, unknown>)[id], MAX_WEIGHED_CHARS) : null;
        if (line !== null) said.set(id, line);
      }
    }
    return { order: [...named, ...ids.filter((id) => !named.includes(id))], said, meta };
  }
}

function systemPrompt(language: string): string {
  return (
    'You weigh options for a person who plans their meals with a deterministic meal-planning app. ' +
    'The app has already checked every option: each of them is allowed, and the figures given with it are exact. ' +
    'You do not change an option, add one, leave one out, or state a figure that was not given. ' +
    'Respond with valid JSON exactly matching ' +
    '{"order":["<id>","<id>"],"reasons":{"<id>":"<one short sentence>"}} — every id once, the best first, ' +
    'and for each id one sentence of at most 25 words that tells the person what speaks for the option and what against it. ' +
    `No prose, no markdown, no other keys. Write the sentences in ${language}.`
  );
}

function userPrompt(asked: Weighing): string {
  return [
    asked.choice,
    '',
    'What matters, the most important first:',
    ...asked.matters.map((line, index) => `${index + 1}. ${line}`),
    '',
    'Options:',
    ...asked.options.map((option) => `- id=${option.id} | ${option.facts}`),
    '',
    'Respond with the JSON object only.',
  ].join('\n');
}
