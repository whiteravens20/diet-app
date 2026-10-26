// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { CURRENT_FORM_PREFIX } from '../common/crypto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountEmail } from './account-email.js';

/** How many values a run sealed anew, and how many it could not read and left as they were. */
export interface Resealed {
  sealed: number;
  unreadable: number;
}

const PAGE = 200;

/**
 * Addresses that were stored before an address was sealed for its account
 * open for any account. This seals each of them for its own, once: a run that
 * finds none does nothing. Addresses in use and addresses waiting to be
 * confirmed are both covered.
 */
@Injectable()
export class AddressResealService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emails: AccountEmail,
  ) {}

  async run(): Promise<Resealed> {
    const result: Resealed = { sealed: 0, unreadable: 0 };
    const earlier = { not: { startsWith: CURRENT_FORM_PREFIX } };

    for (let after = ''; ;) {
      const rows = await this.prisma.user.findMany({
        where: { emailEncrypted: earlier, id: { gt: after } },
        select: { id: true, emailEncrypted: true },
        orderBy: { id: 'asc' },
        take: PAGE,
      });
      if (rows.length === 0) break;
      after = rows.at(-1)!.id;
      for (const row of rows) {
        await reseal(
          result,
          () => this.emails.seal(this.emails.open(row.emailEncrypted, row.id), row.id),
          // Only while the row still holds what was read: an address changed in the meantime is sealed already.
          (sealed) =>
            this.prisma.user.updateMany({
              where: { id: row.id, emailEncrypted: row.emailEncrypted },
              data: { emailEncrypted: sealed },
            }),
        );
      }
    }

    for (let after = ''; ;) {
      const rows = await this.prisma.emailChangeToken.findMany({
        where: { newEmailEncrypted: earlier, id: { gt: after } },
        select: { id: true, userId: true, newEmailEncrypted: true },
        orderBy: { id: 'asc' },
        take: PAGE,
      });
      if (rows.length === 0) break;
      after = rows.at(-1)!.id;
      for (const row of rows) {
        await reseal(
          result,
          () =>
            this.emails.sealPending(
              this.emails.openPending(row.newEmailEncrypted, row.userId),
              row.userId,
            ),
          (sealed) =>
            this.prisma.emailChangeToken.updateMany({
              where: { id: row.id, newEmailEncrypted: row.newEmailEncrypted },
              data: { newEmailEncrypted: sealed },
            }),
        );
      }
    }
    return result;
  }
}

/** Seal one value anew and write it, counting how it went. */
async function reseal(
  result: Resealed,
  seal: () => string,
  write: (sealed: string) => Promise<{ count: number }>,
): Promise<void> {
  let sealed: string;
  try {
    sealed = seal();
  } catch {
    // Damaged, or written under another secret: nothing here can read it.
    result.unreadable += 1;
    return;
  }
  result.sealed += (await write(sealed)).count;
}
