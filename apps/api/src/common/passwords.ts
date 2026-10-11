// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { deriveKey, pepperPassword } from './crypto.js';
import { hashPassword, hashPasswordAtStartup, verifyPassword } from './password-hash.js';

/**
 * How every password the application keeps is hashed and checked: an
 * account's, and the one reviewers share. A password is peppered with a key
 * of the application's before bcrypt, so a copy of the database alone is
 * nothing to guess against, and bcrypt's limit of 72 bytes does not apply.
 */
@Injectable()
export class Passwords {
  private readonly pepperKey: string;
  private readonly rounds: number;
  /**
   * A valid hash at the configured cost, of a password nobody has. A check
   * for an account that does not exist is made against it, so that it takes
   * as long as a real one: a constant that is no hash would be refused at
   * once, and the time of the answer would say whether the account exists.
   */
  private readonly nobodys: string;

  constructor(config: ConfigService<Env, true>) {
    this.pepperKey = deriveKey(config.get('DATA_ENCRYPTION_SECRET', { infer: true }), 'password-pepper');
    this.rounds = config.get('PASSWORD_HASH_ROUNDS', { infer: true });
    this.nobodys = hashPasswordAtStartup('uniform-timing-placeholder', this.rounds);
  }

  hash(password: string): Promise<string> {
    return hashPassword(pepperPassword(password, this.pepperKey), this.rounds);
  }

  /** Whether `password` is the one `hash` was made from. Without a hash the check is made all the same, and fails. */
  matches(password: string, hash: string | null | undefined): Promise<boolean> {
    return verifyPassword(pepperPassword(password, this.pepperKey), hash ?? this.nobodys).then((ok) => ok && hash != null);
  }
}

@Global()
@Module({ providers: [Passwords], exports: [Passwords] })
export class PasswordsModule {}
