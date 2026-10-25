// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReviewKeys, useReviewKeysWanted, type ReviewKeys } from './review-keys';

function ADraft(keys: ReviewKeys) {
  const draft = useReviewKeys(keys);
  return (
    <div {...draft} role="group" aria-label="The draft">
      <input aria-label="Title" defaultValue="Oat porridge" />
      <button type="button">Approve</button>
    </div>
  );
}

function shown(over: Partial<ReviewKeys> = {}) {
  const keys = {
    enabled: true,
    takesFocus: true,
    approve: vi.fn(),
    reject: vi.fn(),
    save: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    busy: false,
    ...over,
  };
  render(<ADraft {...keys} />);
  return keys;
}

describe('the keys of a draft under review', () => {
  it('are for the draft that has just come up: it has the focus, and is a stop of the Tab key', () => {
    shown();

    expect(screen.getByRole('group', { name: 'The draft' })).toHaveFocus();
    expect(screen.getByRole('group', { name: 'The draft' })).toHaveAttribute('tabindex', '0');
  });

  it('do nothing until the reviewer turned them on, and Escape then leaves the focus in the field', async () => {
    const keys = shown({ enabled: false });
    expect(screen.getByRole('group', { name: 'The draft' })).toHaveFocus();

    await userEvent.keyboard('arsjk{ArrowLeft}{ArrowRight}');
    await userEvent.click(screen.getByRole('textbox', { name: 'Title' }));
    await userEvent.keyboard('{Escape}');

    for (const act of [keys.approve, keys.reject, keys.save, keys.next, keys.previous])
      expect(act).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
  });

  it('turned off, the draft is no stop of the Tab key', () => {
    shown({ enabled: false });

    expect(screen.getByRole('group', { name: 'The draft' })).toHaveAttribute('tabindex', '-1');
  });

  it('a draft that is not to take the focus leaves it where it is', () => {
    shown({ takesFocus: false });

    expect(screen.getByRole('group', { name: 'The draft' })).not.toHaveFocus();
  });

  it.each([
    ['a', 'approve'],
    ['A', 'approve'],
    ['r', 'reject'],
    ['s', 'save'],
    ['j', 'next'],
    ['{ArrowRight}', 'next'],
    ['k', 'previous'],
    ['{ArrowLeft}', 'previous'],
  ] as const)('%s does what it is for, once', async (key, does) => {
    const keys = shown();

    await userEvent.keyboard(key);

    for (const [name, act] of Object.entries(keys)) {
      if (typeof act === 'function') expect(act, name).toHaveBeenCalledTimes(name === does ? 1 : 0);
    }
  });

  it('do nothing while something is typed into a field of the draft: a letter there is a letter', async () => {
    const keys = shown();

    await userEvent.click(screen.getByRole('textbox', { name: 'Title' }));
    await userEvent.keyboard('arsjk');

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Oat porridgearsjk');
    for (const act of [keys.approve, keys.reject, keys.save, keys.next, keys.previous])
      expect(act).not.toHaveBeenCalled();
  });

  it('are back once Escape gives the focus back to the draft', async () => {
    const keys = shown();
    await userEvent.click(screen.getByRole('textbox', { name: 'Title' }));

    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('group', { name: 'The draft' })).toHaveFocus();
    await userEvent.keyboard('a');

    expect(keys.approve).toHaveBeenCalledOnce();
  });

  it('do nothing on a button of the draft, which has keys of its own', async () => {
    const keys = shown();

    screen.getByRole('button', { name: 'Approve' }).focus();
    await userEvent.keyboard('r');

    expect(keys.reject).not.toHaveBeenCalled();
  });

  it('leave a key held with Ctrl, Alt or the command key to the browser', async () => {
    const keys = shown();

    await userEvent.keyboard('{Control>}s{/Control}{Alt>}{ArrowLeft}{/Alt}{Meta>}r{/Meta}');

    for (const act of [keys.save, keys.previous, keys.reject]) expect(act).not.toHaveBeenCalled();
  });

  it('do nothing while a request is under way', async () => {
    const keys = shown({ busy: true });

    await userEvent.keyboard('ar');

    expect(keys.approve).not.toHaveBeenCalled();
    expect(keys.reject).not.toHaveBeenCalled();
  });

  it('do nothing where there is nothing to do: no change to save, no draft after the last', async () => {
    const keys = shown({ save: undefined, next: undefined });

    await userEvent.keyboard('sj');

    expect(keys.approve).not.toHaveBeenCalled();
    expect(keys.previous).not.toHaveBeenCalled();
  });
});

function TheSwitch() {
  const [wanted, want] = useReviewKeysWanted();
  return (
    <button type="button" aria-pressed={wanted} onClick={() => want(!wanted)}>
      Keys
    </button>
  );
}

describe('whether a reviewer wants the keys', () => {
  afterEach(() => localStorage.clear());

  it('is no until they say so', () => {
    render(<TheSwitch />);

    expect(screen.getByRole('button', { name: 'Keys' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('is kept in the browser: the next page has them on, until they are turned off', async () => {
    const first = render(<TheSwitch />);
    await userEvent.click(screen.getByRole('button', { name: 'Keys' }));
    expect(screen.getByRole('button', { name: 'Keys' })).toHaveAttribute('aria-pressed', 'true');
    first.unmount();

    render(<TheSwitch />);
    expect(screen.getByRole('button', { name: 'Keys' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Keys' }));
    expect(screen.getByRole('button', { name: 'Keys' })).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.length).toBe(0);
  });

  it('holds for the page in a browser that keeps nothing', async () => {
    const refused = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const away = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    try {
      render(<TheSwitch />);

      await userEvent.click(screen.getByRole('button', { name: 'Keys' }));
      expect(screen.getByRole('button', { name: 'Keys' })).toHaveAttribute('aria-pressed', 'true');

      await userEvent.click(screen.getByRole('button', { name: 'Keys' }));
      expect(screen.getByRole('button', { name: 'Keys' })).toHaveAttribute('aria-pressed', 'false');
    } finally {
      refused.mockRestore();
      away.mockRestore();
    }
  });
});
