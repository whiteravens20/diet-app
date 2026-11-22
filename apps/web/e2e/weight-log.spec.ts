// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page, Response } from '@playwright/test';
import { expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

/**
 * The answer to the next change of the account's weight unit. Every page may save the account's
 * time zone or language of its own accord, by the same request: that answer is not this one.
 */
const settingsSaved = (page: Page): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'PATCH' &&
      new URL(res.url()).pathname === '/api/users/me' &&
      'weightUnit' in ((res.request().postDataJSON() as Record<string, unknown> | null) ?? {}),
  );

test.describe('the weight of a profile', () => {
  test('is read and typed in pounds once the account chooses them, and in kilograms again once it chooses those', async ({
    session,
    messages,
    appLocale,
  }) => {
    const page = session.page;
    // The profile's weight suggested in the field, as the page's language writes a number ("176,4" in Polish).
    const suggested = (value: number) =>
      value.toLocaleString(appLocale, { maximumFractionDigits: 1, useGrouping: false });
    const settings = messages.settings as Texts;
    const card = messages.weightCard as Texts;
    const unitChoice = (name: string) =>
      page
        .getByRole('group', { name: settings.weightUnit!, exact: true })
        .getByRole('button', { name, exact: true });
    const field = (unit: string) =>
      page.getByLabel(card.formLabel!.replace('{unit}', unit), { exact: true });

    await page.goto('/settings');
    await settled(page);
    const toPounds = settingsSaved(page);
    await unitChoice(settings.weightUnitLb!).click();
    expect(((await (await toPounds).json()) as { weightUnit: string | null }).weightUnit).toBe(
      'lb',
    );
    await expect(unitChoice(settings.weightUnitLb!)).toHaveAttribute('aria-pressed', 'true');

    // The dashboard follows: the profile weighs 80 kg, which is 176.4 lb.
    await page.goto('/dashboard');
    await settled(page);
    await expect(field('lb')).toHaveAttribute('placeholder', suggested(176.4));
    await expect(field('kg')).toHaveCount(0);

    // And back, for the tests after this one.
    await page.goto('/settings');
    await settled(page);
    const toKilograms = settingsSaved(page);
    await unitChoice(settings.weightUnitKg!).click();
    expect(((await (await toKilograms).json()) as { weightUnit: string | null }).weightUnit).toBe(
      'kg',
    );
    await page.goto('/dashboard');
    await settled(page);
    await expect(field('kg')).toHaveAttribute('placeholder', suggested(80));
  });
});
