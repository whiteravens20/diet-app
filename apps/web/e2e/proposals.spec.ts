// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { barriers, expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

/** What a text says before the first thing that is put into it. */
const start = (text: string): string => text.split('{')[0]!;

test.describe('what the planner proposes for a plan', () => {
  test('offers other ways to fill a day and takes the one that is chosen, and looks for what would use up the packs the plan opens', async ({ session, messages }) => {
    const page = session.page;
    const plans = messages.mealPlans as Texts;
    const variations = (messages.mealPlans as unknown as { variations: Texts }).variations;
    const useUp = (messages.mealPlans as unknown as { useUp: Texts }).useUp;
    const packs = (messages.mealPlans as unknown as { packs: Texts }).packs;
    const weigh = messages.weigh as Texts;
    await page.goto('/meal-plans');
    await settled(page);

    // A plan made for this test, so that the account's own plan and its shopping list stay what the other tests find.
    const made = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/meal-plans/generate');
    await page.getByRole('button', { name: plans.generateButton!, exact: true }).click();
    const plan = (await (await made).json()) as { id: string; days: { id: string; meals: { recipe: { id: string } | null }[] }[] };
    const head = page.getByRole('button', { name: plans.hidePlan! });
    await expect(head).toBeVisible();
    const card = head.locator('xpath=../..');

    // Other ways for the first day of it.
    const offered = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/meal-plans/${plan.id}/days/${plan.days[0]!.id}/variations`);
    await card.getByRole('button', { name: plans.otherWays!, exact: true }).first().click();
    const ways = (await (await offered).json()) as { variations: { offer: string; meals: { recipeId: string | null }[] }[] };
    const dialog = page.getByRole('dialog').filter({ hasText: start(variations.intro!) });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(start(variations.now!)).first()).toBeVisible();
    // The account has no model to ask: the button that asks one is in its place, disabled.
    if (ways.variations.length > 0) await expect(dialog.getByRole('button', { name: weigh.ask!, exact: true })).toBeDisabled();
    expect(await barriers(page), 'the window with other ways to fill a day').toEqual([]);

    if (ways.variations.length === 0) {
      await expect(dialog.getByText(variations.none!)).toBeVisible();
      await page.keyboard.press('Escape');
    } else {
      const taken = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/meal-plans/${plan.id}/days/${plan.days[0]!.id}/variations/take`);
      await dialog.getByRole('button', { name: variations.take!, exact: true }).first().click();
      const after = (await (await taken).json()) as { days: { meals: { recipe: { id: string } | null }[] }[] };
      // The day holds the meals of the way that was first on the list.
      expect(after.days[0]!.meals.map((meal) => meal.recipe?.id ?? null)).toEqual(ways.variations[0]!.meals.map((meal) => meal.recipeId));
    }
    await expect(dialog).toBeHidden();
    await settled(page);

    // What would use up what the plan opens, where it leaves a pack more than three tenths full.
    const line = card.locator('summary').filter({ hasText: start(packs.line!) }).first();
    if (await line.isVisible()) {
      await line.click();
      const ask = card.getByRole('button', { name: useUp.ask!, exact: true });
      if (await ask.isVisible()) {
        const looked = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/meal-plans/${plan.id}/use-up`);
        await ask.click();
        const found = (await (await looked).json()) as { suggestions: { plannedMealId: string; to: { id: string } }[] };
        if (found.suggestions.length === 0) {
          await expect(card.getByText(useUp.none!)).toBeVisible();
        } else {
          expect(await barriers(page), 'the plan with what would use up its packs').toEqual([]);
          const swapped = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/meal-plans/swap-meal');
          await card.locator('li', { has: page.getByRole('button', { name: plans.offerTake!, exact: true }) }).first().getByRole('button', { name: plans.offerTake!, exact: true }).click();
          const sent = (await swapped).request().postDataJSON() as { plannedMealId: string; recipeId: string };
          expect([sent.plannedMealId, sent.recipeId]).toEqual([found.suggestions[0]!.plannedMealId, found.suggestions[0]!.to.id]);
          expect((await swapped).ok()).toBe(true);
        }
      }
    }

    // The plan made for this test goes again.
    await settled(page);
    page.once('dialog', (confirm) => void confirm.accept());
    const gone = page.waitForResponse((res) => res.request().method() === 'DELETE' && new URL(res.url()).pathname === `/api/meal-plans/${plan.id}`);
    await page.getByRole('button', { name: plans.hidePlan! }).locator('xpath=..').getByRole('button', { name: (messages.common as Texts).delete!, exact: true }).click();
    expect((await gone).status()).toBe(204);
  });
});

test.describe('what a shopping list could do without', () => {
  test('is worked out when it is asked for, and what it names leads to the plan, opened at the day', async ({ session, messages }) => {
    const page = session.page;
    const proposals = (messages.shoppingLists as unknown as { proposals: Texts }).proposals;
    const plans = messages.mealPlans as Texts;
    const main = page.getByRole('main');
    await page.goto('/shopping-lists');
    await settled(page);
    await expect(main.getByRole('checkbox').first()).toBeVisible();

    const looked = page.waitForResponse((res) => /^\/api\/shopping-lists\/[^/]+\/proposals$/.test(new URL(res.url()).pathname));
    await main.getByRole('button', { name: proposals.ask!, exact: true }).click();
    const answer = await looked;
    expect(answer.status()).toBe(200);
    const found = (await answer.json()) as { planId: string; proposals: { kind: string }[] };
    expect(await barriers(page), 'the list with what it could do without').toEqual([]);

    if (found.proposals.length === 0) {
      await expect(main.getByText(proposals.none!)).toBeVisible();
      return;
    }
    // Whatever is proposed leads to the plan: a substitution is made there, and what would use up a pack is said there.
    const link = main.getByRole('link', { name: found.proposals[0]!.kind === 'merge' ? proposals.mergeHow! : proposals.leftoverHow!, exact: true }).first();
    await expect(link).toHaveAttribute('href', new RegExp(`^/meal-plans\\?profile=[0-9a-f-]{36}&plan=${found.planId}&day=\\d{4}-\\d{2}-\\d{2}$`));
    await link.click();
    await expect(page).toHaveURL(/\/meal-plans\?/);
    await settled(page);
    // The plan is open without a click: its days are on the page.
    await expect(page.getByRole('button', { name: plans.hidePlan! })).toBeVisible();
    await expect(page.locator(`[id^="plan-${found.planId}-"]`).first()).toBeVisible();
  });
});
