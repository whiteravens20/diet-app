// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page, Response } from '@playwright/test';
import { expect, settled, test, type Messages } from './fixtures';

type Texts = Record<string, string>;
const textsOf = (messages: Messages, group: string): Texts => messages[group] as Texts;

/** The answer to the next change of the profile, whole (`PUT`) or of its preferences (`PATCH`). */
const changed = (page: Page, method: 'PUT' | 'PATCH'): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === method &&
      /^\/api\/profiles\/[^/]+(\/preferences)?$/.test(new URL(res.url()).pathname),
  );

/** The profile page with the form of the account's profile open. */
async function editing(page: Page, messages: Messages): Promise<void> {
  await page.goto('/profile');
  await settled(page);
  await page
    .getByRole('button', { name: textsOf(messages, 'common').edit!, exact: true })
    .first()
    .click();
  // The field is named by its label and the line under it: it is found by how its name begins.
  await expect(page.getByLabel(new RegExp(`^${textsOf(messages, 'profile').name!}`))).toBeVisible();
}

test.describe('what a profile says of how it eats', () => {
  test('goes to the custom diet with a split of its own, which the plan form then offers, and back to the diet it had', async ({
    session,
    messages,
  }) => {
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
    await expect(
      page.getByText(profile.splitSumOff!.replace('{sum}', '105'), { exact: true }),
    ).toBeVisible();
    await page.getByLabel(split.fat!, { exact: true }).fill('40');
    await page.getByLabel(split.carbs!, { exact: true }).fill('30');
    const toCustom = changed(page, 'PUT');
    await save().click();
    expect(await (await toCustom).json()).toMatchObject({
      dietType: 'custom',
      customMacroSplit: { protein: 30, fat: 40, carbs: 30 },
    });

    // A plan can now be made for the custom diet, and the form names the split it would aim at.
    await page.goto('/meal-plans');
    await settled(page);
    const offered = page
      .getByLabel(new RegExp(`^${textsOf(messages, 'mealPlans').diet!}`))
      .locator('option[value="custom"]');
    await expect(offered).toHaveCount(1);
    await expect(offered).toHaveText(/30.*40.*30/);

    // Back to the diet it had, so that the tests after this one find the profile they expect. The split stays with it.
    await editing(page, messages);
    await diet().selectOption(before);
    const back = changed(page, 'PUT');
    await save().click();
    expect(await (await back).json()).toMatchObject({
      dietType: before,
      customMacroSplit: { protein: 30, fat: 40, carbs: 30 },
    });
  });

  test('ticks a cuisine it likes, which stays ticked, and unticks it again', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const profile = textsOf(messages, 'profile');
    const asian = (messages.enums as unknown as { cuisine: Texts }).cuisine.asian!;
    const cuisine = () =>
      page
        .getByRole('group', { name: profile.cuisinesLabel!, exact: true })
        .getByRole('checkbox', { name: asian, exact: true });
    await page.goto('/profile');
    await settled(page);
    await expect(cuisine()).not.toBeChecked();

    const liked = changed(page, 'PATCH');
    await cuisine().check();
    expect(
      ((await (await liked).json()) as { preferences: { preferredCuisines: string[] } }).preferences
        .preferredCuisines,
    ).toEqual(['asian']);
    await page.reload();
    await settled(page);
    await expect(cuisine()).toBeChecked();

    const cleared = changed(page, 'PATCH');
    await cuisine().uncheck();
    expect(
      ((await (await cleared).json()) as { preferences: { preferredCuisines: string[] } })
        .preferences.preferredCuisines,
    ).toEqual([]);
  });

  test('picks a food it would rather not eat from the catalogue, and takes it off the list again', async ({
    session,
    messages,
    appLocale,
  }) => {
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
    const ids = (
      (await (await picked).json()) as { preferences: { dislikedIngredientIds: string[] } }
    ).preferences.dislikedIngredientIds;
    expect(ids).toHaveLength(1);
    await expect(list.getByRole('button', { name: remove })).toHaveCount(1);

    const taken = changed(page, 'PATCH');
    await list.getByRole('button', { name: remove }).click();
    expect(
      ((await (await taken).json()) as { preferences: { dislikedIngredientIds: string[] } })
        .preferences.dislikedIngredientIds,
    ).toEqual([]);
    await expect(list.getByRole('button', { name: remove })).toHaveCount(0);
  });
});

test.describe('the profiles of an account', () => {
  test('are as many as the instance gives an account: another is made in the page, and taken away again', async ({
    session,
    messages,
    account,
    request,
  }) => {
    const page = session.page;
    const profile = textsOf(messages, 'profile');
    const common = textsOf(messages, 'common');
    const most = (
      (await (await page.request.get('/api/config')).json()) as {
        accounts: { maxProfiles: number };
      }
    ).accounts.maxProfiles;
    test.skip(most < 2, 'this instance gives an account one profile');
    await page.goto('/profile');
    await settled(page);
    const add = page.getByRole('button', { name: profile.addProfile!, exact: true });

    await add.click();
    await page.getByLabel(new RegExp(`^${profile.name!}`)).fill('A second one');
    await page.getByLabel(profile.age!, { exact: true }).fill('41');
    await page.getByLabel(profile.heightCm!, { exact: true }).fill('168');
    const weight = page.getByRole('spinbutton', { name: /^(Weight|Waga) \((kg|lb)\)$/ });
    await weight.fill((await page.getByText(/^(Weight|Waga) \(lb\)$/).count()) > 0 ? '141' : '64');
    const made = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/profiles',
    );
    await page.getByRole('button', { name: profile.createProfile!, exact: true }).click();
    const answered = await made;
    expect(answered.status()).toBe(201);
    const second = ((await answered.json()) as { id: string }).id;

    try {
      // The account has one more profile, with a row of its own; at the most it may have, the way to add one is gone.
      const remove = page.getByRole('button', { name: common.delete!, exact: true });
      const row = page
        .locator('div')
        .filter({ has: page.getByText('A second one', { exact: true }) })
        .filter({ has: remove })
        .last();
      await expect(row).toBeVisible();
      await expect(remove).toHaveCount(2);
      if (most === 2) await expect(add).toHaveCount(0);

      page.once('dialog', (asked) => void asked.accept());
      const gone = page.waitForResponse(
        (res) =>
          res.request().method() === 'DELETE' &&
          new URL(res.url()).pathname === `/api/profiles/${second}`,
      );
      await row.getByRole('button', { name: common.delete!, exact: true }).click();
      expect((await gone).ok()).toBe(true);
      await expect(remove).toHaveCount(1);
      await expect(add).toBeVisible();
    } finally {
      // Whatever became of the page, the account is left with the one profile the other tests count on.
      const signedIn = await request.post('/api/auth/login', {
        data: { email: account.email, password: account.password },
      });
      const token = ((await signedIn.json()) as { tokens?: { accessToken: string } }).tokens
        ?.accessToken;
      if (token)
        await request.delete(`/api/profiles/${second}`, {
          headers: { authorization: `Bearer ${token}` },
        });
    }
  });
});
