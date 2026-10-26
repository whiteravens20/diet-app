// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { expect, settled, test } from './fixtures';

/** How the template that comes with the application begins, in each language. */
const TEMPLATE = {
  en: { title: 'Terms of Service', notice: 'This is a template, not the terms of this instance.' },
  pl: { title: 'Regulamin', notice: 'To szablon, a nie regulamin tej instancji.' },
} as const;

test("the terms of an instance that keeps the template are the template in the reader's language, with what the application says of itself under them", async ({
  anonymous,
  appLocale,
  messages,
}) => {
  await anonymous.goto('/terms');
  await settled(anonymous);

  const template = TEMPLATE[appLocale];
  await expect(anonymous.getByRole('heading', { level: 1, name: template.title })).toBeVisible();
  await expect(anonymous.getByText(template.notice)).toBeVisible();

  const software = (messages.terms as { software: Record<string, string> }).software;
  const notice = anonymous.getByRole('region', { name: software.title });
  await expect(notice).toContainText('Diet App by White Ravens');
  await expect(
    notice.getByRole('link', { name: 'https://github.com/whiteravens20/diet-app' }),
  ).toHaveAttribute('href', 'https://github.com/whiteravens20/diet-app');
});
