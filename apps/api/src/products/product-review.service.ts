// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  NotificationType,
  type AcceptedProducts,
  type ProductQueue,
  type ProductUnderReview,
} from '@diet-app/shared';
import { InstanceFilesService } from '../admin/drafts/ship/instance-files.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { copiesGiveWay } from './own-product-copies.js';
import { productDto, productOfOwn, type HeldOwnProduct } from './product-row.js';

/** How many products a page of the queue and of the accepted holds. */
const PAGE = 50;

const notWaiting = (): ConflictException =>
  new ConflictException({
    error: 'PRODUCT_NOT_WAITING',
    message: 'This product is no longer waiting for review.',
  });

/** A product without where it comes from and whether it corrects the base's, which what a review reads leaves out. */
function withoutSource<T extends { source: unknown; correction: unknown }>(
  product: T,
): Omit<T, 'source' | 'correction'> {
  const rest: Partial<T> = { ...product };
  delete rest.source;
  delete rest.correction;
  return rest as Omit<T, 'source' | 'correction'>;
}

/** A product waiting, as a reviewer sees it: its author is not named. */
function underReview(row: HeldOwnProduct): ProductUnderReview {
  return {
    ...withoutSource(productOfOwn(row)),
    sentAt: row.sentAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * What the instance's reviewers and its administrator do with what accounts
 * send to its base. Accepted, a product is everybody's: it becomes a row of the
 * base, what accounts wrote of its code gives way, and what the base holds goes
 * into the instance's files.
 */
@Injectable()
export class ProductReviewService {
  private readonly logger = new Logger(ProductReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly files: InstanceFilesService,
  ) {}

  /** The products waiting, the longest first. */
  async queue(): Promise<ProductQueue> {
    const [rows, total] = await Promise.all([
      this.prisma.ownProduct.findMany({
        where: { state: 'sent' },
        orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
        take: PAGE,
      }),
      this.prisma.ownProduct.count({ where: { state: 'sent' } }),
    ]);
    return { items: rows.map(underReview), total };
  }

  /** Take a product as the reviewer saw it. A product changed since is refused. */
  async accept(id: string, seen: string, by: string, now = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.ownProduct.findUnique({ where: { id } });
      if (!row || row.state !== 'sent' || row.code === null) throw notWaiting();
      if (row.updatedAt.toISOString() !== seen) {
        throw new ConflictException({
          error: 'PRODUCT_CHANGED',
          message: 'This product changed after it was read. Read it again.',
        });
      }
      const inTheBase = await tx.product.findUnique({ where: { code: row.code } });
      if (inTheBase && inTheBase.calories !== null) {
        throw new ConflictException({
          error: 'PRODUCT_CODE_KNOWN',
          message: 'The base has a product of this code by now.',
        });
      }
      const columns = {
        name: row.name,
        brand: row.brand,
        searchText: row.searchText,
        pack: row.pack,
        unit: row.unit,
        packAmount: row.packAmount,
        servingAmount: row.servingAmount,
        calories: row.calories,
        protein: row.protein,
        fat: row.fat,
        carbs: row.carbs,
        fiber: row.fiber,
        sugars: row.sugars,
        salt: row.salt,
        saturatedFat: row.saturatedFat,
        doubtful: row.doubtful,
        energyWorkedOut: false,
        origin: 'accepted' as const,
        authorId: row.userId,
        acceptedBy: by,
        acceptedAt: now,
        readAt: now,
      };
      const product = await tx.product.upsert({
        where: { code: row.code },
        create: { code: row.code, ...columns },
        update: columns,
      });
      await tx.productCodeUnknown.deleteMany({ where: { code: row.code } });
      await tx.diaryEntry.updateMany({
        where: { ownProductId: row.id },
        data: { ownProductId: null, productId: product.id },
      });
      await tx.ownProduct.delete({ where: { id: row.id } });
      await copiesGiveWay(tx, this.notifications, product, 'instance', now, row.userId);
      await this.notifications.notifyAccount(
        tx,
        row.userId,
        NotificationType.enum.product_accepted,
        { name: row.name, reason: null, replacedBy: null },
        now,
      );
    });
    await this.writeFiles();
  }

  /** Turn a product down, as the reviewer saw it: its author is told why, and it stays theirs. */
  async reject(id: string, seen: string, reason: string, now = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.ownProduct.findUnique({ where: { id } });
      if (!row || row.state !== 'sent') throw notWaiting();
      if (row.updatedAt.toISOString() !== seen) {
        throw new ConflictException({
          error: 'PRODUCT_CHANGED',
          message: 'This product changed after it was read. Read it again.',
        });
      }
      await tx.ownProduct.update({
        where: { id },
        data: { state: 'rejected', reason, sentAt: null },
      });
      await this.notifications.notifyAccount(
        tx,
        row.userId,
        NotificationType.enum.product_rejected,
        { name: row.name, reason, replacedBy: null },
        now,
      );
    });
  }

  /** What the instance accepted, the latest first. */
  async accepted(page: number): Promise<AcceptedProducts> {
    const where = { origin: 'accepted' as const };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: [{ acceptedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * PAGE,
        take: PAGE,
      }),
      this.prisma.product.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        ...withoutSource(productDto(row)),
        acceptedAt: (row.acceptedAt ?? row.readAt).toISOString(),
        acceptedBy: row.acceptedBy,
        hasAuthor: row.authorId !== null,
      })),
      page,
      total,
      totalPages: Math.ceil(total / PAGE),
    };
  }

  /**
   * Withdraw an accepted product from the base. It goes back to its author as
   * turned down, with the reason; where the author is gone it is removed. What
   * diaries hold of it keeps its figures.
   */
  async withdraw(id: string, reason: string, now = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id } });
      if (!product || product.origin !== 'accepted') {
        throw new NotFoundException({
          error: 'PRODUCT_NOT_FOUND',
          message: 'No accepted product of this id.',
        });
      }
      if (product.authorId !== null && product.calories !== null) {
        const own = await tx.ownProduct.create({
          data: {
            userId: product.authorId,
            code: product.code,
            name: product.name,
            brand: product.brand,
            searchText: product.searchText,
            pack: product.pack,
            unit: product.unit,
            packAmount: product.packAmount,
            servingAmount: product.servingAmount,
            calories: product.calories,
            protein: product.protein,
            fat: product.fat,
            carbs: product.carbs,
            fiber: product.fiber,
            sugars: product.sugars,
            salt: product.salt,
            saturatedFat: product.saturatedFat,
            doubtful: product.doubtful,
            state: 'rejected',
            reason,
          },
        });
        await tx.diaryEntry.updateMany({
          where: { productId: id, profile: { userId: product.authorId } },
          data: { productId: null, ownProductId: own.id },
        });
        await this.notifications.notifyAccount(
          tx,
          product.authorId,
          NotificationType.enum.product_withdrawn,
          { name: product.name, reason, replacedBy: null },
          now,
        );
      }
      await tx.product.delete({ where: { id } });
    });
    await this.writeFiles();
  }

  /** The instance's files hold what the base accepted: what was decided stands whatever becomes of writing them. */
  private async writeFiles(): Promise<void> {
    const done = await this.files.write();
    if (done.error) this.logger.warn(`The instance's files were not written: ${done.error}`);
  }
}
