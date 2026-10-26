// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { aPublicConfig } from '@/testing/public-config';
import en from '../../../messages/en.json';
import pl from '../../../messages/pl.json';
import { SoftwareNotice } from './software-notice';

const MESSAGES = { en, pl } as const;

function renderIn(locale: keyof typeof MESSAGES, operatorContact: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  client.setQueryData(
    ['config'],
    aPublicConfig({ instance: { supportUrl: null, operatorContact, version: '0.108.0' } }),
  );
  render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <QueryClientProvider client={client}>
        <SoftwareNotice />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return screen.getByRole('region', { name: MESSAGES[locale].terms.software.title });
}

describe('what the application says of itself under the terms', () => {
  it.each(['en', 'pl'] as const)(
    'keeps the attribution with the address of the original source, in %s',
    (locale) => {
      const notice = renderIn(locale, null);

      expect(notice).toHaveTextContent('Diet App by White Ravens');
      expect(
        within(notice).getByRole('link', { name: 'https://github.com/whiteravens20/diet-app' }),
      ).toHaveAttribute('href', 'https://github.com/whiteravens20/diet-app');
      expect(notice).toHaveTextContent('GNU Affero General Public License');
      expect(within(notice).getByRole('link', { name: 'gnu.org' })).toHaveAttribute(
        'href',
        'https://www.gnu.org/licenses/agpl-3.0.html',
      );
      expect(notice).toHaveTextContent(MESSAGES[locale].terms.software.warranty);
      expect(notice).toHaveTextContent(MESSAGES[locale].terms.software.changed);
    },
  );

  it('sends a mistake to the tracker and a security problem to the private report the policy describes', () => {
    const notice = renderIn('en', null);

    expect(within(notice).getByRole('link', { name: 'issue tracker' })).toHaveAttribute(
      'href',
      'https://github.com/whiteravens20/diet-app/issues',
    );
    expect(within(notice).getByRole('link', { name: 'security policy' })).toHaveAttribute(
      'href',
      'https://github.com/whiteravens20/diet-app/security/policy',
    );
  });

  it('names the operator the instance publishes, or says that it publishes none', () => {
    const named = renderIn('pl', 'ops@example.org');
    expect(within(named).getByRole('link', { name: 'ops@example.org' })).toHaveAttribute(
      'href',
      'mailto:ops@example.org',
    );
  });

  it('says so when the instance publishes no operator', () => {
    const unnamed = renderIn('pl', null);
    expect(unnamed).toHaveTextContent(pl.terms.software.operatorNotSet);
  });
});
