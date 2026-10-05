// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { PublicConfig } from '@diet-app/shared';
import messages from '../../../../messages/en.json';
import ForgotPasswordPage from './page';

function renderPage(emailEnabled: boolean) {
  const config: PublicConfig = {
    turnstile: { enabled: false, siteKey: null },
    email: { enabled: emailEnabled },
    ai: { ollamaUserPolicy: 'off' },
  };
  const client = new QueryClient();
  client.setQueryData(['config'], config);
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <ForgotPasswordPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('ForgotPasswordPage', () => {
  it('shows the request form where email is configured', () => {
    renderPage(true);
    expect(screen.getByRole('textbox')).toHaveAttribute('name', 'email');
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument();
  });

  it('says reset is unavailable where email is not configured', () => {
    renderPage(false);
    expect(screen.getByText(messages.auth.resetUnavailable)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });
});
