// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNDO_FOR_MS, useRemovedLater } from './removed-later';

describe('a removal that can be taken back', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const held = (answer: () => Promise<unknown> = () => Promise.resolve()) => {
    const send = vi.fn(answer);
    const hook = renderHook(() => useRemovedLater<{ id: string }>(send, (item) => item.id));
    return { send, hook };
  };

  it('is gone at once and sent only once the moments to take it back are over', () => {
    const { send, hook } = held();

    act(() => hook.result.current.remove({ id: 'a' }));
    expect(hook.result.current.waiting).toEqual({ id: 'a' });
    act(() => vi.advanceTimersByTime(UNDO_FOR_MS - 1));
    expect(send).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(send).toHaveBeenCalledExactlyOnceWith({ id: 'a' });
    expect(hook.result.current.waiting).toBeNull();
  });

  it('is never sent once it is taken back', () => {
    const { send, hook } = held();

    act(() => hook.result.current.remove({ id: 'a' }));
    act(() => hook.result.current.undo());
    act(() => vi.advanceTimersByTime(UNDO_FOR_MS * 2));

    expect(send).not.toHaveBeenCalled();
    expect(hook.result.current.waiting).toBeNull();
  });

  it('is sent at once when another follows it', () => {
    const { send, hook } = held();

    act(() => hook.result.current.remove({ id: 'a' }));
    act(() => hook.result.current.remove({ id: 'b' }));

    expect(send).toHaveBeenCalledExactlyOnceWith({ id: 'a' });
    expect(hook.result.current.waiting).toEqual({ id: 'b' });
  });

  it('is sent when the page is left, or its tab closed', () => {
    const left = held();
    act(() => left.hook.result.current.remove({ id: 'a' }));
    left.hook.unmount();
    expect(left.send).toHaveBeenCalledExactlyOnceWith({ id: 'a' });

    const closed = held();
    act(() => closed.hook.result.current.remove({ id: 'b' }));
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(closed.send).toHaveBeenCalledExactlyOnceWith({ id: 'b' });
  });

  it('stays out of sight once it is sent, and for good once the server has it', async () => {
    let answer!: () => void;
    const { hook } = held(() => new Promise<void>((done) => (answer = done)));

    act(() => hook.result.current.remove({ id: 'a' }));
    act(() => vi.advanceTimersByTime(UNDO_FOR_MS));

    expect(hook.result.current.waiting).toBeNull();
    expect(hook.result.current.hidden({ id: 'a' })).toBe(true);
    await act(async () => answer());
    expect(hook.result.current.hidden({ id: 'a' })).toBe(true);
    expect(hook.result.current.hidden({ id: 'b' })).toBe(false);
  });

  it('shows again where the server refuses its removal', async () => {
    let refuse!: () => void;
    const { hook } = held(() => new Promise<void>((_, no) => (refuse = () => no(new Error('no')))));

    act(() => hook.result.current.remove({ id: 'a' }));
    act(() => vi.advanceTimersByTime(UNDO_FOR_MS));
    expect(hook.result.current.hidden({ id: 'a' })).toBe(true);

    await act(async () => refuse());
    expect(hook.result.current.hidden({ id: 'a' })).toBe(false);
  });
});
