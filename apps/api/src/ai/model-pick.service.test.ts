// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_AUDIENCE, MODEL_PICK_AUDIENCE, TOKEN_ALGORITHM } from '../auth/token-kinds.js';
import type { Env } from '../config/env.js';
import { ModelPickService, type DayOffer, type ModelPick } from './model-pick.service.js';

const SECRET = 'a-secret-of-the-instance-0123456789abcdef';
const jwt = new JwtService();
const picks = (secret = SECRET): ModelPickService => new ModelPickService(jwt, { get: () => secret } as unknown as ConfigService<Env, true>);

const HOLDER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
/** What the request that takes a pick does, and the pick as the model made it: the same, with its reason. */
const takingTheMeal = { kind: 'meal', meal: 'meal-1', recipe: 'recipe-1', revision: 4 } as const;
const makingTheSubstitution = { kind: 'ingredient', meal: 'meal-1', from: 'butter', to: 'olive-oil' } as const;
const meal: ModelPick = { ...takingTheMeal, reason: 'Lighter.' };
const substitute: ModelPick = { ...makingTheSubstitution, reason: null };

/** The error code a refusal carries. */
const refusal = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return ((error as { getResponse?: () => { error?: string } }).getResponse?.() ?? {}).error;
  }
};

describe('the note of a pick a model made', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the pick back, with the model\'s reason, to the request that takes exactly that pick', () => {
    const service = picks();

    expect(service.taken(HOLDER, service.sign(HOLDER, meal), takingTheMeal)).toMatchObject(meal);
    expect(service.taken(HOLDER, service.sign(HOLDER, substitute), makingTheSubstitution)).toMatchObject(substitute);
  });

  it('is nothing to a request that hands none back', () => {
    expect(picks().taken(HOLDER, undefined, takingTheMeal)).toBeNull();
  });

  it.each([
    ['another recipe', { ...takingTheMeal, recipe: 'recipe-2' }],
    ['another meal', { ...takingTheMeal, meal: 'meal-2' }],
    ['the plan at another revision', { ...takingTheMeal, revision: 5 }],
    ['a substitution, where the pick was a recipe', makingTheSubstitution],
  ] as const)('is refused for %s', (_what, does) => {
    const service = picks();

    expect(refusal(() => service.taken(HOLDER, service.sign(HOLDER, meal), does))).toBe('MODEL_PICK_INVALID');
  });

  it('is refused for another substitute, and for the same one of another ingredient', () => {
    const service = picks();
    const note = service.sign(HOLDER, substitute);

    expect(refusal(() => service.taken(HOLDER, note, { ...makingTheSubstitution, to: 'lard' }))).toBe('MODEL_PICK_INVALID');
    expect(refusal(() => service.taken(HOLDER, note, { ...makingTheSubstitution, from: 'cream' }))).toBe('MODEL_PICK_INVALID');
  });

  it('is good for the account it was made for, and for no other', () => {
    const service = picks();

    expect(refusal(() => service.taken(STRANGER, service.sign(HOLDER, meal), takingTheMeal))).toBe('MODEL_PICK_INVALID');
  });

  it('cannot be made by a client: a changed note, a made-up one and one signed with another key are refused', () => {
    const service = picks();
    const note = service.sign(HOLDER, meal);
    const [head, body, signature] = note.split('.') as [string, string, string];
    const withAnotherReason = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), reason: 'The doctor said so.' })).toString('base64url');

    expect(refusal(() => service.taken(HOLDER, `${head}.${withAnotherReason}.${signature}`, takingTheMeal))).toBe('MODEL_PICK_INVALID');
    expect(refusal(() => service.taken(HOLDER, 'made-up', takingTheMeal))).toBe('MODEL_PICK_INVALID');
    expect(refusal(() => service.taken(HOLDER, picks('another-secret-0123456789abcdef0123').sign(HOLDER, meal), takingTheMeal))).toBe('MODEL_PICK_INVALID');
    // A token that says nothing of how it is signed is none.
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${body}.`;
    expect(refusal(() => service.taken(HOLDER, unsigned, takingTheMeal))).toBe('MODEL_PICK_INVALID');
  });

  it('is no token of another kind, though the same key signs them: an access token is refused, and a note is no access token', () => {
    const service = picks();
    const accessToken = jwt.sign({ ...meal }, { secret: SECRET, algorithm: TOKEN_ALGORITHM, audience: ACCOUNT_AUDIENCE, subject: HOLDER, expiresIn: 900 });

    expect(refusal(() => service.taken(HOLDER, accessToken, takingTheMeal))).toBe('MODEL_PICK_INVALID');
    expect(() => jwt.verify(service.sign(HOLDER, meal), { secret: SECRET, algorithms: [TOKEN_ALGORITHM], audience: ACCOUNT_AUDIENCE })).toThrow();
    expect(jwt.decode<{ aud: string }>(service.sign(HOLDER, meal)).aud).toBe(MODEL_PICK_AUDIENCE);
  });

  it('runs out after two hours', () => {
    vi.useFakeTimers({ now: new Date('2026-01-05T08:00:00Z') });
    const service = picks();
    const note = service.sign(HOLDER, meal);

    vi.setSystemTime(new Date('2026-01-05T09:59:00Z'));
    expect(service.taken(HOLDER, note, takingTheMeal)).not.toBeNull();

    vi.setSystemTime(new Date('2026-01-05T10:00:01Z'));
    expect(refusal(() => service.taken(HOLDER, note, takingTheMeal))).toBe('MODEL_PICK_INVALID');
  });
});

describe('the note of a way to fill a day that was offered', () => {
  const THE_DAY = { plan: 'plan-1', day: 'day-2' } as const;
  const way: DayOffer = {
    kind: 'day',
    ...THE_DAY,
    revision: 4,
    meals: [
      ['breakfast', 'recipe-1', 1],
      ['lunch', 'recipe-2', 1.25],
      ['dinner', 'recipe-3', 0.75],
    ],
    reuse: 0.4,
    picked: true,
    reason: 'Closest to the target.',
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the way back, with its meals and what was said of it, for the day of the plan it was made for', () => {
    const service = picks();

    expect(service.dayOffered(HOLDER, service.signDay(HOLDER, way), THE_DAY)).toMatchObject(way);
  });

  it.each([
    ['another day of the plan', { plan: 'plan-1', day: 'day-3' }],
    ['the same day of another plan', { plan: 'plan-2', day: 'day-2' }],
  ])('is refused for %s', (_what, of) => {
    const service = picks();

    expect(refusal(() => service.dayOffered(HOLDER, service.signDay(HOLDER, way), of))).toBe('OFFER_INVALID');
  });

  it('is good for the account it was made for, and for no other', () => {
    const service = picks();

    expect(refusal(() => service.dayOffered(STRANGER, service.signDay(HOLDER, way), THE_DAY))).toBe('OFFER_INVALID');
  });

  it('cannot be made by a client: a note with other meals, a made-up one and one signed with another key are refused', () => {
    const service = picks();
    const [head, body, signature] = service.signDay(HOLDER, way).split('.') as [string, string, string];
    const withOtherMeals = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), meals: [['dinner', 'cake', 3]] })).toString('base64url');

    expect(refusal(() => service.dayOffered(HOLDER, `${head}.${withOtherMeals}.${signature}`, THE_DAY))).toBe('OFFER_INVALID');
    expect(refusal(() => service.dayOffered(HOLDER, 'made-up', THE_DAY))).toBe('OFFER_INVALID');
    expect(refusal(() => service.dayOffered(HOLDER, picks('another-secret-0123456789abcdef0123').signDay(HOLDER, way), THE_DAY))).toBe('OFFER_INVALID');
  });

  it('is no note of a pick, and the note of a pick is no offer of a day', () => {
    const service = picks();

    expect(refusal(() => service.dayOffered(HOLDER, service.sign(HOLDER, meal), THE_DAY))).toBe('OFFER_INVALID');
    expect(refusal(() => service.taken(HOLDER, service.signDay(HOLDER, way), takingTheMeal))).toBe('MODEL_PICK_INVALID');
  });

  it('runs out after two hours', () => {
    vi.useFakeTimers({ now: new Date('2026-01-05T08:00:00Z') });
    const service = picks();
    const note = service.signDay(HOLDER, way);

    vi.setSystemTime(new Date('2026-01-05T10:00:01Z'));
    expect(refusal(() => service.dayOffered(HOLDER, note, THE_DAY))).toBe('OFFER_INVALID');
  });

  it('is short enough for a day of five meals to go where a note goes', () => {
    const five: DayOffer = {
      ...way,
      plan: '11111111-1111-4111-8111-111111111111',
      day: '22222222-2222-4222-8222-222222222222',
      meals: ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'].map((slot, index) => [slot, `3333333${index}-3333-4333-8333-333333333333`, 1.25]),
      reason: 'x'.repeat(200),
    };

    // The contract takes a note of up to 2048 characters.
    expect(picks().signDay(HOLDER, five).length).toBeLessThan(2048);
  });
});
