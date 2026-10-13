// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { barriers, expect, navigation, settled, test } from './fixtures';

type Texts = Record<string, string>;

/** A text of the application with its values put in. */
const said = (text: string, values: Record<string, string | number>): string => text.replace(/\{(\w+)\}/g, (_whole, name: string) => String(values[name]));

test.describe('somebody who comes to the instance for the first time', () => {
  test('makes an account, a profile, a plan and a shopping list, each from the page the one before led to', async ({ anonymous: page, messages }) => {
    const auth = messages.auth as Texts;
    const profile = messages.profile as Texts;
    const wizard = (messages.profile as unknown as { wizard: Texts }).wizard;
    const common = messages.common as Texts;
    const plans = messages.mealPlans as Texts;
    const lists = messages.shoppingLists as Texts;
    const answer = (method: string, path: string | RegExp) =>
      page.waitForResponse((res) => res.request().method() === method && (typeof path === 'string' ? new URL(res.url()).pathname === path : path.test(new URL(res.url()).pathname)));

    // An account, from the first page a visitor sees.
    await page.goto('/');
    await page.getByRole('link', { name: (messages.landing as Texts).getStarted!, exact: true }).click();
    await page.waitForURL('**/register');
    await page.getByLabel(auth.name!, { exact: true }).fill('Anna');
    await page.getByLabel(auth.email!, { exact: true }).fill(`browser-journey-${Date.now().toString(36)}@example.test`);
    await page.getByLabel(auth.password!, { exact: true }).fill('Browser-Test-Passw0rd');
    const opened = answer('POST', '/api/auth/register');
    await page.getByRole('button', { name: auth.createAccountButton!, exact: true }).click();
    expect((await opened).status()).toBe(201);
    await page.waitForURL('**/dashboard');
    await settled(page);
    expect(await barriers(page), 'the dashboard of an account that has nothing yet').toEqual([]);

    // A profile: the dashboard has nothing else to offer an account without one.
    await page.getByRole('link', { name: (messages.dashboard as Texts).createFirstProfileCta!, exact: true }).click();
    await page.waitForURL('**/profile');
    await page.getByLabel(new RegExp(`^${profile.name!}`)).fill('Anna');
    await page.getByLabel(profile.age!, { exact: true }).fill('34');
    await page.getByLabel(profile.heightCm!, { exact: true }).fill('168');
    // An account that has not said which unit it weighs in is given the one of where its browser says it is.
    const inPounds = (await page.getByText(/^(Weight|Waga) \(lb\)$/).count()) > 0;
    await page.getByRole('spinbutton', { name: /^(Weight|Waga) \((kg|lb)\)$/ }).fill(inPounds ? '154' : '70');
    await page.getByRole('button', { name: common.next!, exact: true }).click();
    await page.getByRole('button', { name: common.next!, exact: true }).click();
    const kept = answer('POST', '/api/profiles');
    await page.getByRole('button', { name: profile.createProfile!, exact: true }).click();
    const { id: profileId } = (await (await kept).json()) as { id: string };
    await expect(page.getByText(said(wizard.made!, { name: 'Anna' }), { exact: true })).toBeVisible();

    // A plan, as the form offers one to somebody who changes nothing.
    await page.getByRole('link', { name: wizard.madeCta!, exact: true }).click();
    await page.waitForURL(`**/meal-plans?profile=${profileId}`);
    await settled(page);
    const planned = answer('POST', '/api/meal-plans/generate');
    await page.getByRole('button', { name: plans.generateButton!, exact: true }).click();
    const plan = (await (await planned).json()) as { id: string; days: { meals: { recipe: { title: string } | null }[] }[] };
    expect(plan.days.length).toBeGreaterThan(0);
    // The new plan opens by itself, with the meals it was answered with.
    await expect(page.getByRole('button', { name: plans.hidePlan! })).toBeVisible();
    await expect(page.getByText(plan.days[0]!.meals[0]!.recipe!.title, { exact: true }).first()).toBeVisible();
    expect(await barriers(page), 'the first plan, with its days open').toEqual([]);

    // A shopping list: the page says that the plan has none, and makes it.
    await (await navigation(page, messages)).getByRole('link', { name: (messages.nav as Texts).shoppingLists!, exact: true }).click();
    await page.waitForURL('**/shopping-lists**');
    await settled(page);
    await expect(page.getByRole('heading', { name: lists.noListsTitle!, exact: true })).toBeVisible();
    const listed = answer('POST', '/api/shopping-lists/generate');
    await page.getByRole('button', { name: lists.noListsCta!, exact: true }).click();
    const list = (await (await listed).json()) as { planId: string; groups: { items: unknown[] }[] };
    expect(list.planId).toBe(plan.id);
    const entries = page.getByRole('main').getByRole('checkbox');
    await expect(entries).toHaveCount(list.groups.reduce((sum, group) => sum + group.items.length, 0));
    expect(await barriers(page), 'the first shopping list').toEqual([]);

    // What is ticked off in the shop is kept. The page shows an entry as ticked once the API has it.
    const name = await entries.first().getAttribute('aria-label');
    const entry = page.getByRole('main').getByRole('checkbox', { name: name!, exact: true });
    const ticked = answer('PATCH', /^\/api\/shopping-lists\/[^/]+\/items\/[^/]+$/);
    await entry.click();
    expect((await ticked).ok()).toBe(true);
    await expect(entry).toBeChecked();
    await page.reload();
    await settled(page);
    await expect(entry).toBeChecked();
  });
});
