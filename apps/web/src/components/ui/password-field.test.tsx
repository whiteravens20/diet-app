// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { PasswordField } from './password-field';

const english = (children: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    {children}
  </NextIntlClientProvider>
);

const field = () => screen.getByLabelText<HTMLInputElement>('Password');
const status = () => screen.getByRole('status');

/** The page's visibility, as a browser reports it when a tab goes to the background or comes back. */
function pageIs(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

afterEach(() => {
  pageIs('visible');
});

describe('PasswordField', () => {
  it('is named by its label alone, with the eye beside it and not in its name', () => {
    render(
      english(<PasswordField label="Password" name="password" autoComplete="current-password" />),
    );

    expect(field()).toHaveAccessibleName('Password');
    expect(field()).toHaveAttribute('type', 'password');
    expect(field()).toHaveAttribute('name', 'password');
    expect(field()).toHaveAttribute('autocomplete', 'current-password');
    const eye = screen.getByRole('button', { name: 'Show password' });
    expect(eye).toHaveAttribute('aria-controls', field().id);
    expect(eye).toHaveAttribute('type', 'button');
  });

  it('shows what is typed at one press and hides it at the next, and says so to a screen reader', async () => {
    render(english(<PasswordField label="Password" />));
    expect(status()).toBeEmptyDOMElement();

    await userEvent.type(field(), 'Secret-Passw0rd');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(field()).toHaveAttribute('type', 'text');
    expect(field()).toHaveValue('Secret-Passw0rd');
    expect(status()).toHaveTextContent('The password is visible.');

    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));

    expect(field()).toHaveAttribute('type', 'password');
    expect(status()).toHaveTextContent('The password is hidden.');
  });

  it('leaves the focus in the field when the eye is pressed', async () => {
    render(english(<PasswordField label="Password" />));

    await userEvent.click(field());
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(field()).toHaveFocus();
  });

  it('never has what it holds checked for spelling or corrected, shown or not', async () => {
    render(english(<PasswordField label="Password" />));
    const checked = () => {
      expect(field()).toHaveAttribute('spellcheck', 'false');
      expect(field()).toHaveAttribute('autocorrect', 'off');
      expect(field()).toHaveAttribute('autocapitalize', 'none');
    };

    checked();
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    checked();
  });

  it('is a password field again when its form is sent, before the page reads the form', async () => {
    let typeWhenSent: string | null = null;
    render(
      english(
        <form
          onSubmit={(event) => {
            event.preventDefault();
            typeWhenSent = (event.currentTarget.elements.namedItem('password') as HTMLInputElement)
              .type;
          }}
        >
          <PasswordField label="Password" name="password" />
          <button type="submit">Sign in</button>
        </form>,
      ),
    );
    await userEvent.type(field(), 'Secret-Passw0rd');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(typeWhenSent).toBe('password');
    expect(field()).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });

  it('hides again when the page goes to the background, and stays as it was when it comes back', async () => {
    render(english(<PasswordField label="Password" />));
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));

    pageIs('visible');
    expect(field()).toHaveAttribute('type', 'text');

    pageIs('hidden');
    expect(field()).toHaveAttribute('type', 'password');
  });

  it('hides again when the page is left', async () => {
    render(english(<PasswordField label="Password" />));
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(field()).toHaveAttribute('type', 'password');
  });

  it('stops listening once it is gone', async () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      english(
        <form>
          <PasswordField label="Password" />
        </form>,
      ),
    );

    unmount();

    expect(removed).toHaveBeenCalledWith('pagehide', expect.any(Function));
    removed.mockRestore();
  });

  it('is described by its hint, its error and what the page names, and says the error at once', () => {
    render(
      english(
        <>
          <span id="rules">Twelve characters or more.</span>
          <PasswordField
            label="Password"
            hint="Not the one of another site."
            error="The passwords differ."
            aria-describedby="rules"
          />
        </>,
      ),
    );

    expect(field()).toHaveAccessibleName('Password');
    expect(field()).toHaveAccessibleDescription(
      'Twelve characters or more. Not the one of another site. The passwords differ.',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The passwords differ.');
  });

  it('has no description where nothing is said under it', () => {
    render(english(<PasswordField label="Password" />));

    expect(field()).not.toHaveAttribute('aria-describedby');
  });

  it('names a key of a provider as a key', async () => {
    render(english(<PasswordField label="API key" secret="key" />));

    await userEvent.click(screen.getByRole('button', { name: 'Show key' }));

    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'text');
    expect(status()).toHaveTextContent('The key is visible.');

    await userEvent.click(screen.getByRole('button', { name: 'Hide key' }));

    expect(status()).toHaveTextContent('The key is hidden.');
  });

  it('takes no press of its eye while the field is switched off', () => {
    render(english(<PasswordField label="Password" disabled />));

    const eye = screen.getByRole('button', { name: 'Show password' });
    expect(eye).toBeDisabled();
    fireEvent.click(eye);
    expect(field()).toHaveAttribute('type', 'password');
  });
});
