// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  OWN_PRODUCTS,
  type OwnProduct,
  type OwnProductBody,
  type OwnProducts,
  type ProductAdditions,
} from '@diet-app/shared';
import { productCodeOf } from '@diet-app/shared/product-code';
import { addedProducts } from '../admin/drafts/ship/instance-export.js';
import { holdAccount } from '../common/hold.js';
import type { Env } from '../config/env.js';
import { readLabel } from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { productsOffered } from './offered.js';
import { ownProductDto, searchTextOf } from './product-row.js';
import { ProductsService } from './products.service.js';

const DAY_MS = 86_400_000;

/** The columns of a product of one's own, from what was written of it. */
function columnsOf(body: OwnProductBody, code: string | null) {
  const { per100 } = body;
  const brand = body.brand === '' ? null : body.brand;
  return {
    code,
    name: body.name,
    brand,
    searchText: searchTextOf(body.name, brand),
    pack: body.pack === '' ? null : body.pack,
    unit: body.unit,
    packAmount: body.packAmount,
    servingAmount: body.servingAmount,
    ...per100,
    // What cannot be true the contract refused: figures that merely do not add up are written, and marked.
    doubtful: readLabel({
      kcal: per100.calories,
      kj: null,
      protein: per100.protein,
      fat: per100.fat,
      carbs: per100.carbs,
      fiber: per100.fiber,
      sugars: per100.sugars,
      salt: per100.salt,
      sodium: null,
      saturatedFat: per100.saturatedFat,
      alcohol: null,
      polyols: null,
    }).doubtful,
  };
}

const held = (): ConflictException =>
  new ConflictException({
    error: 'PRODUCT_CODE_HELD',
    message: 'A product of yours has this code already.',
  });

/**
 * Products an account writes for itself: what it adds to its diary where the
 * base has nothing, and what it may send to the base for the instance's
 * reviewers. They live in a table of their own, which nothing but these routes,
 * a search of their owner and a diary of their owner reads. An instance without
 * Open Food Facts has no products at all, its own included.
 */
@Injectable()
export class OwnProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly products: ProductsService,
  ) {}

  async list(userId: string): Promise<OwnProducts> {
    this.assertOffered();
    const rows = await this.prisma.ownProduct.findMany({
      where: { userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: OWN_PRODUCTS.held,
    });
    return { items: rows.map(ownProductDto) };
  }

  async create(userId: string, body: OwnProductBody, now = new Date()): Promise<OwnProduct> {
    this.assertOffered();
    const code = body.code === null ? null : productCodeOf(body.code);
    if (code !== null) await this.refuseWhatTheBaseKnows(userId, code, now);
    const row = await this.prisma.$transaction(async (tx) => {
      await holdAccount(tx, userId);
      if ((await tx.ownProduct.count({ where: { userId } })) >= OWN_PRODUCTS.held) {
        throw new ConflictException({
          error: 'OWN_PRODUCT_LIMIT',
          message: `An account holds at most ${OWN_PRODUCTS.held} products of its own.`,
        });
      }
      await this.countWriting(tx, userId, now);
      if (code !== null && (await this.holdsCode(tx, userId, code))) throw held();
      return tx.ownProduct.create({ data: { userId, ...columnsOf(body, code) } });
    });
    return ownProductDto(row);
  }

  /** Change a product. One that was waiting for review leaves the queue, and has to be sent again. */
  async update(
    userId: string,
    id: string,
    body: OwnProductBody,
    now = new Date(),
  ): Promise<OwnProduct> {
    this.assertOffered();
    const current = await this.own(userId, id);
    const code = body.code === null ? null : productCodeOf(body.code);
    const newCode = code !== null && code !== current.code;
    if (newCode) await this.refuseWhatTheBaseKnows(userId, code, now);
    const row = await this.prisma.$transaction(async (tx) => {
      await holdAccount(tx, userId);
      await this.countWriting(tx, userId, now);
      if (newCode && (await this.holdsCode(tx, userId, code))) throw held();
      return tx.ownProduct.update({
        where: { id },
        data: { ...columnsOf(body, code), state: 'own', sentAt: null, reason: null },
      });
    });
    return ownProductDto(row);
  }

  /** A product goes; what the diary holds of it keeps its figures. */
  async remove(userId: string, id: string): Promise<void> {
    this.assertOffered();
    await this.own(userId, id);
    await this.prisma.ownProduct.deleteMany({ where: { id, userId } });
  }

  /** Send a product to the base, for the instance's reviewers: it needs a code and all four of its figures. */
  async send(userId: string, id: string, now = new Date()): Promise<OwnProduct> {
    this.assertOffered();
    const current = await this.own(userId, id);
    if (current.state === 'sent') return ownProductDto(current);
    const { code, protein, fat, carbs } = current;
    if (code === null || protein === null || fat === null || carbs === null) {
      throw new ConflictException({
        error: 'OWN_PRODUCT_NOT_SENDABLE',
        message:
          'A product goes to the base with its code, its energy, protein, fat and carbohydrates.',
      });
    }
    await this.refuseWhatTheBaseKnows(userId, code, now);
    const row = await this.prisma.$transaction(async (tx) => {
      await holdAccount(tx, userId);
      const sent = await tx.ownProductChange.count({
        where: { userId, kind: 'sent', at: { gt: new Date(now.getTime() - DAY_MS) } },
      });
      if (sent >= OWN_PRODUCTS.sentADay) {
        throw new HttpException(
          {
            error: 'OWN_PRODUCT_SEND_LIMIT',
            message: `An account sends at most ${OWN_PRODUCTS.sentADay} products to the base in 24 hours.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await tx.ownProductChange.create({ data: { userId, kind: 'sent', at: now } });
      return tx.ownProduct.update({
        where: { id },
        data: { state: 'sent', sentAt: now, reason: null },
      });
    });
    return ownProductDto(row);
  }

  /** Take a product back out of the queue: it stays the account's own. */
  async withdraw(userId: string, id: string): Promise<OwnProduct> {
    this.assertOffered();
    const current = await this.own(userId, id);
    if (current.state !== 'sent') {
      throw new ConflictException({
        error: 'PRODUCT_NOT_WAITING',
        message: 'This product is not waiting for review.',
      });
    }
    const row = await this.prisma.ownProduct.update({
      where: { id },
      data: { state: 'own', sentAt: null },
    });
    return ownProductDto(row);
  }

  /** What people added to the base, without who added them. */
  async additions(): Promise<ProductAdditions> {
    this.assertOffered();
    return addedProducts(this.prisma);
  }

  private assertOffered(): void {
    if (!productsOffered(this.config)) {
      throw new NotFoundException({
        error: 'PRODUCTS_NOT_OFFERED',
        message: 'This instance offers no products.',
      });
    }
  }

  private async own(userId: string, id: string) {
    const row = await this.prisma.ownProduct.findFirst({ where: { id, userId } });
    if (!row) {
      throw new NotFoundException({
        error: 'OWN_PRODUCT_NOT_FOUND',
        message: 'Product not found.',
      });
    }
    return row;
  }

  private async holdsCode(
    tx: Prisma.TransactionClient,
    userId: string,
    code: string,
  ): Promise<boolean> {
    return (await tx.ownProduct.count({ where: { userId, code } })) > 0;
  }

  /** Count a write of the day, or refuse it: what was written and deleted again still counts. */
  private async countWriting(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
  ): Promise<void> {
    const written = await tx.ownProductChange.count({
      where: { userId, kind: 'written', at: { gt: new Date(now.getTime() - DAY_MS) } },
    });
    if (written >= OWN_PRODUCTS.writtenADay) {
      throw new HttpException(
        {
          error: 'OWN_PRODUCT_DAILY_LIMIT',
          message: `An account writes or changes at most ${OWN_PRODUCTS.writtenADay} products in 24 hours.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await tx.ownProductChange.create({ data: { userId, kind: 'written', at: now } });
  }

  /** One code in one place: a code the base knows with figures is not written again. */
  private async refuseWhatTheBaseKnows(userId: string, code: string, now: Date): Promise<void> {
    if (await this.products.knownToTheBase(userId, code, now)) {
      throw new ConflictException({
        error: 'PRODUCT_CODE_KNOWN',
        message: 'The base has a product of this code. Add yours without a code if you disagree.',
      });
    }
  }
}
