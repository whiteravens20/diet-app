// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/session';
import messages from '../../messages/en.json';
import { Sidebar } from './sidebar';

let pathname = '/meal-plans';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
// A link that is followed without the test's page going anywhere.
vi.mock('next/link', () => ({
  default: ({ onClick, ...rest }: ComponentProps<'a'>) => (
    <a
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    />
  ),
}));
// What stands in the bar beside the navigation asks the API, and has tests of its own.
vi.mock('@/components/ai-chip', () => ({ AiChip: () => null }));
vi.mock('@/components/notifications-bell', () => ({ NotificationsBell: () => null }));
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));

/** The screen, as the navigation asks about it: narrow until a test makes it wide. */
function aScreen() {
  const listeners = new Set<() => void>();
  const query = {
    matches: false,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const asked = vi.fn((_query: string) => query);
  vi.stubGlobal('matchMedia', asked);
  return {
    asked,
    listening: () => listeners.size,
    grows: () => {
      query.matches = true;
      listeners.forEach((listener) => listener());
    },
  };
}

const shown = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Sidebar />
    </NextIntlClientProvider>,
  );

const menuButton = (): HTMLElement => screen.getByRole('button', { name: messages.nav.menu });
const drawer = (): HTMLElement | null => screen.queryByRole('dialog', { name: messages.nav.menu });

describe('the navigation of a signed-in account', () => {
  let screenOf: ReturnType<typeof aScreen>;

  beforeEach(() => {
    pathname = '/meal-plans';
    screenOf = aScreen();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('links to every page of the account, and says which one the reader is on', () => {
    shown();

    const beside = within(screen.getByRole('complementary'));
    const links = beside.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/dashboard', '/profile', '/meal-plans', '/recipes', '/shopping-lists', '/inventory', '/settings']);
    expect(links.filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent)).toEqual([messages.nav.mealPlans]);
  });

  it('says so of a page under one of them', () => {
    pathname = '/recipes/0b1f';
    shown();

    expect(within(screen.getByRole('complementary')).getByRole('link', { name: messages.nav.recipes })).toHaveAttribute('aria-current', 'page');
  });

  it('is a drawer on a narrow screen: shut until the menu button opens it', async () => {
    shown();
    expect(drawer()).toBeNull();
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton()).toHaveAttribute('aria-haspopup', 'dialog');

    await userEvent.click(menuButton());

    expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
    expect(within(drawer()!).getAllByRole('link')).toHaveLength(7);
    expect(within(drawer()!).getByRole('link', { name: messages.nav.mealPlans })).toHaveAttribute('aria-current', 'page');
  });

  it('shuts the drawer when a link in it is followed', async () => {
    shown();
    await userEvent.click(menuButton());

    await userEvent.click(within(drawer()!).getByRole('link', { name: messages.nav.inventory }));

    expect(drawer()).toBeNull();
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('shuts the drawer with its own button', async () => {
    shown();
    await userEvent.click(menuButton());

    await userEvent.click(within(drawer()!).getByRole('button', { name: messages.common.close }));

    expect(drawer()).toBeNull();
  });

  it('shuts the drawer when the screen grows wide enough for the navigation to stand beside the page', async () => {
    shown();
    await userEvent.click(menuButton());
    expect(screenOf.asked).toHaveBeenCalledWith('(min-width: 48rem)');
    expect(screenOf.listening()).toBe(1);

    act(() => screenOf.grows());

    expect(drawer()).toBeNull();
    expect(screenOf.listening()).toBe(0);
  });

  it('signs out from the navigation beside the page and from the drawer', async () => {
    const signOut = vi.spyOn(session, 'signOut').mockResolvedValue(undefined);
    shown();

    await userEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: messages.nav.signOut }));
    await userEvent.click(menuButton());
    await userEvent.click(within(drawer()!).getByRole('button', { name: messages.nav.signOut }));

    expect(signOut).toHaveBeenCalledTimes(2);
  });
});
