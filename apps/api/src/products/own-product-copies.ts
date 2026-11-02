// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import { NotificationType, type ProductNoticePayload } from '@diet-app/shared';
import type { NotificationsService } from '../notifications/notifications.service.js';

/**
 * One code in one place: what accounts wrote of a code the base now holds gives
 * way to what the base holds. Their entries go on to the base's product and keep
 * their figures, each row goes, and whoever wrote one is told. `except` is the
 * account the product came from, which is told otherwise.
 */
export async function copiesGiveWay(
  tx: Prisma.TransactionClient,
  notifications: NotificationsService,
  product: { id: string; code: string },
  replacedBy: NonNullable<ProductNoticePayload['replacedBy']>,
  now: Date,
  except: string | null = null,
): Promise<number> {
  const copies = await tx.ownProduct.findMany({
    where: { code: product.code, ...(except ? { userId: { not: except } } : {}) },
    select: { id: true, userId: true, name: true },
  });
  for (const copy of copies) {
    await tx.diaryEntry.updateMany({
      where: { ownProductId: copy.id },
      data: { ownProductId: null, productId: product.id },
    });
    await notifications.notifyAccount(
      tx,
      copy.userId,
      NotificationType.enum.product_replaced,
      { name: copy.name, reason: null, replacedBy },
      now,
    );
  }
  await tx.ownProduct.deleteMany({ where: { id: { in: copies.map((copy) => copy.id) } } });
  return copies.length;
}
