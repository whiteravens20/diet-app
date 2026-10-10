// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { HttpException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInGate } from './sign-in-gate.js';

describe('the gate that slows down wrong sign-ins', () => {
  let gate: SignInGate;
  let time: number;
  let logged: string[];

  beforeEach(() => {
    gate = new SignInGate();
    time = 1_000_000;
    gate.now = () => time;
    logged = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** How long the client has to wait in seconds, or 0 when it may try. */
  const wait = (door = 'admin', client = '203.0.113.7'): number => {
    const headers: Record<string, string> = {};
    try {
      gate.assertOpen(door, client, { setHeader: (name, value) => (headers[name] = value) });
      return 0;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
      expect((err as HttpException).getResponse()).toMatchObject({ error: 'TOO_MANY_ATTEMPTS' });
      return Number(headers['Retry-After']);
    }
  };
  const fail = (times: number, door = 'admin', client = '203.0.113.7'): void => {
    for (let i = 0; i < times; i += 1) gate.failed(door, client);
  };

  it('lets four wrong sign-ins pass without a wait', () => {
    fail(4);

    expect(wait()).toBe(0);
  });

  it('makes the client wait after the fifth, and twice as long after each further one, up to a quarter of an hour', () => {
    fail(5);
    expect(wait()).toBe(30);

    const waits: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      time += wait() * 1000;
      expect(wait()).toBe(0);
      fail(1);
      waits.push(wait());
    }

    expect(waits).toEqual([60, 120, 240, 480, 900, 900, 900]);
  });

  it('counts down while the client waits', () => {
    fail(5);
    time += 12_500;

    expect(wait()).toBe(18);
  });

  it('starts from nothing after a correct sign-in', () => {
    fail(4);
    gate.succeeded('admin', '203.0.113.7');
    fail(4);

    expect(wait()).toBe(0);
  });

  it('counts each client and each door on its own', () => {
    fail(5, 'admin', '203.0.113.7');

    expect(wait('admin', '203.0.113.8')).toBe(0);
    expect(wait('reviewer', '203.0.113.7')).toBe(0);
    expect(wait('admin', '203.0.113.7')).toBe(30);
  });

  it('forgets a client that has not failed for an hour', () => {
    fail(4);
    time += 61 * 60_000;
    // Somebody else failing is what clears out the old.
    fail(1, 'admin', '198.51.100.1');
    fail(1);

    expect(wait()).toBe(0);
    fail(3);
    expect(wait()).toBe(0);
  });

  it('logs every failure with the door, the client and the count', () => {
    fail(5);

    expect(logged).toHaveLength(5);
    expect(logged[0]).toBe('failed admin sign-in from 203.0.113.7 (1 in a row)');
    expect(logged[4]).toBe('failed admin sign-in from 203.0.113.7 (5 in a row; next attempt in 30 s)');
  });

  it('keeps no more clients in memory than its bound', () => {
    for (let i = 0; i < 10_050; i += 1) gate.failed('admin', `client-${i}`);

    // The earliest were dropped to make room.
    fail(4, 'admin', 'client-0');
    expect(wait('admin', 'client-0')).toBe(0);
    fail(1, 'admin', 'client-0');
    expect(wait('admin', 'client-0')).toBe(30);
  });
});
