// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PRODUCT_SEARCH, type Product, type ProductSearchResult } from '@diet-app/shared';
import { wordsOfProductSearch } from '@diet-app/shared/product-code';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { productsOffered } from './offered.js';
import { OpenFoodFacts, ProductSourceError } from './open-food-facts.js';
import { copiesGiveWay } from './own-product-copies.js';
import {
  productColumns,
  productDto,
  productOfOwn,
  productRowOf,
  SEARCH_TEXT_PARTS,
  type HeldOwnProduct,
  type HeldProduct,
  type ProductRow,
} from './product-row.js';
import { PRODUCT_LOOKUPS, PRODUCT_MEMORY_DAYS } from './limits.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Of the requests that count a lookup, one goes at a time, so that a limit is the limit in every process of the API. */
const LOOKUPS_LOCK = 'diet-app product lookups';

function notFound(): NotFoundException {
  return new NotFoundException({
    error: 'PRODUCT_NOT_FOUND',
    message: 'No product with this code is known.',
  });
}

/**
 * The products with a barcode an account can read: what the instance holds,
 * and through it what Open Food Facts says of a code the instance does not
 * hold. Open Food Facts sees the instance, never the account.
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly source: OpenFoodFacts,
    private readonly notifications: NotificationsService,
  ) {}

  /** The product of a code: the reader's own first, then what the base knows. */
  async byCode(userId: string, code: string, now = new Date()): Promise<Product> {
    if (productsOffered(this.config)) {
      const own = await this.prisma.ownProduct.findUnique({
        where: { userId_code: { userId, code } },
      });
      if (own) return productOfOwn(own);
    }
    return this.ofTheBase(userId, code, now);
  }

  /**
   * Whether the base knows a code with figures, asking Open Food Facts as a scan
   * would and counting that against the account. What cannot be told just now
   * (lookups used up, Open Food Facts silent) stands in nobody's way.
   */
  async knownToTheBase(userId: string, code: string, now: Date): Promise<boolean> {
    try {
      return (await this.ofTheBase(userId, code, now)).per100.calories !== null;
    } catch (err) {
      if (err instanceof HttpException) return false;
      throw err;
    }
  }

  /**
   * The product of a code. What the import brought is answered as it is, and
   * so is what a lookup brought while it is recent; anything else is asked of
   * Open Food Facts where the instance does that, and what it answered is kept
   * for everybody. An older answer stands where a new one cannot be had.
   */
  private async ofTheBase(userId: string, code: string, now: Date): Promise<Product> {
    const held = await this.prisma.product.findUnique({ where: { code } });
    const recent = (at: Date, days: number) => now.getTime() - at.getTime() < days * DAY_MS;
    if (
      held &&
      (held.origin !== 'looked_up' || recent(held.readAt, PRODUCT_MEMORY_DAYS.lookedUp))
    ) {
      return productDto(held);
    }
    const lookups = this.config.get('OPEN_FOOD_FACTS_LOOKUPS', { infer: true });
    if (!lookups) {
      if (held) return productDto(held);
      throw notFound();
    }
    if (!held) {
      const unknown = await this.prisma.productCodeUnknown.findUnique({ where: { code } });
      if (unknown && recent(unknown.askedAt, PRODUCT_MEMORY_DAYS.unknown)) throw notFound();
    }
    try {
      await this.countLookup(userId, now);
    } catch (refused) {
      if (held) return productDto(held);
      throw refused;
    }

    let row: ProductRow | null;
    try {
      const said = await this.source.product(code);
      const read = said && productRowOf(said);
      row = read && typeof read === 'object' ? read : null;
    } catch (err) {
      if (!(err instanceof ProductSourceError)) throw err;
      this.logger.warn(`Open Food Facts gave no answer about a code: ${err.message}`);
      if (held) return productDto(held);
      throw new ServiceUnavailableException({
        error: 'PRODUCT_SOURCE_UNAVAILABLE',
        message: 'Open Food Facts cannot be asked just now.',
      });
    }
    if (!row) {
      await this.prisma.$transaction([
        this.prisma.productCodeUnknown.upsert({
          where: { code },
          create: { code, askedAt: now },
          update: { askedAt: now },
        }),
        this.prisma.product.deleteMany({ where: { code, origin: 'looked_up' } }),
      ]);
      throw notFound();
    }
    const columns = { ...productColumns(row), readAt: now };
    const kept = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.upsert({
        where: { code },
        create: { code, origin: 'looked_up', ...columns },
        update: columns,
      });
      await tx.productCodeUnknown.deleteMany({ where: { code } });
      // What accounts wrote of this code gives way, now that the base has its figures.
      if (product.calories !== null)
        await copiesGiveWay(tx, this.notifications, product, 'open_food_facts', now);
      return product;
    });
    return productDto(kept);
  }

  /**
   * What the instance holds that has every word of a search in its name or
   * brand and can be written into a diary, the reader's own products first.
   * What holds them in its name comes before what holds them only in its brand:
   * a search for milk is not for the butter of a brand called after it. Within
   * that, the products people scan most come first. A search looks at nothing
   * but the instance's own tables.
   */
  async search(userId: string, query: string): Promise<ProductSearchResult> {
    const words = wordsOfProductSearch(query);
    if (words.length === 0) return { items: [] };
    // Letters and digits alone: nothing here means anything else in a pattern.
    const inText = Prisma.join(
      words.map((word) => Prisma.sql`"searchText" LIKE ${`%${word}%`}`),
      ' AND ',
    );
    const inName = Prisma.join(
      words.map(
        (word) => Prisma.sql`split_part("searchText", ${SEARCH_TEXT_PARTS}, 1) LIKE ${`%${word}%`}`,
      ),
      ' AND ',
    );
    const own = productsOffered(this.config)
      ? await this.prisma.$queryRaw<HeldOwnProduct[]>`
          SELECT * FROM "OwnProduct"
          WHERE "userId" = ${userId} AND ${inText}
          ORDER BY (${inName}) DESC, "name" ASC, "id" ASC
          LIMIT ${PRODUCT_SEARCH.found}`
      : [];
    const rows = await this.prisma.$queryRaw<HeldProduct[]>`
      SELECT * FROM "Product"
      WHERE "calories" IS NOT NULL AND ${inText}
      ORDER BY (${inName}) DESC, "popularity" DESC, "name" ASC, "id" ASC
      LIMIT ${PRODUCT_SEARCH.found - own.length}`;
    return { items: [...own.map(productOfOwn), ...rows.map(productDto)] };
  }

  /**
   * Count a lookup of this account, or refuse it. A minute's limits are the
   * account's and the instance's, which keeps under what Open Food Facts allows
   * one address; the day's is the account's alone. A code the instance answers
   * by itself reaches none of them.
   */
  private async countLookup(userId: string, now: Date): Promise<void> {
    const minuteAgo = new Date(now.getTime() - MINUTE_MS);
    const dayAgo = new Date(now.getTime() - DAY_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${LOOKUPS_LOCK}))::text`,
      );
      const [instanceMinute, accountMinute, accountDay] = await Promise.all([
        tx.productLookup.count({ where: { at: { gt: minuteAgo } } }),
        tx.productLookup.count({ where: { userId, at: { gt: minuteAgo } } }),
        tx.productLookup.count({ where: { userId, at: { gt: dayAgo } } }),
      ]);
      if (accountDay >= PRODUCT_LOOKUPS.accountDay) {
        throw new HttpException(
          {
            error: 'PRODUCT_LOOKUPS_USED_UP',
            message: `An account asks about at most ${PRODUCT_LOOKUPS.accountDay} new codes in 24 hours. What the instance holds can still be read.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (
        accountMinute >= PRODUCT_LOOKUPS.accountMinute ||
        instanceMinute >= PRODUCT_LOOKUPS.instanceMinute
      ) {
        throw new HttpException(
          {
            error: 'PRODUCT_LOOKUPS_BUSY',
            message: 'Too many new codes at once: try in a minute.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await tx.productLookup.create({ data: { userId, at: now } });
    });
  }
}
