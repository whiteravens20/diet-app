// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { RecoveryCodes, SecondFactorSetup } from '@diet-app/shared';
import { SecondFactors } from '../auth/second-factors.js';
import { codeAt } from '../common/totp.js';
import { as, type TestUser } from './factories.js';
import type { TestApp } from './test-app.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HALF_A_MINUTE = 30_000;

/** The bytes of a secret, from the text an authenticator app is given. */
function fromBase32(text: string): Buffer {
  let bits = '';
  for (const char of text) bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
}

/**
 * An authenticator app, and the clock it shares with the application under
 * test. A code the application accepts has to be of a later half minute
 * than the one it accepted last, so a test lets time pass between two codes.
 */
export interface Authenticator {
  /** The code the app shows now for `secret`, as the app was given it. */
  code(secret: string): string;
  /** Six digits the app shows neither now nor in the half minute before or after. */
  wrongCode(secret: string): string;
  /** Let time pass. */
  wait(seconds: number): void;
  now(): number;
}

export function anAuthenticator(t: TestApp): Authenticator {
  let now = Date.now();
  t.app.get(SecondFactors).now = () => now;
  const code = (secret: string, at = now): string => codeAt(fromBase32(secret), at);
  return {
    code,
    wrongCode(secret) {
      const right = [-1, 0, 1].map((step) => code(secret, now + step * HALF_A_MINUTE));
      let guess = 0;
      while (right.includes(String(guess).padStart(6, '0'))) guess += 1;
      return String(guess).padStart(6, '0');
    },
    wait: (seconds) => void (now += seconds * 1000),
    now: () => now,
  };
}

/** A second factor for `user`, set up from the session `user` holds with `app`. Time moves on past the code that set it up. */
export async function aSecondFactor(t: TestApp, user: TestUser, app: Authenticator): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup: SecondFactorSetup = (await t.http().post('/api/users/me/second-factor/setup').set(as(user)).send({ currentPassword: user.password }).expect(200)).body;
  const { recoveryCodes }: RecoveryCodes = (
    await t.http().post('/api/users/me/second-factor').set(as(user)).send({ enrolment: setup.enrolment, code: app.code(setup.secret) }).expect(201)
  ).body;
  app.wait(30);
  return { secret: setup.secret, recoveryCodes };
}
