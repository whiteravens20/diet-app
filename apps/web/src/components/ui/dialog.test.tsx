// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './dialog';

// What the browser does with an open window (the focus, the page behind, Esc)
// is seen in the browser tests. Here: what is on the page, and who is told.
describe('Dialog', () => {
  it('holds nothing while it is closed', () => {
    render(
      <Dialog open={false} onClose={() => undefined} label="A recipe">
        <p>Oat porridge</p>
      </Dialog>,
    );

    expect(screen.queryByText('Oat porridge')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { hidden: true })).not.toHaveAttribute('open');
  });

  it('is an open window with a name once it is opened, and holds what it was given', () => {
    render(
      <Dialog open onClose={() => undefined} label="A recipe">
        <p>Oat porridge</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'A recipe' });
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveTextContent('Oat porridge');
  });

  it('tells whoever opened it when the browser closes it, as it does on Esc', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="A recipe">
        <p>Oat porridge</p>
      </Dialog>,
    );

    fireEvent(screen.getByRole('dialog'), new Event('close'));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on a click beside it, and not on a click inside it', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="A recipe">
        <button type="button">Cook it</button>
      </Dialog>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cook it' }));
    expect(onClose).not.toHaveBeenCalled();

    // The element fills the window's box: a click that lands on the element itself landed on the backdrop.
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the page behind from scrolling while it is open, and gives it back as it was', () => {
    document.documentElement.style.overflow = 'clip';
    const { rerender } = render(
      <Dialog open onClose={() => undefined} label="A recipe">
        <p>Oat porridge</p>
      </Dialog>,
    );
    expect(document.documentElement.style.overflow).toBe('hidden');

    rerender(
      <Dialog open={false} onClose={() => undefined} label="A recipe">
        <p>Oat porridge</p>
      </Dialog>,
    );

    expect(document.documentElement.style.overflow).toBe('clip');
    document.documentElement.style.overflow = '';
  });

  it('closes the window itself when it is told to close, and empties it', () => {
    const { rerender } = render(
      <Dialog open onClose={() => undefined} label="A recipe">
        <p>Oat porridge</p>
      </Dialog>,
    );

    rerender(
      <Dialog open={false} onClose={() => undefined} label="A recipe">
        <p>Oat porridge</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { hidden: true })).not.toHaveAttribute('open');
    expect(screen.queryByText('Oat porridge')).not.toBeInTheDocument();
  });

  it('closes the window before it leaves the page, so that the focus can go back', () => {
    const closed = vi.spyOn(HTMLDialogElement.prototype, 'close');
    const { unmount } = render(
      <Dialog open onClose={() => undefined} label="A recipe">
        <p>Oat porridge</p>
      </Dialog>,
    );

    unmount();

    expect(closed).toHaveBeenCalledOnce();
    closed.mockRestore();
  });

  it('takes the width a page asks for', () => {
    render(
      <Dialog open onClose={() => undefined} label="A recipe" className="max-w-md">
        <p>Oat porridge</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('dialog', 'max-w-md');
    expect(dialog).not.toHaveClass('max-w-2xl');
  });
});
