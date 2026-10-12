// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi } from '@/lib/admin-api';
import en from '../../../messages/en.json';
import pl from '../../../messages/pl.json';
import { AdminPanel } from './admin-panel';

/** What the API says of a panel nobody has set a password for: its own sentence, in English. */
const DISABLED = { enabled: false, message: 'Admin panel is disabled. Set ADMIN_PASSWORD in .env to enable it, then restart the API.' };

describe('the administrator\'s panel on an instance without an admin password', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['en', en],
    ['pl', pl],
  ] as const)('says how to enable it in the language of the application (%s), not in the API\'s own words', async (locale, messages) => {
    vi.spyOn(adminApi, 'status').mockResolvedValue(DISABLED);
    const session = vi.spyOn(adminApi, 'session');

    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <AdminPanel />
      </NextIntlClientProvider>,
    );

    expect(await screen.findByText(messages.admin.disabledHint)).toBeInTheDocument();
    expect(screen.getByText(messages.admin.disabled)).toBeInTheDocument();
    expect(screen.getByText(messages.admin.restartHint)).toBeInTheDocument();
    expect(screen.queryByText(DISABLED.message)).toBeNull();
    // A panel that does not exist is not asked for a session.
    expect(session).not.toHaveBeenCalled();
  });
});
