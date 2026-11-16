// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { InstanceFacts } from './instance-facts';

let config: unknown;
vi.mock('@/lib/use-config', () => ({ useConfig: () => ({ data: config }) }));

const the = (lookups: boolean, mail: boolean, turnstile: boolean) => ({
  products: { offered: true, lookups },
  email: { enabled: mail, confirmationUnlocksAi: false },
  turnstile: { enabled: turnstile, siteKey: turnstile ? 'key' : null },
});

function lines() {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ul>
        <InstanceFacts />
      </ul>
    </NextIntlClientProvider>,
  );
  return screen.queryAllByRole('listitem').map((item) => item.textContent);
}

describe('what the privacy page says of the instance', () => {
  it('says that codes go to Open Food Facts, mail to the operator, and the sign-in loads Turnstile, where they do', () => {
    config = the(true, true, true);

    expect(lines()).toEqual([
      messages.privacy.out.lookups,
      messages.privacy.out.mail,
      messages.privacy.out.turnstile,
    ]);
  });

  it('says that none of them happens where the operator set none up, and nothing of Turnstile', () => {
    config = the(false, false, false);

    expect(lines()).toEqual([messages.privacy.out.noLookups, messages.privacy.out.noMail]);
  });

  it('says nothing before the instance has answered', () => {
    config = undefined;

    expect(lines()).toEqual([]);
  });
});
