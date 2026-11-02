// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page, Response } from '@playwright/test';
import { barriers, expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

/** The products of `products.sql`. */
const MILK = { code: '5900512320359', name: 'Mleko próbne 3,2%', word: 'mleko probne' };
const BAR = { code: '5901234123457', name: 'Baton próbny' };
const BARE = { code: '4001724819806', name: 'Bez etykiety próbny' };

/** The answer to the next request of `method` to `path` of the API. */
const answered = (page: Page, method: string, path: string): Promise<Response> =>
  page.waitForResponse(
    (res) => res.request().method() === method && new URL(res.url()).pathname.startsWith(path),
  );

/** The window that adds to the diary, with a product chosen as what to add. */
async function windowOnProducts(page: Page, diary: Texts) {
  await page.goto('/diary');
  await settled(page);
  await page.getByRole('button', { name: diary.addTitle!, exact: true }).click();
  const window = page.getByRole('dialog', { name: diary.addTitle! });
  await window.getByRole('radio', { name: diary.kindProduct! }).check();
  return window;
}

test.describe('a product in the diary', () => {
  test.skip(!process.env.E2E_PRODUCTS, 'needs the products of e2e/products.sql');

  test('is found by its name, written in an amount, shown under its meal, changed and let go', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const diary = messages.diary as Texts;
    const meals = (messages.enums as unknown as { mealType: Texts }).mealType;
    const window = await windowOnProducts(page, diary);
    expect(await barriers(page), 'the window with a product to look for').toEqual([]);

    await window.getByRole('searchbox').fill(MILK.word);
    await window.getByRole('button', { name: new RegExp(MILK.name) }).click();
    // Its label, with what is not on it said to be so, and where it comes from.
    await expect(window.getByText(diary.labelFiber!)).toBeVisible();
    await expect(window.getByText(diary.labelUnknown!)).toBeVisible();
    await expect(window.getByRole('link', { name: 'Open Food Facts' })).toBeVisible();
    expect(await barriers(page), 'the window with a product picked').toEqual([]);

    // A serving of its label stands in the field, and what it adds is said before it is added.
    const amount = window.getByRole('spinbutton');
    await expect(amount).toHaveValue('250');
    await expect(window.getByText(/150/)).toBeVisible();
    await window.getByRole('combobox', { name: diary.mealLabel! }).selectOption('snack');
    const written = answered(page, 'POST', '/api/diary/entries');
    await window.getByRole('button', { name: diary.submit!, exact: true }).click();
    expect((await written).status()).toBe(201);

    const snack = page.getByRole('region', { name: meals.snack! });
    const entryName = `${MILK.name}, Próbna Marka`;
    await expect(snack.getByText(entryName)).toBeVisible();
    await expect(snack.getByText(diary.entrySource!)).toBeVisible();
    expect(await barriers(page), 'the day with a product written').toEqual([]);

    await snack
      .getByRole('button', { name: diary.editLabel!.replace('{name}', entryName) })
      .click();
    const edit = page.getByRole('dialog', { name: diary.editTitle! });
    await edit.getByRole('spinbutton').fill('500');
    const changed = answered(page, 'PATCH', '/api/diary/entries/');
    await edit.getByRole('button', { name: (messages.common as Texts).save!, exact: true }).click();
    expect((await changed).status()).toBe(200);
    await expect(snack.getByText(/300/)).toBeVisible();

    // Taken away again, so that the plan's day is as the other tests find it.
    const removed = answered(page, 'DELETE', '/api/diary/entries/');
    await snack
      .getByRole('button', { name: diary.removeLabel!.replace('{name}', entryName) })
      .click();
    expect((await removed).status()).toBe(204);
    await expect(page.getByText(entryName)).toHaveCount(0);
  });

  test('is found by its code, on a word from whoever types it, and says that its figures do not add up', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const diary = messages.diary as Texts;
    const window = await windowOnProducts(page, diary);

    await window.getByRole('searchbox').fill(BAR.code);
    const asked = answered(page, 'GET', `/api/products/code/${BAR.code}`);
    await window.getByRole('button', { name: diary.productCheck!, exact: true }).click();
    expect((await asked).status()).toBe(200);

    await expect(window.getByText(BAR.name)).toBeVisible();
    await expect(window.getByText(diary.productDoubtful!)).toBeVisible();
    // Its label gives no serving: nothing stands in the field.
    await expect(window.getByRole('spinbutton')).toHaveValue('');
    await expect(window.getByRole('button', { name: diary.submit!, exact: true })).toBeEnabled();
    expect(await barriers(page), 'a product whose figures do not add up').toEqual([]);
  });

  test('without figures cannot be written, and becomes a meal of its name', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const diary = messages.diary as Texts;
    const window = await windowOnProducts(page, diary);

    await window.getByRole('searchbox').fill(BARE.code);
    await window.getByRole('button', { name: diary.productCheck!, exact: true }).click();
    await expect(window.getByText(diary.productNoFigures!)).toBeVisible();
    await expect(window.getByRole('button', { name: diary.submit!, exact: true })).toBeDisabled();

    await window.getByRole('button', { name: diary.productAsOwn!, exact: true }).click();
    await expect(window.getByLabel(diary.mealName!, { exact: true })).toHaveValue(BARE.name);
  });
});

test.describe('looking for a product', () => {
  test('says of a mistyped code that it is one, and asks nobody', async ({ session, messages }) => {
    const page = session.page;
    const diary = messages.diary as Texts;
    const asked: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/products/code/'))
        asked.push(request.url());
    });
    const window = await windowOnProducts(page, diary);

    await window.getByRole('searchbox').fill('5900512320358');
    await window.getByRole('searchbox').press('Enter');

    await expect(window.getByText(diary.productCodeBad!)).toBeVisible();
    expect(asked).toEqual([]);
    expect(await barriers(page), 'a mistyped code').toEqual([]);
  });

  test('says who does not know a code, and leads on', async ({ session, messages }) => {
    const page = session.page;
    const diary = messages.diary as Texts;
    // No test leaves the instance: the answer of a code nobody knows is given here.
    await page.route('**/api/products/code/*', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 404,
          error: 'PRODUCT_NOT_FOUND',
          message: 'No product with this code is known.',
        }),
      }),
    );
    const window = await windowOnProducts(page, diary);

    await window.getByRole('searchbox').fill('5901112223330');
    await window.getByRole('button', { name: diary.productCheck!, exact: true }).click();

    await expect(window.getByText(diary.productNotFound!)).toBeVisible();
    expect(await barriers(page), 'a code nobody knows').toEqual([]);
    await window.getByRole('button', { name: diary.productAsOwn!, exact: true }).click();
    await expect(window.getByRole('radio', { name: diary.kindMeal! })).toBeChecked();
    // The page goes on to the next test.
    await page.unroute('**/api/products/code/*');
  });
});

test.describe("a product of one's own", () => {
  // Without a code nobody is asked about it, as no test leaves the instance.
  const BREAD = { name: 'Chleb próbny babci', word: 'chleb probny babci' };

  /** The page of the account's products, past what an earlier run may have left. */
  async function theProductsPage(page: Page, products: Texts) {
    await page.goto('/products');
    await settled(page);
    await expect(page.getByRole('heading', { name: products.title!, level: 1 })).toBeVisible();
    const left = page.getByRole('listitem').filter({ hasText: BREAD.name });
    // The list is there once it says that it holds nothing, or holds something.
    await expect(
      page
        .getByText(products.emptyTitle!)
        .or(page.getByRole('button', { name: products.edit! }).first()),
    ).toBeVisible();
    for (let many = await left.count(); many > 0; many -= 1) {
      await left.first().getByRole('button', { name: products.remove!, exact: true }).click();
      const removed = answered(page, 'DELETE', '/api/products/own/');
      await left
        .first()
        .getByRole('button', { name: products.removeConfirm!, exact: true })
        .last()
        .click();
      expect((await removed).status()).toBe(204);
      await expect(left).toHaveCount(many - 1);
    }
  }

  test('says what cannot be right, is saved, is found first in the diary and written there, and can be removed', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const products = messages.products as unknown as Texts & { state: Texts };
    const diary = messages.diary as Texts;
    await theProductsPage(page, products);
    expect(await barriers(page), 'the page of products').toEqual([]);

    await page.getByRole('button', { name: products.add!, exact: true }).click();
    const form = page.getByRole('dialog', { name: products.addTitle! });
    await form.getByLabel(products.code!).fill('123');
    await form.getByRole('button', { name: products.save!, exact: true }).click();
    await expect(form.getByText(products.errCode!)).toBeVisible();
    await expect(form.getByText(products.errName!)).toBeVisible();
    await expect(form.getByText(products.errCalories!)).toBeVisible();
    expect(await barriers(page), 'the form that says what is wrong').toEqual([]);

    await form.getByLabel(products.code!).fill('');
    await form.getByLabel(products.name!).fill(BREAD.name);
    await form.getByLabel(products.calories!).fill('245,5');
    const saved = answered(page, 'POST', '/api/products/own');
    await form.getByRole('button', { name: products.save!, exact: true }).click();
    expect((await saved).status()).toBe(201);
    await expect(form).toHaveCount(0);

    const row = page.getByRole('listitem').filter({ hasText: BREAD.name });
    await expect(row.getByText(products.state.own!)).toBeVisible();
    // What it lacks to be sent is said, and nothing is sent.
    await expect(row.getByRole('button', { name: products.send!, exact: true })).toBeDisabled();
    await expect(row.getByText(products.sendNeeds!)).toBeVisible();
    expect(await barriers(page), 'a product on the page').toEqual([]);

    const window = await windowOnProducts(page, diary);
    await window.getByRole('searchbox').fill(BREAD.word);
    await window.getByRole('button', { name: new RegExp(BREAD.name) }).click();
    await expect(window.getByText(diary.productSourceOwn!)).toBeVisible();
    await window.getByRole('spinbutton').fill('100');
    const written = answered(page, 'POST', '/api/diary/entries');
    await window.getByRole('button', { name: diary.submit!, exact: true }).click();
    expect((await written).status()).toBe(201);
    await expect(page.getByText(BREAD.name).first()).toBeVisible();

    const removedEntry = answered(page, 'DELETE', '/api/diary/entries/');
    await page
      .getByRole('button', { name: diary.removeLabel!.replace('{name}', BREAD.name) })
      .first()
      .click();
    expect((await removedEntry).status()).toBe(204);

    await theProductsPage(page, products);
    await expect(page.getByText(products.emptyTitle!)).toBeVisible();
  });

  test('is written from the diary where nothing is found, and goes back to the search on a word', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const products = messages.products as unknown as Texts;
    const diary = messages.diary as Texts;
    await theProductsPage(page, products);
    const window = await windowOnProducts(page, diary);

    await window.getByRole('searchbox').fill('zupełnie nieznany próbny produkt');
    await window.getByRole('button', { name: diary.productAddOwn!, exact: true }).click();
    await expect(window.getByLabel(products.name!, { exact: true })).toBeVisible();
    expect(await barriers(page), "the window with a product of one's own").toEqual([]);

    await window.getByRole('button', { name: products.cancel!, exact: true }).click();
    await expect(window.getByRole('searchbox')).toHaveValue('zupełnie nieznany próbny produkt');

    await window.getByRole('button', { name: diary.productAddOwn!, exact: true }).click();
    await window.getByLabel(products.name!, { exact: true }).fill(BREAD.name);
    await window.getByLabel(products.calories!, { exact: true }).fill('245');
    const saved = answered(page, 'POST', '/api/products/own');
    await window.getByRole('button', { name: products.save!, exact: true }).click();
    expect((await saved).status()).toBe(201);
    // Picked at once, with its amount to give.
    await expect(window.getByText(diary.productSourceOwn!)).toBeVisible();
    await expect(window.getByRole('spinbutton')).toBeVisible();

    await theProductsPage(page, products);
  });

  test('does not take a code the base knows: it shows what the base holds, and leads to one without a code', async ({
    session,
    messages,
  }) => {
    test.skip(!process.env.E2E_PRODUCTS, 'needs the products of e2e/products.sql');
    const page = session.page;
    const products = messages.products as unknown as Texts;
    await theProductsPage(page, products);

    await page.getByRole('button', { name: products.add!, exact: true }).click();
    const form = page.getByRole('dialog', { name: products.addTitle! });
    await form.getByLabel(products.code!).fill(MILK.code);
    await form.getByLabel(products.name!).fill(BREAD.name);
    await form.getByLabel(products.calories!).fill('245');
    const refused = answered(page, 'POST', '/api/products/own');
    await form.getByRole('button', { name: products.save!, exact: true }).click();
    expect((await refused).status()).toBe(409);
    await expect(form.getByText(MILK.name)).toBeVisible();
    expect(await barriers(page), 'a code the base knows').toEqual([]);

    await form.getByRole('button', { name: products.withoutCode!, exact: true }).click();
    await expect(form.getByLabel(products.code!)).toHaveValue('');
    const saved = answered(page, 'POST', '/api/products/own');
    await form.getByRole('button', { name: products.save!, exact: true }).click();
    expect((await saved).status()).toBe(201);

    await theProductsPage(page, products);
  });
});
