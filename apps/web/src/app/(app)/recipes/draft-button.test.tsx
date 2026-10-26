// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import { DraftButton } from './draft-button';

function shown(aiEnabled: boolean) {
  const onOpen = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DraftButton aiEnabled={aiEnabled} onOpen={onOpen} />
    </NextIntlClientProvider>,
  );
  return { onOpen, button: screen.getByRole('button', { name: messages.recipes.aiDraft }) };
}

describe('the button that drafts a recipe with a model', () => {
  it('opens the draft where the account has a model to ask', async () => {
    const { onOpen, button } = shown(true);

    await userEvent.click(button);

    expect(onOpen).toHaveBeenCalledOnce();
    expect(button).not.toHaveAccessibleDescription();
  });

  it('stays in its place without one, disabled, over a line that says what it waits for and where that is changed', async () => {
    const { onOpen, button } = shown(false);

    expect(button).toBeDisabled();
    // A line anybody can read, not a text that shows on hover: a disabled button says nothing to a finger.
    const note = screen.getByText(/^AI is turned off for this account/);
    expect(note).toBeVisible();
    expect(button).toHaveAccessibleDescription(note.textContent!);
    expect(screen.getByRole('link', { name: 'Turn AI on in Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );

    await userEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
