// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * One-time codes as authenticator apps make them: RFC 4226 (a code from a
 * secret and a counter) and RFC 6238 (the counter is the time, in steps of
 * thirty seconds).
 *
 * The application uses what every authenticator app understands: HMAC-SHA1,
 * six digits, thirty seconds. Several apps ignore any other setting of the
 * QR code they scan, and would then show codes that never match.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type CodeAlgorithm = 'sha1' | 'sha256' | 'sha512';

const PERIOD_SECONDS = 30;
const DIGITS = 6;
/** Bytes of a new secret: the length of the hash, as RFC 4226 advises. */
export const SECRET_BYTES = 20;

/** The code of `counter` (RFC 4226, section 5.3). */
export function hotp(secret: Buffer, counter: number, digits = DIGITS, algorithm: CodeAlgorithm = 'sha1'): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const number = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** digits).padStart(digits, '0');
}

/** The time step a moment is in. */
export function stepAt(timeMs: number): number {
  return Math.floor(timeMs / 1000 / PERIOD_SECONDS);
}

/** The code an authenticator shows at a moment. */
export function codeAt(secret: Buffer, timeMs: number): string {
  return hotp(secret, stepAt(timeMs));
}

/**
 * The time step `code` is the code of, among the present one and its two
 * neighbours, or null when it is the code of none of them. A neighbour is
 * allowed for the time it takes to type a code, and for a clock that is a
 * little off.
 *
 * The three are all compared, each in constant time, so that the time taken
 * says nothing about which matched or how far a wrong code was right.
 */
export function matchingStep(secret: Buffer, code: string, timeMs: number): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const given = Buffer.from(code, 'ascii');
  const now = stepAt(timeMs);
  let found: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    if (timingSafeEqual(given, Buffer.from(hotp(secret, step), 'ascii'))) found = step;
  }
  return found;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base 32 as authenticator apps take a secret (RFC 4648), without the padding they do not want. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * What an authenticator app scans to take a secret over: the secret, whose
 * it is, and how its codes are made. `issuer` and `account` are what the app
 * shows next to the code.
 */
export function otpauthUri({ secret, issuer, account }: { secret: Buffer; issuer: string; account: string }): string {
  // A colon parts the issuer from the account in the label.
  const plain = (text: string): string => text.replaceAll(':', '').replace(/\s+/g, ' ').trim();
  const label = `${encodeURIComponent(plain(issuer))}:${encodeURIComponent(plain(account))}`;
  const params = new URLSearchParams({ secret: base32(secret), issuer: plain(issuer), algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD_SECONDS) });
  // Spaces as %20: not every app reads a plus sign as one.
  return `otpauth://totp/${label}?${params.toString().replaceAll('+', '%20')}`;
}
