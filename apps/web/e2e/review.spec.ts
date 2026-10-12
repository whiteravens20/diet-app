// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page, Route } from '@playwright/test';
import { barriers, expect, test } from './fixtures';

type Texts = Record<string, string>;

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

const draft = (id: string, title: string) => ({
  id,
  slug: title.toLowerCase().replaceAll(' ', '-'),
  locale: 'pl',
  title,
  titleSource: `${title} (English)`,
  description: 'Opis dania.',
  descriptionSource: 'What the dish is.',
  steps: ['Ugotuj.', 'Podaj.'],
  stepsSource: ['Cook.', 'Serve.'],
  servings: 2,
  mealTypes: ['breakfast'],
  dietTags: ['balanced'],
  prepMinutes: 5,
  cookMinutes: 10,
  difficulty: 'easy',
  complexity: 'simple',
  caloriesPerServing: 420,
  proteinPerServing: 20,
  fatPerServing: 12,
  carbsPerServing: 55,
  allergens: ['dairy', 'nuts'],
  ingredients: [],
  batchId: 'batch-1',
  modelUsed: null,
  status: 'PENDING',
  alreadyReviewed: false,
  alreadyReviewedAction: null,
});

/**
 * A reviewer who is signed in, with three Polish recipe drafts waiting. The
 * server's answers are given here: what is under test is the page in a
 * browser, where the focus is and what a key does. Returns what the page
 * asked the server to decide, in order.
 */
async function aQueue(page: Page): Promise<string[]> {
  const waiting = [draft(FIRST, 'Owsianka'), draft(SECOND, 'Jajecznica'), draft(THIRD, 'Kanapka')];
  const decided: string[] = [];
  const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/review/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/review/, '');
    if (path === '/status') return json(route, { enabled: true, passwordSet: true, locales: ['pl'] });
    if (path === '/session') return json(route, { session: { label: 'Anna', issuedAt: '2026-10-12T08:00:00.000Z' } });
    if (path === '/drafts/recipes') return json(route, { items: waiting, total: waiting.length, page: 1, pageSize: 25 });
    const [, id, action] = /^\/drafts\/recipes\/([0-9a-f-]+)(?:\/(approve|reject))?$/.exec(path) ?? [];
    const at = waiting.findIndex((slice) => slice.id === id);
    if (at < 0) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'NOT_FOUND', message: 'No such draft.' }) });
    const slice = waiting[at]!;
    if (request.method() === 'PATCH') {
      Object.assign(slice, request.postDataJSON() as object);
      decided.push(`save ${slice.title}`);
      return json(route, slice);
    }
    decided.push(`${action} ${slice.title}`);
    waiting.splice(at, 1);
    return json(route, slice);
  });
  return decided;
}

test.describe('the reviewer\'s queue in a browser, with the server\'s answers given', () => {
  test('a letter decides nothing until the keys are turned on; then the keys decide and move, and the draft that comes up has the focus', async ({ anonymous: page, messages }) => {
    const text = messages.review as Texts;
    const decided = await aQueue(page);
    const shown = (current: number, visible: number) => page.getByRole('group', { name: text.draftLabel!.replace('{current}', String(current)).replace('{visible}', String(visible)) });
    const title = page.getByRole('textbox', { name: text.fieldTitle!, exact: true });
    await page.goto('/review');
    await expect(shown(1, 3)).toBeVisible();
    await expect(title).toHaveValue('Owsianka');

    // Off: the draft is no stop of the Tab key, and a letter typed on it is nothing.
    await expect(shown(1, 3)).not.toBeFocused();
    await shown(1, 3).focus();
    await page.keyboard.type('arj');
    await expect(title).toHaveValue('Owsianka');
    expect(decided).toEqual([]);

    // On: the page says what each key does, and turning them on moved no focus.
    const keys = page.getByRole('button', { name: text.keys!, exact: true });
    await keys.click();
    await expect(keys).toHaveAttribute('aria-pressed', 'true');
    await expect(keys).toBeFocused();
    await expect(page.getByRole('button', { name: text.approve!, exact: true })).toHaveAttribute('aria-keyshortcuts', 'A');

    // The draft after and the draft before.
    await shown(1, 3).focus();
    await page.keyboard.press('j');
    await expect(shown(2, 3)).toBeFocused();
    await expect(title).toHaveValue('Jajecznica');
    await page.keyboard.press('ArrowLeft');
    await expect(shown(1, 3)).toBeFocused();
    await expect(title).toHaveValue('Owsianka');

    // A letter typed into a field is a letter; Escape gives the keys back.
    await title.click();
    await page.keyboard.type(' a');
    await expect(title).toHaveValue('Owsianka a');
    expect(decided).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(shown(1, 3)).toBeFocused();

    // A approves what is on show, with the text as it was typed; the next draft has the focus.
    await page.keyboard.press('a');
    await expect(shown(1, 2)).toBeFocused();
    await expect(title).toHaveValue('Jajecznica');
    expect(decided).toEqual(['save Owsianka a', 'approve Owsianka a']);

    // R rejects it.
    await page.keyboard.press('r');
    await expect(shown(1, 1)).toBeFocused();
    await expect(title).toHaveValue('Kanapka');
    expect(decided.at(-1)).toBe('reject Jajecznica');

    // With the keys on, nothing stands in the way of using the page.
    expect(await barriers(page)).toEqual([]);

    // The choice is kept: on the next visit the keys are on and the draft has the focus.
    await page.reload();
    await expect(shown(1, 1)).toBeFocused();
    await expect(page.getByRole('button', { name: text.keys!, exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('with the keys off, the draft that comes up after a decision takes the focus the pressed button lost', async ({ anonymous: page, messages }) => {
    const text = messages.review as Texts;
    const decided = await aQueue(page);
    await page.goto('/review');
    const first = page.getByRole('group', { name: text.draftLabel!.replace('{current}', '1').replace('{visible}', '3') });
    await expect(first).toBeVisible();
    await expect(first).not.toBeFocused();

    await page.getByRole('button', { name: text.approve!, exact: true }).click();

    await expect(page.getByRole('group', { name: text.draftLabel!.replace('{current}', '1').replace('{visible}', '2') })).toBeFocused();
    expect(decided).toEqual(['approve Owsianka']);
    // Names where a reviewer reads them: the allergens by name, the buttons that move by what they do.
    const allergens = messages.enums as unknown as { allergen: Texts };
    await expect(page.getByText(`${allergens.allergen.dairy!}`, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: text.next!, exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: text.previous!, exact: true })).toBeDisabled();
    expect(await barriers(page)).toEqual([]);
  });
});
