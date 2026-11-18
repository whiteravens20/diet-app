// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { ProfileChips } from './profile-chips';

const anna = { id: '6f1c2b1e-7a52-4a3a-9d0e-000000000001', name: 'Anna' };
const adam = { id: '6f1c2b1e-7a52-4a3a-9d0e-000000000002', name: 'Adam' };

function shown(profiles: { id: string; name: string }[], active: string | null) {
  const onPick = vi.fn();
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProfileChips profiles={profiles} active={active} onPick={onPick} />
    </NextIntlClientProvider>,
  );
  return { onPick, container };
}

describe('the profile a page is of', () => {
  it('is not asked for an account of one profile', () => {
    const { container } = shown([anna], anna.id);

    expect(container).toBeEmptyDOMElement();
  });

  it('is one button a profile, the one shown pressed, named as a group', () => {
    shown([anna, adam], adam.id);

    const group = screen.getByRole('group', { name: messages.common.profileChoice });
    expect(within(group).getByRole('button', { name: 'Anna' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(group).getByRole('button', { name: 'Adam' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('is changed by pressing another', async () => {
    const { onPick } = shown([anna, adam], anna.id);

    await userEvent.click(screen.getByRole('button', { name: 'Adam' }));

    expect(onPick).toHaveBeenCalledWith(adam.id);
  });
});
