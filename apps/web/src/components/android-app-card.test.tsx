// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { aPublicConfig } from '@/testing/public-config';
import { plain } from '@/testing/spaces';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { AndroidAppCard } from './android-app-card';

/** Render with the public configuration loaded with this address of the app's page, or still loading when it is left out. */
function renderWith(androidAppUrl?: string | null, locale: 'en' | 'pl' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  if (androidAppUrl !== undefined)
    client.setQueryData(
      ['config'],
      aPublicConfig({
        instance: { supportUrl: null, operatorContact: null, androidAppUrl, version: '0.0.0' },
      }),
    );
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
      <QueryClientProvider client={client}>
        <AndroidAppCard />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('the card about the Android app', () => {
  it.each([
    ['en', en],
    ['pl', pl],
  ] as const)(
    'says in %s what the app is, and leads to the page the operator gave, in a tab of its own',
    (locale, messages) => {
      renderWith('https://example.org/android/', locale);

      expect(
        screen.getByRole('heading', { level: 2, name: messages.landing.android.title }),
      ).toBeInTheDocument();
      expect(screen.getByText(plain(messages.landing.android.body))).toBeInTheDocument();
      const link = screen.getByRole('link', { name: messages.landing.android.download });
      expect(link).toHaveAttribute('href', 'https://example.org/android/');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    },
  );

  it('is not there on an instance whose operator gave no page, nor before the configuration has loaded', () => {
    const { container } = renderWith(null);
    expect(container).toBeEmptyDOMElement();

    const loading = renderWith();
    expect(loading.container).toBeEmptyDOMElement();
  });
});
