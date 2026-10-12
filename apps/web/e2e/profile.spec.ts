// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page, Response } from '@playwright/test';
import { expect, settled, test, type Messages } from './fixtures';

type Texts = Record<string, string>;
const textsOf = (messages: Messages, group: string): Texts => messages[group] as Texts;

/** The answer to the next change of the profile, whole (`PUT`) or of its preferences (`PATCH`). */
const changed = (page: Page, method: 'PUT' | 'PATCH'): Promise<Response> =>
  page.waitForResponse((res) => res.request().method() === method && /^\/api\/profiles\/[^/]+(\/preferences)?$/.test(new URL(res.url()).pathname));

/** The profile page with the form of the account's profile open. */
async function editing(page: Page, messages: Messages): Promise<void> {
  await page.goto('/profile');
  await settled(page);
  await page.getByRole('button', { name: textsOf(messages, 'common').edit!, exact: true }).first().click();
  await expect(page.getByLabel(textsOf(messages, 'profile').name!, { exact: true })).toBeVisible();
}

test.describe('what a profile says of how it eats', () => {
  test('goes to the custom diet with a split of its own, which the plan form then offers, and back to the diet it had', async ({ session, messages }) => {
    const page = session.page;
    const profile = textsOf(messages, 'profile');
    const split = (messages.profile as unknown as { split: Texts }).split;
    // A label that holds a list of choices reads with them: it is found by how it begins.
    const diet = () => page.getByLabel(new RegExp(`^${profile.dietType!}`));
    const save = () => page.getByRole('button', { name: profile.saveChanges!, exact: true });

    await editing(page, messages);
    const before = await diet().inputValue();
    await diet().selectOption('custom');

    // The form says what the three shares add up to while they are typed: 30, 30 and 45 are 105.
    await page.getByLabel(split.protein!, { exact: true }).fill('30');
    await expect(page.getByText(profile.splitSumOff!.replace('{sum}', '105'), { exact: true })).toBeVisible();
    await page.getByLabel(split.fat!, { exact: true }).fill('40');
    await page.getByLabel(split.carbs!, { exact: true }).fill('30');
    const toCustom = changed(page, 'PUT');
    await save().click();
    expect(await (await toCustom).json()).toMatchObject({ dietType: 'custom', customMacroSplit: { protein: 30, fat: 40, carbs: 30 } });

    // A plan can now be made for the custom diet, and the form names the split it would aim at.
    await page.goto('/meal-plans');
    await settled(page);
    const offered = page.getByLabel(new RegExp(`^${textsOf(messages, 'mealPlans').diet!}`)).locator('option[value="custom"]');
    await expect(offered).toHaveCount(1);
    await expect(offered).toHaveText(/30.*40.*30/);

    // Back to the diet it had, so that the tests after this one find the profile they expect. The split stays with it.
    await editing(page, messages);
    await diet().selectOption(before);
    const back = changed(page, 'PUT');
    await save().click();
    expect(await (await back).json()).toMatchObject({ dietType: before, customMacroSplit: { protein: 30, fat: 40, carbs: 30 } });
  });

  test('ticks a cuisine it likes, which stays ticked, and unticks it again', async ({ session, messages }) => {
    const page = session.page;
    const profile = textsOf(messages, 'profile');
    const asian = (messages.enums as unknown as { cuisine: Texts }).cuisine.asian!;
    const cuisine = () => page.getByRole('group', { name: profile.cuisinesLabel!, exact: true }).getByRole('checkbox', { name: asian, exact: true });
    await page.goto('/profile');
    await settled(page);
    await expect(cuisine()).not.toBeChecked();

    const liked = changed(page, 'PATCH');
    await cuisine().check();
    expect(((await (await liked).json()) as { preferences: { preferredCuisines: string[] } }).preferences.preferredCuisines).toEqual(['asian']);
    await page.reload();
    await settled(page);
    await expect(cuisine()).toBeChecked();

    const cleared = changed(page, 'PATCH');
    await cuisine().uncheck();
    expect(((await (await cleared).json()) as { preferences: { preferredCuisines: string[] } }).preferences.preferredCuisines).toEqual([]);
  });

  test('picks a food it would rather not eat from the catalogue, and takes it off the list again', async ({ session, messages, appLocale }) => {
    const page = session.page;
    const profile = textsOf(messages, 'profile');
    const remove = new RegExp(`^${textsOf(messages, 'pickers').remove!.replace('{name}', '')}`);
    // Three lists of ingredients stand on the page, each named by its heading, each with a search field of its own.
    const list = page.getByRole('group', { name: profile.dislikedLabel!, exact: true });
    await page.goto('/profile');
    await settled(page);

    await list.getByRole('textbox').fill(appLocale === 'pl' ? 'ryż' : 'rice');
    const picked = changed(page, 'PATCH');
    await list.getByRole('listitem').getByRole('button').first().click();
    const ids = ((await (await picked).json()) as { preferences: { dislikedIngredientIds: string[] } }).preferences.dislikedIngredientIds;
    expect(ids).toHaveLength(1);
    await expect(list.getByRole('button', { name: remove })).toHaveCount(1);

    const taken = changed(page, 'PATCH');
    await list.getByRole('button', { name: remove }).click();
    expect(((await (await taken).json()) as { preferences: { dislikedIngredientIds: string[] } }).preferences.dislikedIngredientIds).toEqual([]);
    await expect(list.getByRole('button', { name: remove })).toHaveCount(0);
  });
});
