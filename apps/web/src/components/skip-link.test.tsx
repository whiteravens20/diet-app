// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { SkipLink } from './skip-link';

describe('the way past the sidebar', () => {
  it('is the first stop of the Tab key, and leads to what the page is about', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <SkipLink to="content" />
        <nav>
          <a href="/dashboard">Dashboard</a>
        </nav>
        <main id="content" tabIndex={-1} />
      </NextIntlClientProvider>,
    );

    await userEvent.tab();

    const link = screen.getByRole('link', { name: messages.common.skipToContent });
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute('href', '#content');
  });
});
