// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { PublicConfig } from '@diet-app/shared';
import messages from '../../messages/en.json';
import { AuthForm } from './auth-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderLogin(emailEnabled: boolean) {
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
        <AuthForm mode="login" />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('AuthForm', () => {
  it('offers the password reset link where email is configured', () => {
    renderLogin(true);
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('has no password reset link where email is not configured', () => {
    renderLogin(false);
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument();
  });
});
