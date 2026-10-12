// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aCacheStorage } from '@/testing/cache-storage';
import { ApiClientError } from './http';
import { MOST_WAITING, offline } from './offline';

const ANNA = '11111111-1111-4111-8111-111111111111';
const ADAM = '22222222-2222-4222-8222-222222222222';
const PLAN = '/meal-plans/33333333-3333-4333-8333-333333333333';
const noAnswer = (): ApiClientError => new ApiClientError(0, 'NETWORK', 'Cannot reach the server.');
/** Let what was started without being waited for (an answer being kept) finish. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('what a browser keeps of an account for when the server cannot be reached', () => {
  let stores: ReturnType<typeof aCacheStorage>;

  beforeEach(async () => {
    stores = aCacheStorage();
    vi.stubGlobal('caches', stores);
    localStorage.clear();
    await offline.forget();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is nothing until an account is signed in, and nothing in a browser that gives the page no storage for it', async () => {
    await offline.remember(PLAN, { id: 'plan' });
    expect(stores.names()).toEqual([]);
    expect(await offline.recall(PLAN)).toEqual({ found: false });

    vi.stubGlobal('caches', undefined);
    await offline.belongsTo(ANNA);
    expect(offline.possible).toBe(false);
    expect(offline.account).toBeNull();
    expect(await offline.through(PLAN, () => Promise.resolve('asked'))).toBe('asked');
  });

  it('is the answers to what the plan and the shopping pages read, and to nothing else', () => {
    for (const kept of ['/users/me', '/config', '/profiles', '/profiles/abc/calories', '/meal-plans?profileId=abc&page=1', PLAN, '/meal-plans/calendar?profileId=abc&from=2026-01-01&to=2026-02-01', '/meal-plans/overview?profileId=abc', '/weights?profileId=abc', '/shopping-lists?planId=abc', '/favorites?profileId=abc', '/favorite-sets?profileId=abc', '/recipes/abc']) {
      expect(offline.keeps(kept), kept).toBe(true);
    }
    for (const left of ['/users/me/sessions', '/users/me/export', '/ai/providers', '/inventory?profileId=abc', '/notifications/unread', '/recipes?search=rice', '/meal-plans/abc/meals/def/substitutes', '/profiles/abc']) {
      expect(offline.keeps(left), left).toBe(false);
    }
  });

  it('gives back the answer the API gave last, once the API cannot be reached', async () => {
    await offline.belongsTo(ANNA);
    const ask = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce({ id: 'plan', days: 3 }).mockRejectedValue(noAnswer());

    expect(await offline.through(PLAN, ask)).toEqual({ id: 'plan', days: 3 });
    expect(offline.serving).toBe(false);
    await settled();

    expect(await offline.through(PLAN, ask)).toEqual({ id: 'plan', days: 3 });
    expect(offline.serving).toBe(true);
    // An answer that gets through says that the server is back.
    ask.mockResolvedValueOnce({ id: 'plan', days: 4 });
    expect(await offline.through(PLAN, ask)).toEqual({ id: 'plan', days: 4 });
    expect(offline.serving).toBe(false);
  });

  it('passes on a refusal of the API, and silence about something that was never read', async () => {
    await offline.belongsTo(ANNA);
    await offline.remember(PLAN, { id: 'plan' });
    const refused = new ApiClientError(404, 'PLAN_NOT_FOUND', 'gone');

    await expect(offline.through(PLAN, () => Promise.reject(refused))).rejects.toBe(refused);
    await expect(offline.through('/meal-plans/another', () => Promise.reject(noAnswer()))).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(offline.through('/users/me/sessions', () => Promise.reject(noAnswer()))).rejects.toMatchObject({ code: 'NETWORK' });
    expect(offline.serving).toBe(false);
  });

  it('says so to whoever watches when the pages begin and stop being served from it', async () => {
    await offline.belongsTo(ANNA);
    await offline.remember(PLAN, { id: 'plan' });
    const heard = vi.fn();
    const stop = offline.subscribe(heard);

    await offline.through(PLAN, () => Promise.reject(noAnswer()));
    expect(heard).toHaveBeenCalledTimes(1);
    await offline.through(PLAN, () => Promise.reject(noAnswer()));
    expect(heard).toHaveBeenCalledTimes(1);
    await offline.through(PLAN, () => Promise.resolve({ id: 'plan' }));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it('is of one account: another that signs in finds nothing of the one before', async () => {
    await offline.belongsTo(ANNA);
    await offline.remember(PLAN, { id: 'of Anna' });
    offline.wait({ listId: 'list', itemId: 'row', checked: true });

    await offline.belongsTo(ADAM);

    expect(offline.account).toBe(ADAM);
    // The storage of the account before is gone, not only out of reach.
    expect(stores.names()).toEqual([]);
    expect(await offline.recall(PLAN)).toEqual({ found: false });
    expect(offline.waiting).toEqual([]);
    // The same account signing in again keeps what it had.
    await offline.remember(PLAN, { id: 'of Adam' });
    await offline.belongsTo(ADAM);
    expect(await offline.recall(PLAN)).toEqual({ found: true, answer: { id: 'of Adam' } });
  });

  it('is gone when the account signs out: the answers, the ticks that waited, and whose they were', async () => {
    await offline.belongsTo(ANNA);
    await offline.remember(PLAN, { id: 'plan' });
    offline.wait({ listId: 'list', itemId: 'row', checked: true });

    await offline.forget();

    expect(offline.account).toBeNull();
    expect(offline.waiting).toEqual([]);
    expect(stores.names()).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it('keeps the answers read last when there are more than it holds', async () => {
    await offline.belongsTo(ANNA);
    for (let plan = 0; plan < 85; plan += 1) await offline.remember(`/meal-plans/plan-${plan}`, { plan });
    // The first is read again: it is no longer the oldest.
    await offline.remember('/meal-plans/plan-5', { plan: 5 });
    await offline.remember('/meal-plans/plan-85', { plan: 85 });

    expect(await stores.held(stores.names()[0]!)).toHaveLength(80);
    expect(await offline.recall('/meal-plans/plan-0')).toEqual({ found: false });
    expect(await offline.recall('/meal-plans/plan-5')).toEqual({ found: true, answer: { plan: 5 } });
    expect(await offline.recall('/meal-plans/plan-85')).toEqual({ found: true, answer: { plan: 85 } });
  });
});

describe('the ticks of a shopping list that wait for the server', () => {
  const tick = (itemId: string, checked = true) => ({ listId: 'list', itemId, checked });

  beforeEach(async () => {
    vi.stubGlobal('caches', aCacheStorage());
    localStorage.clear();
    await offline.forget();
    await offline.belongsTo(ANNA);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wait in the order they were made, a row once, with what was said of it last', () => {
    offline.wait(tick('rice'));
    offline.wait(tick('oats'));
    offline.wait(tick('rice', false));

    expect(offline.waiting).toEqual([tick('oats'), tick('rice', false)]);
  });

  it('are not kept for nobody, nor beyond the most that can wait', async () => {
    for (let row = 0; row < MOST_WAITING; row += 1) expect(offline.wait(tick(`row-${row}`))).toBe(true);
    expect(offline.wait(tick('one-more'))).toBe(false);
    // A row that waits already can still change its mind.
    expect(offline.wait(tick('row-3', false))).toBe(true);
    expect(offline.waiting).toHaveLength(MOST_WAITING);

    await offline.forget();
    expect(offline.wait(tick('rice'))).toBe(false);
  });

  it('are sent in their order once the server is back, and wait no longer', async () => {
    offline.wait(tick('rice'));
    offline.wait(tick('oats', false));
    const send = vi.fn().mockResolvedValue(undefined);

    expect(await offline.replay(send)).toEqual({ sent: 2, refused: 0, left: 0 });
    expect(send.mock.calls.map(([sent]) => sent)).toEqual([tick('rice'), tick('oats', false)]);
    expect(offline.waiting).toEqual([]);
  });

  it('go on waiting from the one the server could not be reached for', async () => {
    offline.wait(tick('rice'));
    offline.wait(tick('oats'));
    offline.wait(tick('tofu'));
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new ApiClientError(0, 'NETWORK', 'no answer'));

    expect(await offline.replay(send)).toEqual({ sent: 1, refused: 0, left: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(offline.waiting).toEqual([tick('oats'), tick('tofu')]);
  });

  it('are dropped when the server refuses them, and the ones after them are sent', async () => {
    offline.wait(tick('rice'));
    offline.wait(tick('oats'));
    const send = vi.fn().mockRejectedValueOnce(new ApiClientError(404, 'LIST_NOT_FOUND', 'gone')).mockResolvedValue(undefined);

    expect(await offline.replay(send)).toEqual({ sent: 1, refused: 1, left: 0 });
    expect(offline.waiting).toEqual([]);
  });

  it('are nothing to send when none waits', async () => {
    const send = vi.fn();

    expect(await offline.replay(send)).toEqual({ sent: 0, refused: 0, left: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
