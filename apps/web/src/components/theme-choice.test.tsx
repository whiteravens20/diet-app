// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from 'next-themes';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { ThemeChoice } from './theme-choice';

function tree() {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <ThemeChoice />
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}

function pressed(): string[] {
  return screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.getAttribute('aria-label')!);
}

describe('ThemeChoice', () => {
  let root: Root | undefined;

  beforeEach(() => {
    // The device asks for a light page.
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
    document.documentElement.className = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('hydrates without a mismatch when the browser holds a choice', async () => {
    // The server has no browser storage, so it renders without a choice.
    const container = document.createElement('div');
    container.innerHTML = renderToString(tree());
    document.body.append(container);
    localStorage.setItem('theme', 'dark');

    const onRecoverableError = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, tree(), { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(pressed()).toEqual(['Dark']);
  });

  it("names the three choices and starts at the device's own", async () => {
    await act(async () => {
      render(tree());
    });

    expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument();
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Light', 'Dark', 'System']);
    expect(pressed()).toEqual(['System']);
  });

  it('shows a choice at once and keeps it in the browser', async () => {
    await act(async () => {
      render(tree());
    });

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Dark' })));

    expect(pressed()).toEqual(['Dark']);
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });
});
