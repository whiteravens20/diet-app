// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { barriers, expect, settled, signInHere, test } from './fixtures';

type Texts = Record<string, string>;

/** A text of the application with its values put in. */
const said = (text: string, values: Record<string, string | number>): string => text.replace(/\{(\w+)\}/g, (_whole, name: string) => String(values[name]));

test.describe('an account that has just been made', () => {
  test('is led from the dashboard through the three steps of a first profile, sees what its figures come to, and on to its first plan', async ({ anonymous: page, request, messages }) => {
    const profile = messages.profile as Texts;
    const wizard = (messages.profile as unknown as { wizard: Texts & { steps: Texts } }).wizard;
    const preview = messages.caloriePreview as Texts;
    const common = messages.common as Texts;
    const heading = (step: number, name: string) => page.getByRole('heading', { name: said(wizard.progress!, { step, of: 3, name }), exact: true });

    // An account of its own: the one the other tests share has a profile already.
    const email = `browser-first-${Date.now().toString(36)}@example.test`;
    const password = 'Browser-Test-Passw0rd';
    const registered = await request.post('/api/auth/register', { data: { email, password, displayName: 'First profile' } });
    expect(registered.ok(), await registered.text()).toBe(true);
    await page.goto('/login');
    await signInHere(page, { email, password }, messages);
    await page.waitForURL('**/dashboard');
    await settled(page);

    await page.getByRole('link', { name: (messages.dashboard as Texts).createFirstProfileCta!, exact: true }).click();
    await page.waitForURL('**/profile');
    await expect(heading(1, wizard.steps.body!)).toBeVisible();
    // Nothing is worked out from numbers nobody typed.
    await expect(page.getByText(preview.pending!, { exact: true })).toBeVisible();
    await expect(page.getByLabel(profile.age!, { exact: true })).toHaveValue('');

    // A step whose fields are not filled does not let the reader on.
    await page.getByRole('button', { name: common.next!, exact: true }).click();
    await expect(heading(1, wizard.steps.body!)).toBeVisible();

    await page.getByLabel(new RegExp(`^${profile.name!}`)).fill('Anna');
    await page.getByLabel(profile.age!, { exact: true }).fill('34');
    await page.getByLabel(profile.heightCm!, { exact: true }).fill('168');
    // An account that has not said which unit it weighs in is given the one of where its browser says it is.
    const weight = page.getByRole('spinbutton', { name: /^(Weight|Waga) \((kg|lb)\)$/ });
    const inPounds = (await page.getByText(/^(Weight|Waga) \(lb\)$/).count()) > 0;
    await weight.fill(inPounds ? '154' : '70');
    // The figures follow what was typed, without anything being sent for keeping.
    const target = page.locator('section', { has: page.getByRole('heading', { name: preview.title!, exact: true }) }).locator('dd').first();
    await expect(target).toHaveText(/\d.*kcal/);
    await expect(page.getByText(preview.pending!, { exact: true })).toHaveCount(0);
    expect(await barriers(page), 'the step that asks for the body').toEqual([]);

    await page.getByRole('button', { name: common.next!, exact: true }).click();
    await expect(heading(2, wizard.steps.goal!)).toBeFocused();
    // Every pace says what it comes to in a day.
    const paces = page.getByRole('group', { name: profile.pace!, exact: true }).locator('label');
    await expect(paces).toHaveCount(5);
    for (const pace of await paces.all()) await expect(pace).toContainText('kcal');
    const paced = await target.textContent();
    await paces.first().click();
    await expect(target).not.toHaveText(paced!);
    await expect(page.getByText(preview.atMaintenance!, { exact: true })).toBeVisible();
    expect(await barriers(page), 'the step that asks for the goal').toEqual([]);

    await page.getByRole('button', { name: common.next!, exact: true }).click();
    await expect(heading(3, wizard.steps.food!)).toBeFocused();
    // Back finds the step as it was left.
    await page.getByRole('button', { name: common.back!, exact: true }).click();
    await expect(paces.first().getByRole('radio')).toBeChecked();
    await page.getByRole('button', { name: common.next!, exact: true }).click();
    expect(await barriers(page), 'the step that asks how its owner eats').toEqual([]);

    const made = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/profiles');
    await page.getByRole('button', { name: profile.createProfile!, exact: true }).click();
    const kept = (await (await made).json()) as { id: string; name: string; age: number; weeklyLossTarget: string | null };
    expect(kept).toMatchObject({ name: 'Anna', age: 34, weeklyLossTarget: null });

    // The page says what comes next, and leads there.
    await expect(page.getByText(said(wizard.made!, { name: 'Anna' }), { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^(Step|Krok) / })).toHaveCount(0);
    await page.getByRole('link', { name: wizard.madeCta!, exact: true }).click();
    await page.waitForURL(`**/meal-plans?profile=${kept.id}`);
    await settled(page);
    await expect(page.getByRole('button', { name: (messages.mealPlans as Texts).generateButton!, exact: true })).toBeVisible();
  });
});
