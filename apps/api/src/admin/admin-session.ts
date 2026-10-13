// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The administrator's session.
 *
 * The administrator is whoever knows `ADMIN_USER` and `ADMIN_PASSWORD`. They
 * are given once, at sign-in, for a session cookie; no request after that
 * carries the password. The cookie is signed with a key of its own, is read
 * by no script, and is sent to the admin routes alone and with nothing that
 * another site causes.
 *
 * A session ends by itself after eight hours, and before that when the
 * credentials of the instance change (the session holds a mark of them, made
 * with the session key, that says nothing about them) or when the
 * administrator ends every session (the epoch moves on).
 */
import { scryptSync, timingSafeEqual } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ADMIN_AUDIENCE, TOKEN_ALGORITHM } from '../auth/token-kinds.js';
import { deriveKey } from '../common/crypto.js';
import type { Env } from '../config/env.js';

export const ADMIN_COOKIE = 'admin_session';
const ADMIN_PATH = '/api/admin';
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

const jwt = new JwtService({});
const keyOf = (config: ConfigService<Env, true>): string => deriveKey(config.get('DATA_ENCRYPTION_SECRET', { infer: true }), 'admin-session');

/** The size of the blocks two values are compared in: more than a value of a request can fill. */
const COMPARED_BYTES = 1024;

/**
 * Compare a value that was given with the one the instance holds, without
 * the time taken saying where they differ, or that their lengths do. Both
 * are laid out in blocks of one size and the blocks are compared whole. The
 * size follows the value the instance holds where that is the longer.
 */
export function sameText(given: string, held: string): boolean {
  const size = Math.max(COMPARED_BYTES, Buffer.byteLength(held));
  const left = Buffer.alloc(size);
  const right = Buffer.alloc(size);
  left.write(given);
  right.write(held);
  const alike = timingSafeEqual(left, right);
  // Blocks that are alike hold the same value only if the values are as long: "a" is not "a" with a zero byte after it.
  const asLong = Buffer.byteLength(given) === Buffer.byteLength(held);
  return alike && asLong;
}

/** Whether these are the credentials of the instance. Both are compared whatever the first says. */
export function isAdministrator(config: ConfigService<Env, true>, user: string, password: string): boolean {
  const userOk = sameText(user, config.get('ADMIN_USER', { infer: true }));
  const passwordOk = sameText(password, config.get('ADMIN_PASSWORD', { infer: true }));
  return userOk && passwordOk;
}

const marks = new WeakMap<object, string>();

/**
 * What a session holds of the credentials it was begun with: enough to
 * notice that they changed, and nothing to learn them from. It is made with a
 * function that is slow on purpose, salted with the session key, and once for
 * a process: the credentials of an instance do not change while it runs.
 */
function credentialsMark(config: ConfigService<Env, true>): string {
  const made = marks.get(config);
  if (made) return made;
  const credentials = JSON.stringify([config.get('ADMIN_USER', { infer: true }), config.get('ADMIN_PASSWORD', { infer: true })]);
  const mark = scryptSync(credentials, Buffer.from(keyOf(config), 'hex'), 16).toString('hex');
  marks.set(config, mark);
  return mark;
}

export function signAdminSession(config: ConfigService<Env, true>, epoch: number, lifetimeSeconds = ADMIN_SESSION_SECONDS): string {
  return jwt.sign(
    { epoch, credentials: credentialsMark(config) },
    { secret: keyOf(config), expiresIn: lifetimeSeconds, algorithm: TOKEN_ALGORITHM, audience: ADMIN_AUDIENCE },
  );
}

/** Whether a cookie holds a session that counts: signed here, not run out, of this epoch, and begun with the credentials the instance has now. */
export function isAdminSession(config: ConfigService<Env, true>, token: string, epoch: number): boolean {
  try {
    const claims = jwt.verify<{ epoch?: unknown; credentials?: unknown }>(token, { secret: keyOf(config), algorithms: [TOKEN_ALGORITHM], audience: ADMIN_AUDIENCE });
    return claims.epoch === epoch && typeof claims.credentials === 'string' && sameText(claims.credentials, credentialsMark(config));
  } catch {
    return false;
  }
}

/** The `Set-Cookie` of a session that begins, or with `null` of one that ends. */
export function adminCookie(token: string | null, appUrl: string): string {
  return [
    `${ADMIN_COOKIE}=${encodeURIComponent(token ?? '')}`,
    `Path=${ADMIN_PATH}`,
    'HttpOnly',
    // Never sent along with a request that another site caused.
    'SameSite=Strict',
    ...(appUrl.startsWith('https://') ? ['Secure'] : []),
    `Max-Age=${token === null ? 0 : ADMIN_SESSION_SECONDS}`,
  ].join('; ');
}
