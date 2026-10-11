// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { blindIndex, decrypt, deriveKey, encrypt } from '../common/crypto.js';
import type { Env } from '../config/env.js';

/**
 * The address of an account: how it is compared, how it is found, and how it
 * is written down and read back. An address is never stored in the clear: the
 * column holds a ciphertext, and a keyed index of the address finds the
 * account. Both keys are derived from `DATA_ENCRYPTION_SECRET`.
 */
@Injectable()
export class AccountEmail {
  private readonly key: string;
  private readonly indexKey: string;

  constructor(config: ConfigService<Env, true>) {
    const master = config.get('DATA_ENCRYPTION_SECRET', { infer: true });
    this.key = deriveKey(master, 'email-encryption');
    this.indexKey = deriveKey(master, 'email-blind-index');
  }

  /** An address as it is compared: without the spaces around it, in lower case. */
  normalise(address: string): string {
    return address.trim().toLowerCase();
  }

  /** What finds the account of a normalised address. */
  indexOf(address: string): string {
    return blindIndex(address, this.indexKey);
  }

  seal(address: string): string {
    return encrypt(address, this.key);
  }

  open(sealed: string): string {
    return decrypt(sealed, this.key);
  }
}
