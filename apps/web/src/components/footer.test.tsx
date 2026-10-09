// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { PublicConfig } from '@diet-app/shared';
import messages from '../../messages/en.json';
import { Footer } from './footer';
import { OperatorContact } from './operator-contact';

/** Render with the public configuration already loaded, or still loading when `instance` is omitted. */
function renderWith(ui: React.ReactNode, instance?: PublicConfig['instance']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  if (instance) {
    const config: PublicConfig = {
      turnstile: { enabled: false, siteKey: null },
      email: { enabled: false },
      ai: { ollamaUserPolicy: 'off' },
      instance,
    };
    client.setQueryData(['config'], config);
  }
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const support = () => screen.getByRole('link', { name: new RegExp(messages.footer.support, 'i') });

describe('Footer', () => {
  it('points the support link at the project and shows no version until the configuration has loaded', () => {
    renderWith(<Footer />);
    expect(support()).toHaveAttribute('href', 'https://ko-fi.com/whiteravens20');
    expect(screen.queryByText(/^v\d/)).toBeNull();
  });

  it('shows the running version and the support page the operator set', () => {
    renderWith(<Footer />, { supportUrl: 'https://example.org/support', operatorContact: null, version: '0.19.0' });
    expect(support()).toHaveAttribute('href', 'https://example.org/support');
    expect(screen.getByText('v0.19.0')).toBeInTheDocument();
  });
});

describe('OperatorContact', () => {
  it('says so when the operator published no address', () => {
    renderWith(<OperatorContact notPublished="No contact published." />, {
      supportUrl: null,
      operatorContact: null,
      version: '0.19.0',
    });
    expect(screen.getByText('No contact published.')).toBeInTheDocument();
  });

  it('links the published address', () => {
    renderWith(<OperatorContact notPublished="No contact published." />, {
      supportUrl: null,
      operatorContact: 'ops@example.org',
      version: '0.19.0',
    });
    expect(screen.getByRole('link', { name: 'ops@example.org' })).toHaveAttribute('href', 'mailto:ops@example.org');
  });
});
