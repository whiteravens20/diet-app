// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RecipeGenerateSpec } from '@diet-app/shared';
import { recipeBatch, recipesPerCall } from '../../ai/operations.js';
import { INGREDIENTS, RECIPES, seedCatalogue } from '../../testing/catalogue.js';
import { resetDatabase } from '../../testing/database.js';
import type { ModelRequest } from '../../testing/fake-model.js';
import { createTestApp, type TestApp } from '../../testing/test-app.js';
import { RecipeGeneratorRunner, type RecipeRunnerState } from './recipe-generator.runner.js';

const admin = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };

/** Every set of three fixture ingredients that no fixture recipe already uses. */
const unusedTriples: string[][] = (() => {
  const taken = new Set(RECIPES.map((r) => r.lines.map(([slug]) => slug).sort().join('+')));
  const slugs = INGREDIENTS.map((i) => i.slug);
  const triples: string[][] = [];
  for (let a = 0; a < slugs.length; a += 1) {
    for (let b = a + 1; b < slugs.length; b += 1) {
      for (let c = b + 1; c < slugs.length; c += 1) {
        const triple = [slugs[a]!, slugs[b]!, slugs[c]!];
        if (!taken.has([...triple].sort().join('+'))) triples.push(triple);
      }
    }
  }
  return triples;
})();

/** A scripted author: every recipe it writes is valid and unlike any before it. */
function author() {
  let written = 0;
  const recipe = () => {
    const triple = unusedTriples[written]!;
    written += 1;
    return {
      slug: `generated-recipe-${written}`,
      titles: { en: `Generated recipe ${written}` },
      descriptions: { en: 'A quick plate from three things in the cupboard.' },
      steps: { en: ['Prepare the ingredients.', 'Cook everything together until done.'] },
      servings: 2,
      mealTypes: ['lunch'],
      dietTags: [],
      prepMinutes: 5,
      cookMinutes: 10,
      difficulty: 'easy',
      ingredients: triple.map((slug) => ({
        slug,
        quantity: 100,
        unit: INGREDIENTS.find((i) => i.slug === slug)!.canonicalUnit,
      })),
    };
  };
  /** How many recipes a prompt asks for. */
  const asked = (request: ModelRequest): number =>
    Number(/Now write (\d+) recipe\(s\)\./.exec(request.prompt)![1]);
  return {
    asked,
    /** Answer a call with exactly what it asked for, or with `extra` more. */
    answer:
      (extra = 0) =>
      (request: ModelRequest): string =>
        JSON.stringify({ recipes: Array.from({ length: asked(request) + extra }, recipe) }),
  };
}

const ALL_SIMPLE = { simple: 1, medium: 0, complex: 0 };

describe('generating recipe drafts', () => {
  let t: TestApp;
  let runner: RecipeGeneratorRunner;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    runner = t.app.get(RecipeGeneratorRunner);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.model.reset();
    await t.prisma.recipeDraft.deleteMany();
  });

  async function finished(): Promise<RecipeRunnerState> {
    for (let waited = 0; waited < 200; waited += 1) {
      const state = runner.getState();
      if (state.status !== 'running') return state;
      await new Promise((tick) => setTimeout(tick, 25));
    }
    throw new Error('the run did not finish');
  }

  async function run(spec: RecipeGenerateSpec): Promise<RecipeRunnerState> {
    expect(runner.start(spec)).toBe(true);
    return finished();
  }

  it('asks for a few recipes per call and tells each call what the ones before it wrote', async () => {
    const model = author();
    t.model.reply({ text: model.answer(), times: 10 });
    const perCall = recipesPerCall(1);
    const count = perCall + 2;

    await t
      .http()
      .post('/api/admin/drafts/recipes/generate')
      .set(admin)
      .send({ count, targetLocales: ['en'], complexityMix: ALL_SIMPLE })
      .expect(202);
    const state = await finished();

    expect(state).toMatchObject({ status: 'done', error: null, total: count, processed: count, written: count, failed: 0 });
    expect(await t.prisma.recipeDraft.count()).toBe(count);

    // Two calls, each no larger than one answer can hold, each with a cap sized to it.
    expect(t.model.requests.map(model.asked)).toEqual([perCall, 2]);
    expect(t.model.requests.map((r) => r.maxTokens)).toEqual([
      recipeBatch(perCall, 1, 0.2).maxTokens,
      recipeBatch(2, 1, 0.2).maxTokens,
    ]);
    expect(t.model.requests[0]!.prompt).not.toContain('generated-recipe-1');
    expect(t.model.requests[1]!.prompt).toContain('generated-recipe-1');
  });

  it('asks again when an answer was cut off at the token limit, and says why', async () => {
    const model = author();
    t.model.reply({ text: '{"recipes":[{"slug":"half-a-rec', truncated: true });
    t.model.reply({ text: model.answer(), times: 10 });

    const state = await run({ count: 2, targetLocales: ['en'], complexityMix: ALL_SIMPLE });

    expect(state).toMatchObject({ status: 'done', written: 2, failed: 0, lastRejectReason: 'answer-cut-off' });
    expect(t.model.requests).toHaveLength(2);
  });

  it('keeps what earlier calls wrote when a later call is rejected every time', async () => {
    const model = author();
    const perCall = recipesPerCall(1);
    t.model.reply({ text: model.answer() });
    t.model.reply({ text: 'I would rather not.', times: 3 });

    const state = await run({ count: perCall + 1, targetLocales: ['en'], complexityMix: ALL_SIMPLE });

    expect(state).toMatchObject({
      status: 'done',
      error: null,
      processed: perCall + 1,
      written: perCall,
      failed: 1,
      lastRejectReason: 'malformed-json',
    });
    expect(await t.prisma.recipeDraft.count()).toBe(perCall);
    // One accepted call, then three attempts at the second.
    expect(t.model.requests).toHaveLength(4);
  });

  it('stops with an error, without asking for the rest, when the provider keeps failing', async () => {
    t.model.reply({ status: 500, text: 'out of memory', times: 10 });

    const state = await run({ count: recipesPerCall(1) * 3, targetLocales: ['en'], complexityMix: ALL_SIMPLE });

    expect(state.status).toBe('error');
    expect(state.error).toContain('provider call failed');
    expect(state.written).toBe(0);
    expect(t.model.requests).toHaveLength(3);
  });

  it('never writes more recipes than were asked for', async () => {
    const model = author();
    t.model.reply({ text: model.answer(2), times: 10 });

    const state = await run({ count: 2, targetLocales: ['en'], complexityMix: ALL_SIMPLE });

    expect(state).toMatchObject({ status: 'done', written: 2, processed: 2, failed: 0 });
    expect(await t.prisma.recipeDraft.count()).toBe(2);
  });
});
