// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { hashPassword, hashPasswordAtStartup, MAX_PENDING, verifyPassword } from './password-hash.js';

describe('password hashing', () => {
  it('checks what it hashed, and nothing else', async () => {
    const hash = await hashPassword('correct horse battery staple', 8);

    expect(hash).toMatch(/^\$2b\$08\$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapler', hash)).toBe(false);
  });

  it('reads a hash the earlier library wrote', async () => {
    // Written by bcryptjs 3.0.3 for the text below, at cost 8.
    const earlier = '$2b$08$wRFLCZkJzDegmFOW43C9ruUrrtxI2mCSg4wFI3Hwv8YucfX3UqTqO';

    expect(await verifyPassword('written-by-the-earlier-library', earlier)).toBe(true);
    expect(await verifyPassword('something else', earlier)).toBe(false);
  });

  it('does not match a hash that is not one, instead of failing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });

  it('makes the same kind of hash at start-up', async () => {
    const hash = hashPasswordAtStartup('placeholder', 8);

    expect(await verifyPassword('placeholder', hash)).toBe(true);
  });

  it('leaves the thread that serves requests free while it works', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);

    await Promise.all(Array.from({ length: 8 }, () => hashPassword('x', 11)));

    clearInterval(timer);
    // Eight hashes at cost 11 take a few hundred milliseconds; a blocked thread would tick once at most.
    expect(ticks).toBeGreaterThan(5);
  });

  it('refuses more checks at once than its bound, and takes them again when there is room', async () => {
    const running = Array.from({ length: MAX_PENDING }, () => hashPassword('x', 8));

    await expect(verifyPassword('x', 'not-a-hash')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await Promise.all(running);

    expect(await verifyPassword('x', await hashPassword('x', 8))).toBe(true);
  });
});
