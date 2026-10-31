// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Locator, Page } from '@playwright/test';
import { barriers, expect, settled, test, type Messages } from './fixtures';

type Texts = Record<string, string>;
const plansOf = (messages: Messages): Texts => messages.mealPlans as Texts;
const rerollOf = (messages: Messages): Texts =>
  (messages.mealPlans as unknown as { reroll: Texts }).reroll;

/** The plan page with the first plan of the list open. */
async function anOpenPlan(page: Page, messages: Messages): Promise<void> {
  const plans = plansOf(messages);
  await page.goto('/meal-plans');
  await settled(page);
  await page.getByRole('button', { name: plans.showPlan! }).first().click();
  await expect(page.getByRole('button', { name: plans.addCustomMeal! }).first()).toBeVisible();
}

/** The name of a control of a meal: what it does, then the meal it does it to. */
const ofAMeal = (action: string): RegExp =>
  new RegExp(`^${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `);

/** The ways to change the first meal that can be changed, unfolded. */
async function waysToChangeAMeal(page: Page, messages: Messages): Promise<Locator> {
  const plans = plansOf(messages);
  await page
    .getByRole('button', { name: ofAMeal(plans.changeMeal!) })
    .first()
    .click();
  const ways = page
    .getByRole('group')
    .filter({ has: page.getByRole('button', { name: ofAMeal(plans.swap!) }) })
    .first();
  await expect(ways).toBeVisible();
  return ways;
}

test.describe('a plan and what it is made for', () => {
  test('the form makes a plan for the meals a day and the target it names', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const plans = plansOf(messages);
    await page.goto('/meal-plans');
    await settled(page);

    // A label that holds a list of choices reads with them: it is found by how it begins.
    await page.getByLabel(new RegExp(`^${plans.mealsPerDay!}`)).selectOption('2');
    await page.getByLabel(plans.calorieTarget!, { exact: true }).fill('1900');
    const answered = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/meal-plans/generate',
    );
    await page.getByRole('button', { name: plans.generateButton!, exact: true }).click();

    const answer = await answered;
    const asked = answer.request().postDataJSON() as Record<string, unknown>;
    const made = (await answer.json()) as {
      id: string;
      days: { calorieTarget: number; meals: unknown[] }[];
      options: Record<string, unknown>;
    };
    expect(asked).toMatchObject({ mealCount: 2, calorieTargetOverride: 1900 });
    // What the form left to the profile is not asked for, and not written on the plan: the plan follows the profile there when it is made again.
    expect(asked).not.toHaveProperty('dietType');
    expect(made.options).toMatchObject({
      mealCount: 2,
      calorieTargetOverride: 1900,
      dietType: null,
    });
    expect(made.days.map((day) => [day.meals.length, day.calorieTarget])).toEqual(
      made.days.map(() => [2, 1900]),
    );
    // The new plan opens by itself, and each of its days says what it aims at.
    await expect(page.getByText(/\/ 1900 kcal/).first()).toBeVisible();

    // The plan was made for this test. It goes again, so that the tests after this one find what the account had: a plan with a shopping list.
    page.once('dialog', (confirm) => void confirm.accept());
    const gone = page.waitForResponse(
      (res) =>
        res.request().method() === 'DELETE' &&
        new URL(res.url()).pathname === `/api/meal-plans/${made.id}`,
    );
    const head = page.getByRole('button', { name: plans.hidePlan! });
    await head
      .locator('xpath=..')
      .getByRole('button', { name: (messages.common as Texts).delete!, exact: true })
      .click();
    expect((await gone).status()).toBe(204);
    await expect(head).toHaveCount(0);
  });
});

test.describe('a plan that is made again', () => {
  test('is asked for in one window that says what would be replaced before it asks, and one day of it gets other meals', async ({
    session,
    messages,
    account,
    request,
  }) => {
    const page = session.page;
    const plans = plansOf(messages);
    const reroll = rerollOf(messages);
    // A plan that begins on the page's own day, made for this test: the account's plan was made when the run began, and
    // in a run that goes on past midnight it began the day before. The newest plan of the latest day is the first listed.
    const today = await page.evaluate(() => {
      const now = new Date();
      const two = (n: number): string => String(n).padStart(2, '0');
      return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
    });
    const signedIn = await request.post('/api/auth/login', {
      data: { email: account.email, password: account.password },
    });
    expect(signedIn.ok()).toBe(true);
    const headers = {
      authorization: `Bearer ${((await signedIn.json()) as { tokens: { accessToken: string } }).tokens.accessToken}`,
      'x-client-date': today,
    };
    const made = await request.post('/api/meal-plans/generate', {
      headers,
      data: { profileId: account.profileId, startDate: today, durationDays: 3 },
    });
    expect(made.status()).toBe(201);
    const plan = (await made.json()) as { id: string };

    try {
      await anOpenPlan(page, messages);

      await page.getByRole('button', { name: plans.recalculate!, exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: reroll.title! });
      const confirm = dialog.getByRole('button', { name: reroll.confirm!, exact: true });
      await expect(confirm).toBeEnabled();
      // The plan begins today: nothing of it has passed, and what is left of it is the whole of it.
      await expect(
        dialog.getByText(new RegExp(`^${reroll.replaced!.split(':')[0]}:`)),
      ).toBeVisible();
      await expect(dialog.getByLabel(reroll.fromToday!, { exact: true })).toBeDisabled();
      await expect(dialog.getByText(reroll.fromTodayNotBegun!)).toBeVisible();
      await expect(dialog.getByLabel(reroll.includePast!, { exact: true })).toHaveCount(0);

      await dialog.getByLabel(reroll.day!, { exact: true }).check();
      await expect(dialog.getByLabel(reroll.dayWhich!, { exact: true })).toBeVisible();
      const asked = page.waitForResponse((res) =>
        /^\/api\/meal-plans\/[^/]+\/days\/[^/]+\/regenerate$/.test(new URL(res.url()).pathname),
      );
      await confirm.click();

      expect((await asked).ok()).toBe(true);
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: plans.addCustomMeal! }).first()).toBeVisible();
    } finally {
      // The plan goes again, so that the tests after this one find what the account had.
      await request.delete(`/api/meal-plans/${plan.id}`, { headers });
    }
  });

  test('opens on the day whose own button was pressed', async ({ session, messages }) => {
    const page = session.page;
    const plans = plansOf(messages);
    const reroll = rerollOf(messages);
    await anOpenPlan(page, messages);

    // The second day is unfolded beside the first: the second button of its kind on the page.
    await page.locator('[id^="plan-"] > button[aria-expanded="false"]').first().click();
    await page.getByRole('button', { name: plans.changeDay!, exact: true }).nth(1).click();
    const dialog = page.getByRole('dialog', { name: reroll.title! });

    await expect(dialog.getByLabel(reroll.day!, { exact: true })).toBeChecked();
    // The second day of the plan: the second of the days the window offers.
    const which = dialog.getByLabel(reroll.dayWhich!, { exact: true });
    expect(await which.evaluate((select: HTMLSelectElement) => select.selectedIndex)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('a meal of a plan', () => {
  test('keeps the swap a model makes in its place on an account with AI off, disabled, under a line that says why', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const plans = plansOf(messages);
    await anOpenPlan(page, messages);

    // A line anybody can read, with the way to the setting: a disabled button says nothing to a finger.
    const toSettings = /<settings>(.*)<\/settings>/.exec((messages.aiOff as Texts).note!)![1]!;
    const note = page.locator('p', {
      has: page.getByRole('link', { name: toSettings, exact: true }),
    });
    await expect(note).toBeVisible();
    await expect(note.getByRole('link')).toHaveAttribute('href', '/settings?tab=ai');

    const ways = await waysToChangeAMeal(page, messages);
    const byModel = ways.getByRole('button', { name: ofAMeal(plans.aiSwap!) });
    await expect(byModel).toBeVisible();
    await expect(byModel).toBeDisabled();
    expect(await byModel.getAttribute('aria-describedby')).toBe(await note.getAttribute('id'));
    // The engine's own swap is there to use.
    await expect(ways.getByRole('button', { name: ofAMeal(plans.swap!) })).toBeEnabled();
  });

  test('folds the ways to change it behind one button', async ({ session, messages }) => {
    const page = session.page;
    const plans = plansOf(messages);
    await anOpenPlan(page, messages);
    const swap = page.getByRole('button', { name: ofAMeal(plans.swap!) }).first();
    const fold = page.getByRole('button', { name: ofAMeal(plans.changeMeal!) }).first();

    await expect(swap).toBeHidden();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(swap).toBeVisible();
    await fold.click();
    await expect(swap).toBeHidden();
  });

  test("of one's own is added in a window that says its numbers are those of one serving, and what the meal adds", async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const plans = plansOf(messages);
    await anOpenPlan(page, messages);

    await page.getByRole('button', { name: plans.addCustomMeal! }).first().click();
    const dialog = page.getByRole('dialog', { name: plans.customModalTitle! });
    await expect(dialog.getByRole('group', { name: plans.customPerServing! })).toBeVisible();
    await expect(dialog.getByText(plans.customTotalPending!)).toBeVisible();

    await dialog.getByLabel(plans.customCalories!, { exact: true }).fill('900');
    await dialog.getByLabel(plans.customProtein!, { exact: true }).fill('30');
    await dialog.getByLabel(plans.customFat!, { exact: true }).fill('20');
    await dialog.getByLabel(plans.customCarbs!, { exact: true }).fill('110');
    await dialog
      .getByRole('spinbutton', { name: new RegExp(`^${plans.customServings!}`) })
      .fill('2');

    // Two servings of 900 kcal: the day gets 1800, and the window says so before anything is sent.
    await expect(dialog.getByText(/1800 kcal/)).toBeVisible();
    await expect(dialog.getByText(plans.customTotalPending!)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('the plans of a profile, by when they are and by how their days stand', () => {
  test('are narrowed to those of a time: none that is over yet, and the one under way', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const plans = plansOf(messages);
    await page.goto('/meal-plans');
    await settled(page);
    await expect(page.getByRole('button', { name: plans.showPlan! }).first()).toBeVisible();

    const over = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/meal-plans' &&
        new URL(res.url()).searchParams.get('status') === 'past',
    );
    await page.getByRole('button', { name: plans.statusPast!, exact: true }).click();
    expect(((await (await over).json()) as { items: unknown[] }).items).toEqual([]);
    await expect(
      page.getByRole('heading', { name: plans.noPlansTitle!, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: plans.showPlan! })).toHaveCount(0);

    const underWay = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/meal-plans' &&
        new URL(res.url()).searchParams.get('status') === 'active',
    );
    await page.getByRole('button', { name: plans.statusActive!, exact: true }).click();
    expect(((await (await underWay).json()) as { items: unknown[] }).items.length).toBeGreaterThan(
      0,
    );
    await expect(page.getByRole('button', { name: plans.showPlan! }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: plans.noPlansTitle!, exact: true })).toHaveCount(
      0,
    );

    await page.getByRole('button', { name: plans.statusAll!, exact: true }).click();
    await expect(page.getByRole('button', { name: plans.showPlan! }).first()).toBeVisible();
  });

  test('are made with a day filled from a favourite set, chosen for that day in the advanced view', async ({
    session,
    messages,
    account,
    request,
  }) => {
    const page = session.page;
    const plans = plansOf(messages);
    const advanced = (messages.mealPlans as unknown as { advanced: Texts }).advanced;
    const common = messages.common as Texts;

    // The set is the account's to have, made over the API as an app of the account would make it: the recipe the
    // account marked, for the meal the account's own plan has it at.
    const signedIn = await request.post('/api/auth/login', {
      data: { email: account.email, password: account.password },
    });
    expect(signedIn.ok()).toBe(true);
    const headers = {
      authorization: `Bearer ${((await signedIn.json()) as { tokens: { accessToken: string } }).tokens.accessToken}`,
    };
    const own = (await (
      await request.get(`/api/meal-plans/${account.planId}`, { headers })
    ).json()) as { days: { meals: { mealType: string }[] }[] };
    const marked = (await (
      await request.get(`/api/recipes/${account.recipeId}`, { headers })
    ).json()) as { mealTypes: string[] };
    // A meal the recipe is for, among the meals a day of this account's plans has.
    const meal = marked.mealTypes.find((one) =>
      own.days[0]!.meals.some((planned) => planned.mealType === one),
    );
    test.skip(meal === undefined, 'the marked recipe is for none of the meals of a day');
    const kept = await request.post('/api/favorite-sets', {
      headers,
      data: {
        profileId: account.profileId,
        label: 'A day I like',
        slots: { [meal!]: account.recipeId },
      },
    });
    expect(kept.status()).toBe(201);
    const set = (await kept.json()) as { id: string };

    try {
      await page.goto('/meal-plans');
      await settled(page);
      await page.getByText(advanced.toggle!, { exact: true }).click();
      // One choice of a set for each day of the plan: the first day gets this one.
      await page
        .getByRole('combobox', { name: advanced.favoriteSet!, exact: true })
        .first()
        .selectOption(set.id);

      const asked = page.waitForRequest(
        (req) =>
          req.method() === 'POST' && new URL(req.url()).pathname === '/api/meal-plans/generate',
      );
      const made = page.waitForResponse(
        (res) => new URL(res.url()).pathname === '/api/meal-plans/generate',
      );
      await page.getByRole('button', { name: plans.generateButton!, exact: true }).click();
      const sent = (await asked).postDataJSON() as {
        dayOverrides?: { lockedSlots?: { mealType: string; recipeId: string }[] }[];
      };
      expect(sent.dayOverrides?.[0]?.lockedSlots).toEqual([
        { mealType: meal, recipeId: account.recipeId },
      ]);
      const answered = await made;
      expect(answered.status()).toBe(201);
      const plan = (await answered.json()) as {
        id: string;
        days: { meals: { mealType: string; recipe: { id: string } | null }[] }[];
      };
      // The first day holds the set's recipe at its meal; the planner filled the rest of the day around it.
      expect(plan.days[0]!.meals.find((one) => one.mealType === meal)?.recipe?.id).toBe(
        account.recipeId,
      );

      const head = page.getByRole('button', { name: plans.hidePlan! });
      await expect(head).toBeVisible();
      page.once('dialog', (confirmation) => void confirmation.accept());
      const gone = page.waitForResponse(
        (res) =>
          res.request().method() === 'DELETE' &&
          new URL(res.url()).pathname === `/api/meal-plans/${plan.id}`,
      );
      await head
        .locator('xpath=../..')
        .getByRole('button', { name: common.delete!, exact: true })
        .click();
      expect((await gone).ok()).toBe(true);
    } finally {
      await request.delete(`/api/favorite-sets/${set.id}`, { headers });
    }
  });

  test("say on a day that it stands over its target, once a meal of one's own took it there and no portion could make up for it", async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const plans = plansOf(messages);
    const common = messages.common as Texts;
    await page.goto('/meal-plans');
    await settled(page);

    // A plan made for this test and taken away after it: the account's own plan stays what the other tests find.
    const made = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/meal-plans/generate',
    );
    await page.getByRole('button', { name: plans.generateButton!, exact: true }).click();
    const plan = (await (await made).json()) as { id: string };
    const head = page.getByRole('button', { name: plans.hidePlan! });
    await expect(head).toBeVisible();
    const card = head.locator('xpath=../..');
    await expect(card.getByText(plans.dayOver!, { exact: true })).toHaveCount(0);

    await card.getByRole('button', { name: plans.addCustomMeal! }).first().click();
    const dialog = page.getByRole('dialog', { name: plans.customModalTitle! });
    await dialog.getByLabel(plans.customName!, { exact: true }).fill('A feast');
    await dialog.getByLabel(plans.customCalories!, { exact: true }).fill('2500');
    await dialog.getByLabel(plans.customProtein!, { exact: true }).fill('80');
    await dialog.getByLabel(plans.customFat!, { exact: true }).fill('90');
    await dialog.getByLabel(plans.customCarbs!, { exact: true }).fill('300');
    const added = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname.startsWith(`/api/meal-plans/${plan.id}/`),
    );
    await dialog.getByRole('button', { name: plans.customSubmit!, exact: true }).click();
    expect((await added).ok()).toBe(true);
    await expect(dialog).toBeHidden();

    // The other meals of the day are as small as they may be made, and the day still holds more than a tenth over.
    await expect(card.getByText(plans.dayOver!, { exact: true }).first()).toBeVisible();
    await expect(card.getByText(plans.dayOverHint!, { exact: true }).first()).toBeVisible();
    expect(await barriers(page), 'a plan with a day over its target').toEqual([]);

    page.once('dialog', (asked) => void asked.accept());
    const gone = page.waitForResponse(
      (res) =>
        res.request().method() === 'DELETE' &&
        new URL(res.url()).pathname === `/api/meal-plans/${plan.id}`,
    );
    await card.getByRole('button', { name: common.delete!, exact: true }).click();
    expect((await gone).ok()).toBe(true);
  });
});
