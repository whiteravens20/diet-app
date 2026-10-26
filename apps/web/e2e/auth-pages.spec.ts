// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { expect, settled, test } from './fixtures';

test.describe('the pages of signing in and up lead back to the home page', () => {
  for (const path of ['/login', '/register', '/forgot-password']) {
    test(path, async ({ anonymous, messages }) => {
      await anonymous.goto(path);
      await settled(anonymous);

      await anonymous
        .getByRole('link', { name: (messages.auth as Record<string, string>).backHome! })
        .click();

      await expect(anonymous).toHaveURL(/\/$/);
    });
  }
});
