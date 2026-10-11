// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, MealPlanPage, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DAY_MS = 86_400_000;
/** The day `offset` days from the server's own, as the API writes dates. */
const day = (offset: number): string => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

describe('the list of the plans of a profile', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let past: MealPlan;
  let underWay: MealPlan;
  let toCome: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
    past = await aPlan(t, user, profile, { startDate: day(-40), durationDays: 7 });
    underWay = await aPlan(t, user, profile, { startDate: day(-3), durationDays: 7 });
    toCome = await aPlan(t, user, profile, { startDate: day(10), durationDays: 3 });
  });

  const list = (query: Record<string, string | number> = {}, headers: Record<string, string> = {}) =>
    t.http().get('/api/meal-plans').query({ profileId: profile.id, ...query }).set(as(user)).set(headers);
  const listed = async (query: Record<string, string | number> = {}, headers: Record<string, string> = {}): Promise<MealPlanPage> => (await list(query, headers).expect(200)).body;
  const ids = (page: MealPlanPage): string[] => page.items.map((plan) => plan.id);

  it('holds each plan as a summary, the one that begins last first', async () => {
    const page = await listed();

    expect(ids(page)).toEqual([toCome.id, underWay.id, past.id]);
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 3, totalPages: 1 });
    expect(page.items[1]).toEqual({
      id: underWay.id,
      profileId: profile.id,
      startDate: underWay.startDate,
      durationDays: 7,
      dietType: underWay.dietType,
      averageDailyNutrition: underWay.averageDailyNutrition,
      ingredientReuseScore: underWay.ingredientReuseScore,
      generationMode: underWay.generationMode,
      options: underWay.options,
      revision: underWay.revision,
      createdAt: underWay.createdAt,
    });
  });

  it('says of every plan what the plan itself says of an average day', async () => {
    // A day that is skipped is no day of eating, and a meal of the user's own counts with what was typed for it.
    const skipped = await aPlan(t, user, profile, { startDate: day(20), durationDays: 3, dayOverrides: [{ date: day(21), skip: true }] });
    await t
      .http()
      .post(`/api/meal-plans/${skipped.id}/days/${day(20)}/custom-meal`)
      .set(as(user))
      .send({ name: 'Cake', mealType: 'snack', nutrition: { calories: 400, protein: 5, fat: 20, carbs: 50 }, servings: 1.5 })
      .expect(201);

    const page = await listed();

    for (const summary of page.items) {
      const whole: MealPlan = (await t.http().get(`/api/meal-plans/${summary.id}`).set(as(user)).expect(200)).body;
      expect(summary.averageDailyNutrition, summary.startDate).toEqual(whole.averageDailyNutrition);
    }
    expect(page.items[0]!.averageDailyNutrition.calories).toBeGreaterThan(0);
  });

  it('is small: four weeks of plans are a few kilobytes, with no day, meal or recipe in them', async () => {
    await aPlan(t, user, profile, { startDate: day(30), durationDays: 28 });

    const res = await list().expect(200);

    expect(res.text.length).toBeLessThan(4_000);
    expect(res.text).not.toMatch(/"days"|"meals"|"recipe"|"ingredients"|"steps"/);
  });

  it('is read a page at a time', async () => {
    const first = await listed({ pageSize: 2 });
    const second = await listed({ pageSize: 2, page: 2 });
    const beyond = await listed({ pageSize: 2, page: 9 });

    expect(first).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(ids(first)).toEqual([toCome.id, underWay.id]);
    expect(ids(second)).toEqual([past.id]);
    expect(beyond).toMatchObject({ items: [], total: 3, totalPages: 2 });
  });

  it('is narrowed to the plans that hold a day or a later one, and to those that begin by a day', async () => {
    expect(ids(await listed({ from: day(3) }))).toEqual([toCome.id, underWay.id]);
    // The last day of the plan that is under way still counts; the day after it does not.
    expect(ids(await listed({ from: day(4) }))).toEqual([toCome.id]);
    expect(ids(await listed({ to: day(-3) }))).toEqual([underWay.id, past.id]);
    expect(ids(await listed({ to: day(-4) }))).toEqual([past.id]);
    expect(ids(await listed({ from: day(-34), to: day(-4) }))).toEqual([past.id]);
    expect(ids(await listed({ from: day(-33), to: day(-4) }))).toEqual([]);
  });

  it('is narrowed to the plans that are under way, over or still to come', async () => {
    expect(ids(await listed({ status: 'active' }))).toEqual([underWay.id]);
    expect(ids(await listed({ status: 'past' }))).toEqual([past.id]);
    expect(ids(await listed({ status: 'upcoming' }))).toEqual([toCome.id]);
    expect(await listed({ status: 'past', pageSize: 1 })).toMatchObject({ total: 1, totalPages: 1 });
  });

  it('goes by the day it is for the client: a plan that begins tomorrow is under way where it is tomorrow already', async () => {
    const tomorrow = await aPlan(t, user, profile, { startDate: day(1), durationDays: 2 });

    expect(ids(await listed({ status: 'upcoming' }))).toContain(tomorrow.id);
    expect(ids(await listed({ status: 'active' }, { 'X-Client-Date': day(1) }))).toContain(tomorrow.id);
    expect(ids(await listed({ status: 'upcoming' }, { 'X-Client-Date': day(1) }))).not.toContain(tomorrow.id);
    // And a plan that ended yesterday is still under way where it is yesterday still.
    const yesterday = await aPlan(t, user, profile, { startDate: day(-2), durationDays: 2 });
    expect(ids(await listed({ status: 'past' }))).toContain(yesterday.id);
    expect(ids(await listed({ status: 'active' }, { 'X-Client-Date': day(-1) }))).toContain(yesterday.id);
  });

  it.each([
    ['a status there is not', { status: 'sometime' }, 'status'],
    ['a day there is not', { to: '2026-02-30' }, 'to'],
    ['a date in another form', { from: '01.03.2026' }, 'from'],
    ['half a page', { page: 1.5 }, 'page'],
    ['a page of five hundred', { pageSize: 500 }, 'pageSize'],
    ['a profile that is no id', { profileId: 'mine' }, 'profileId'],
  ])('refuses %s, and says which part of the question it is', async (_name, query, part) => {
    const refused = await list(query).expect(400);

    expect(refused.body.error).toBe('VALIDATION_FAILED');
    expect([...new Set(refused.body.issues.map((issue: { path: string }) => issue.path))]).toEqual([part]);
  });

  it('refuses a day the client names that it is nowhere today', async () => {
    const refused = await list({ status: 'active' }, { 'X-Client-Date': day(3) }).expect(400);

    expect(refused.body).toMatchObject({ error: 'VALIDATION_FAILED', issues: [{ path: 'x-client-date' }] });
    expect((await list({}, { 'X-Client-Date': 'today' }).expect(400)).body.error).toBe('VALIDATION_FAILED');
  });

  it('is the profile\'s own: another profile of the account has its own list, and another account\'s profile is not found', async () => {
    const second = await aProfile(t, user, { name: 'Second' });
    const other = await aUser(t);

    expect(await listed({ profileId: second.id })).toMatchObject({ items: [], total: 0 });
    expect((await t.http().get('/api/meal-plans').query({ profileId: profile.id }).set(as(other)).expect(404)).body.error).toBe('PROFILE_NOT_FOUND');
    await t.http().get('/api/meal-plans').query({ profileId: profile.id }).expect(401);
  });
});
