// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, buttonVariants } from './button';

describe('Button', () => {
  it('renders its children', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('fires onClick when pressed', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire onClick when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Nope
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Nope' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the focus when its own click makes it unavailable, says so, and does nothing more', async () => {
    function Pages() {
      const [page, setPage] = useState(1);
      return (
        <>
          <p>Page {page} of 2</p>
          <Button unavailable={page === 2} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </>
      );
    }
    render(<Pages />);
    const next = screen.getByRole('button', { name: 'Next' });

    await userEvent.click(next);

    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(next).toHaveAttribute('aria-disabled', 'true');
    // A disabled button would lose the focus to the page.
    expect(next).not.toBeDisabled();
    expect(next).toHaveFocus();
    await userEvent.click(next);
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('does not send its form while it is unavailable', async () => {
    const sent = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={sent}>
        <Button type="submit" unavailable>
          Send
        </Button>
      </form>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(sent).not.toHaveBeenCalled();
  });

  it('applies the destructive variant classes', () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bg-destructive');
  });

  it('merges a custom className over the variant base', () => {
    const cls = buttonVariants({ variant: 'outline', size: 'lg' });
    expect(cls).toContain('h-12');
    expect(cls).toContain('border');
  });
});
