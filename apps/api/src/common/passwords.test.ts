// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as bcrypt from 'bcrypt';
import { describe, expect, it } from 'vitest';
import { Passwords } from './passwords.js';

const settings = (secret = 'a'.repeat(64), rounds = 4) => {
  const values: Record<string, unknown> = {
    DATA_ENCRYPTION_SECRET: secret,
    PASSWORD_HASH_ROUNDS: rounds,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return { get: (key: string) => values[key] } as any;
};

describe('a password the application keeps', () => {
  it('is matched by itself and by nothing else', async () => {
    const passwords = new Passwords(settings());
    const hash = await passwords.hash('Correct-Horse-1');

    expect(await passwords.matches('Correct-Horse-1', hash)).toBe(true);
    expect(await passwords.matches('correct-horse-1', hash)).toBe(false);
  });

  it('is hashed at the configured cost, with a key of the application: the hash alone is nothing to guess against', async () => {
    const passwords = new Passwords(settings());
    const hash = await passwords.hash('Correct-Horse-1');

    expect(hash).toMatch(/^\$2[aby]\$04\$/);
    // Not what bcrypt makes of the password itself.
    expect(await bcrypt.compare('Correct-Horse-1', hash)).toBe(false);
    // And not what an application with another secret makes of it.
    expect(await new Passwords(settings('b'.repeat(64))).matches('Correct-Horse-1', hash)).toBe(
      false,
    );
  });

  it('is told apart to its last character, however long it is', async () => {
    const passwords = new Passwords(settings());
    const long = 'x'.repeat(100);
    const hash = await passwords.hash(`${long}1`);

    // bcrypt alone reads 72 bytes and would take these two for one.
    expect(await passwords.matches(`${long}2`, hash)).toBe(false);
    expect(await passwords.matches(`${long}1`, hash)).toBe(true);
  });

  it('is checked for somebody who has none too, against a real hash at the same cost, so that the answer takes as long', async () => {
    const passwords = new Passwords(settings());

    expect(await passwords.matches('whatever', null)).toBe(false);
    expect(await passwords.matches('whatever', undefined)).toBe(false);
    // What such a check is made against: a hash bcrypt works through, not a constant it refuses at once.
    const nobodys = (passwords as unknown as { nobodys: string }).nobodys;
    expect(nobodys).toMatch(/^\$2[aby]\$04\$.{53}$/);
  });

  it('is never matched by the password nobody has', async () => {
    expect(await new Passwords(settings()).matches('uniform-timing-placeholder', null)).toBe(false);
  });
});
