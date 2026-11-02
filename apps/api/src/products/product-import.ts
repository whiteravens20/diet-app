// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { AdminProducts, ProductImportFailure, ProductImportState } from '@diet-app/shared';
import { JobState } from '../admin/job-state.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExportReadError, figureOf, OpenFoodFacts } from './open-food-facts.js';
import { productRowOf, type ProductRow } from './product-row.js';
import { LOOKED_UP_KEPT_DAYS, PRODUCT_MEMORY_DAYS } from './limits.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Where a run asked for by the administrator waits for the worker. */
const ASKED = 'product import asked';

/** When the worker begins a run it is not asked for: from this hour by the server's clock, and before that one. */
const NIGHT = { from: 2, until: 5 };
/** How long after the last start a weekly run is due, in hours: under a week, so that it falls in the same night. */
const WEEKLY_AFTER_HOURS = 6.5 * 24;
/** How long after a start that failed, or read other countries, the next night's run may begin. */
const AGAIN_AFTER_HOURS = 20;
/** How long after a start the administrator may ask for another, for the same countries. */
const ASK_AGAIN_AFTER_HOURS = 24;

/**
 * How many products are written at a time. The database's client keeps its last
 * hundred statements in memory with their values, whatever is logged: at this
 * size, about 90 KB each, that stays under 10 MB, however long the run.
 */
const BATCH = 250;
/** How long the whole run may take: the export and the writing together. */
const LONGEST_RUN_MS = 2 * HOUR_MS;
/** How long a line of the export may be, in bytes: 88,449 at most in November 2026. Longer is no product. */
const LONGEST_LINE = 4 * 1024 * 1024;

/** The columns the import reads. Without one of them the export is not what this version knows. */
const COLUMNS = [
  'code',
  'product_name',
  'brands',
  'quantity',
  'product_quantity',
  'serving_quantity',
  'countries_tags',
  'last_modified_t',
  'unique_scans_n',
  'energy-kcal_100g',
  'energy-kj_100g',
  'proteins_100g',
  'fat_100g',
  'carbohydrates_100g',
  'fiber_100g',
  'sugars_100g',
  'salt_100g',
  'sodium_100g',
  'saturated-fat_100g',
  'alcohol_100g',
  'polyols_100g',
] as const;
type Column = (typeof COLUMNS)[number];

/** Why a run stopped, as the panel says it. */
class ImportFailure extends Error {
  constructor(
    readonly reason: ProductImportFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ImportFailure';
  }
}

/** A text that comes in pieces, a line at a time; a line too long to be a product is dropped whole. */
class LinesOfText {
  private rest: Buffer[] = [];
  private restBytes = 0;

  constructor(private readonly each: (line: Buffer) => void) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, end);
      if (this.restBytes === 0) {
        this.each(piece);
      } else {
        if (this.restBytes + piece.length <= LONGEST_LINE)
          this.each(Buffer.concat([...this.rest, piece]));
        this.rest = [];
        this.restBytes = 0;
      }
      start = end + 1;
    }
    if (start < chunk.length) {
      const piece = chunk.subarray(start);
      this.restBytes += piece.length;
      // Of a line too long nothing is kept: only that it was.
      this.rest = this.restBytes <= LONGEST_LINE ? [...this.rest, piece] : [];
    }
  }
}

/** Where each column stands in a line of this export. */
function placesIn(header: string): Record<Column, number> & { count: number } {
  const names = header.split('\t');
  const places = { count: names.length } as Record<Column, number> & { count: number };
  const missing: string[] = [];
  for (const column of COLUMNS) {
    const place = names.indexOf(column);
    if (place === -1) missing.push(column);
    places[column] = place;
  }
  if (missing.length > 0)
    throw new ImportFailure('format', `The export has no column ${missing.join(', ')}.`);
  return places;
}

/** The two sides of a merge name the same columns: every one the import writes. */
const WRITTEN = [
  'name',
  'brand',
  'searchText',
  'pack',
  'unit',
  'packAmount',
  'servingAmount',
  'calories',
  'protein',
  'fat',
  'carbs',
  'fiber',
  'sugars',
  'salt',
  'saturatedFat',
  'energyWorkedOut',
  'doubtful',
  'changedAt',
  'popularity',
] as const;

const quoted = (column: string): string => `"${column}"`;

/**
 * The weekly import of the countries the operator names. It streams Open Food
 * Facts' export, keeps nothing of it on disk, and writes into a table of its
 * own transaction: the instance's products change at once at the end, or not
 * at all. A country is only a word to look for in the export's column of
 * countries; nothing here knows one from another.
 */
@Injectable()
export class ProductImport {
  private readonly logger = new Logger(ProductImport.name);
  private readonly job: JobState<ProductImportState>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly source: OpenFoodFacts,
  ) {
    this.job = new JobState(prisma, 'product import', ProductImport.idle);
  }

  private static idle(this: void): ProductImportState {
    return {
      status: 'idle',
      startedAt: null,
      finishedAt: null,
      error: null,
      reason: null,
      countries: [],
      perCountry: {},
      read: 0,
      leftOut: { code: 0, name: 0, figures: 0 },
      added: 0,
      changed: 0,
      removed: 0,
    };
  }

  private get countries(): string[] {
    return this.config.get('OPEN_FOOD_FACTS_COUNTRIES', { infer: true });
  }

  /** What the instance holds of products and how it gets them, for its administrator. */
  async overview(now = new Date()): Promise<AdminProducts> {
    const [state, asked, imported, lookedUp, unknownCodes, lookupsToday] = await Promise.all([
      this.job.read(),
      this.prisma.jobState.findUnique({ where: { name: ASKED } }),
      this.prisma.product.count({ where: { origin: 'imported' } }),
      this.prisma.product.count({ where: { origin: 'looked_up' } }),
      this.prisma.productCodeUnknown.count(),
      this.prisma.productLookup.count({ where: { at: { gt: new Date(now.getTime() - DAY_MS) } } }),
    ]);
    return {
      lookups: this.config.get('OPEN_FOOD_FACTS_LOOKUPS', { infer: true }),
      countries: this.countries,
      held: { imported, lookedUp, unknownCodes },
      lookupsToday,
      import: state,
      askedAt: asked?.heartbeatAt.toISOString() ?? null,
      askAgainAt: this.askAgainAt(state, now)?.toISOString() ?? null,
    };
  }

  /**
   * When a run can be asked for again; null when it can be now. What waits is
   * a second download of the export: other countries than the last run read can
   * be read at once, and so can a run that failed before it read anything.
   */
  private askAgainAt(state: ProductImportState, now: Date): Date | null {
    if (!state.startedAt || !this.sameCountries(state)) return null;
    if (state.status === 'error' && state.read === 0) return null;
    const at = new Date(new Date(state.startedAt).getTime() + ASK_AGAIN_AFTER_HOURS * HOUR_MS);
    return at > now ? at : null;
  }

  private sameCountries(state: ProductImportState): boolean {
    const named = [...this.countries].sort().join();
    return [...state.countries].sort().join() === named;
  }

  /**
   * The administrator asks for a run, which the worker begins within a minute.
   * The panel only writes that it was asked: the worker is the one process
   * that reads the export, so that no request of the API waits behind it.
   */
  async ask(now = new Date()): Promise<void> {
    if (this.countries.length === 0) {
      throw new ConflictException({
        error: 'PRODUCT_IMPORT_NO_COUNTRIES',
        message: 'No country is named: set OPEN_FOOD_FACTS_COUNTRIES and restart the instance.',
      });
    }
    const state = await this.job.read();
    if (state.status === 'running') {
      throw new ConflictException({
        error: 'PRODUCT_IMPORT_RUNNING',
        message: 'An import is running.',
      });
    }
    if (this.askAgainAt(state, now)) {
      throw new ConflictException({
        error: 'PRODUCT_IMPORT_TOO_SOON',
        message: `The last import of these countries began less than ${ASK_AGAIN_AFTER_HOURS} hours ago.`,
      });
    }
    await this.prisma.jobState.upsert({
      where: { name: ASKED },
      create: { name: ASKED, state: {}, heartbeatAt: now },
      update: { heartbeatAt: now },
    });
  }

  /**
   * Whether a run is due now: one the administrator asked for, or at night one
   * that has not been read for a week, that failed, or that read other
   * countries than are named now. Run by the worker once a minute: nothing is
   * read at all on an instance that names no country.
   */
  async due(now = new Date()): Promise<boolean> {
    if (this.countries.length === 0) return false;
    const asked = await this.prisma.jobState.findUnique({ where: { name: ASKED } });
    if (asked) return true;
    const hour = now.getHours();
    if (hour < NIGHT.from || hour >= NIGHT.until) return false;
    const state = await this.job.read();
    if (!state.startedAt) return true;
    const hours = (now.getTime() - new Date(state.startedAt).getTime()) / HOUR_MS;
    const failed = state.status === 'error' || !this.sameCountries(state);
    return hours >= (failed ? AGAIN_AFTER_HOURS : WEEKLY_AFTER_HOURS);
  }

  /**
   * Remove what no longer counts: lookups older than the limits look, codes that
   * may be asked again, and products no import brings that nobody asked for in
   * a long while, which an entry of a diary does without.
   */
  async prune(now = new Date()): Promise<number> {
    const [lookups, codes, products] = await this.prisma.$transaction([
      this.prisma.productLookup.deleteMany({
        where: { at: { lt: new Date(now.getTime() - DAY_MS) } },
      }),
      this.prisma.productCodeUnknown.deleteMany({
        where: { askedAt: { lt: new Date(now.getTime() - PRODUCT_MEMORY_DAYS.unknown * DAY_MS) } },
      }),
      this.prisma.product.deleteMany({
        where: {
          origin: 'looked_up',
          readAt: { lt: new Date(now.getTime() - LOOKED_UP_KEPT_DAYS * DAY_MS) },
        },
      }),
    ]);
    return lookups.count + codes.count + products.count;
  }

  /** A run, where one is due and none is running anywhere. */
  async runIfDue(now = new Date()): Promise<void> {
    if (!(await this.due(now))) return;
    await this.run(now);
  }

  /** Read the export and bring the instance's products up to it. False where a run is going on already. */
  async run(now = new Date()): Promise<boolean> {
    const countries = this.countries;
    if (countries.length === 0) return false;
    this.job.local = {
      ...ProductImport.idle(),
      status: 'running',
      startedAt: now.toISOString(),
      countries,
      perCountry: Object.fromEntries(countries.map((country) => [country, 0])),
    };
    const previous = await this.job.read();
    if (!(await this.job.begin())) return false;
    await this.prisma.jobState.deleteMany({ where: { name: ASKED } });
    await this.job.during(async () => {
      try {
        await this.importCountries(countries, previous);
        this.job.local = {
          ...this.job.local,
          status: 'done',
          finishedAt: new Date().toISOString(),
        };
        const { added, changed, removed, read } = this.job.local;
        this.logger.log(
          `Products imported from ${read} rows of the export: ${added} added, ${changed} changed, ${removed} removed.`,
        );
      } catch (err) {
        const known = err instanceof ImportFailure || err instanceof ExportReadError;
        this.job.local = {
          ...this.job.local,
          status: 'error',
          finishedAt: new Date().toISOString(),
          error: (err as Error).message,
          reason:
            err instanceof ImportFailure
              ? err.reason
              : err instanceof ExportReadError
                ? 'source'
                : null,
        };
        this.logger.error(`The import of products failed: ${(err as Error).message}`);
        if (!known) throw err;
      }
    });
    return true;
  }

  private async importCountries(countries: string[], previous: ProductImportState): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE product_import (
            "code" text PRIMARY KEY,
            "name" text NOT NULL,
            "brand" text,
            "searchText" text NOT NULL,
            "pack" text,
            "unit" "Unit" NOT NULL,
            "packAmount" double precision,
            "servingAmount" double precision,
            "calories" double precision,
            "protein" double precision,
            "fat" double precision,
            "carbs" double precision,
            "fiber" double precision,
            "sugars" double precision,
            "salt" double precision,
            "saturatedFat" double precision,
            "energyWorkedOut" boolean NOT NULL,
            "doubtful" boolean NOT NULL,
            "changedAt" timestamp(3),
            "popularity" integer NOT NULL
          ) ON COMMIT DROP`);
        const kept = await this.readExport(countries, (batch) => this.keep(tx, batch));
        if (kept === 0) {
          throw new ImportFailure(
            'nothing',
            `The export holds no usable product of ${countries.join(', ')}.`,
          );
        }
        const held = await tx.product.count({ where: { origin: 'imported' } });
        if (kept < held / 2 && previous.countries.join() === countries.join()) {
          throw new ImportFailure(
            'shrunk',
            `The export brings ${kept} products of the ${held} the instance holds: nothing was changed.`,
          );
        }
        await this.merge(tx);
      },
      { maxWait: 10_000, timeout: LONGEST_RUN_MS },
    );
  }

  /** Read the export through. What it keeps is handed on in batches; returns how many it kept. */
  private async readExport(
    countries: string[],
    keep: (batch: ProductRow[]) => Promise<void>,
  ): Promise<number> {
    const tags = countries.map((country) => ({
      country,
      tag: `en:${country}`,
      needle: Buffer.from(`en:${country}`),
    }));
    const tally = this.job.local;
    const leftOut = { ...tally.leftOut };
    const perCountry = { ...tally.perCountry };
    let places: ReturnType<typeof placesIn> | null = null;
    let read = 0;
    let kept = 0;
    let batch: ProductRow[] = [];

    const lines = new LinesOfText((line) => {
      if (places === null) {
        places = placesIn(line.toString('utf8').replace(/\r$/, ''));
        return;
      }
      read += 1;
      // Most rows are of another country, and no more than this is asked of them.
      if (!tags.some(({ needle }) => line.includes(needle))) return;
      const cells = line.toString('utf8').split('\t');
      if (cells.length !== places.count) return;
      const named = cells[places.countries_tags]!.split(',');
      const of = tags.filter(({ tag }) => named.includes(tag));
      if (of.length === 0) return;
      const row = rowOfLine(cells, places);
      if (typeof row === 'string') {
        leftOut[row] += 1;
        return;
      }
      for (const { country } of of) perCountry[country] = (perCountry[country] ?? 0) + 1;
      kept += 1;
      batch.push(row);
    });

    for await (const chunk of this.source.exportText()) {
      lines.push(chunk);
      if (batch.length >= BATCH) {
        const full = batch;
        batch = [];
        await keep(full);
      }
      this.job.local = { ...this.job.local, read, leftOut, perCountry };
    }
    if (places === null) throw new ImportFailure('format', 'The export is empty.');
    if (batch.length > 0) await keep(batch);
    this.job.local = { ...this.job.local, read, leftOut, perCountry };
    return kept;
  }

  /** Write a batch into the table of the run. Of two spellings of one code the one changed last stands. */
  private async keep(tx: Prisma.TransactionClient, batch: ProductRow[]): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO product_import
      SELECT DISTINCT ON ("code") * FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS row (
        "code" text,
        "name" text,
        "brand" text,
        "searchText" text,
        "pack" text,
        "unit" "Unit",
        "packAmount" double precision,
        "servingAmount" double precision,
        "calories" double precision,
        "protein" double precision,
        "fat" double precision,
        "carbs" double precision,
        "fiber" double precision,
        "sugars" double precision,
        "salt" double precision,
        "saturatedFat" double precision,
        "energyWorkedOut" boolean,
        "doubtful" boolean,
        "changedAt" timestamp(3),
        "popularity" integer
      )
      ORDER BY "code", "changedAt" DESC NULLS LAST
      ON CONFLICT ("code") DO UPDATE SET
        "name" = EXCLUDED."name",
        "brand" = EXCLUDED."brand",
        "searchText" = EXCLUDED."searchText",
        "pack" = EXCLUDED."pack",
        "unit" = EXCLUDED."unit",
        "packAmount" = EXCLUDED."packAmount",
        "servingAmount" = EXCLUDED."servingAmount",
        "calories" = EXCLUDED."calories",
        "protein" = EXCLUDED."protein",
        "fat" = EXCLUDED."fat",
        "carbs" = EXCLUDED."carbs",
        "fiber" = EXCLUDED."fiber",
        "sugars" = EXCLUDED."sugars",
        "salt" = EXCLUDED."salt",
        "saturatedFat" = EXCLUDED."saturatedFat",
        "energyWorkedOut" = EXCLUDED."energyWorkedOut",
        "doubtful" = EXCLUDED."doubtful",
        "changedAt" = EXCLUDED."changedAt",
        "popularity" = EXCLUDED."popularity"
      WHERE product_import."changedAt" IS NULL OR EXCLUDED."changedAt" > product_import."changedAt"`;
  }

  /**
   * Bring the instance's products up to what was read: what the export no
   * longer brings goes, what is new comes, and only what differs is written, so
   * that a week's run leaves the rest of the table and its index alone. An
   * entry of a diary keeps its figures, whatever happens to its product.
   */
  private async merge(tx: Prisma.TransactionClient): Promise<void> {
    const removed = await tx.$executeRaw`
      DELETE FROM "Product" AS held
      WHERE held."origin" = 'imported'
        AND NOT EXISTS (SELECT 1 FROM product_import AS row WHERE row."code" = held."code")`;
    const columns = WRITTEN.map(quoted);
    const taken = columns.map((column) => `${column} = EXCLUDED.${column}`).join(', ');
    const [counts] = await tx.$queryRawUnsafe<{ added: bigint; changed: bigint }[]>(`
      WITH written AS (
        INSERT INTO "Product" ("id", "code", "origin", "readAt", ${columns.join(', ')})
        SELECT gen_random_uuid()::text, row."code", 'imported', NOW(), ${columns.map((column) => `row.${column}`).join(', ')}
        FROM product_import AS row
        ON CONFLICT ("code") DO UPDATE SET "origin" = 'imported', "readAt" = NOW(), ${taken}
        WHERE "Product"."origin" <> 'imported'
          OR (${columns.map((column) => `"Product".${column}`).join(', ')}) IS DISTINCT FROM (${columns.map((column) => `EXCLUDED.${column}`).join(', ')})
        RETURNING (xmax = 0) AS fresh
      )
      SELECT COUNT(*) FILTER (WHERE fresh) AS added, COUNT(*) FILTER (WHERE NOT fresh) AS changed FROM written`);
    await tx.$executeRaw`
      DELETE FROM "ProductCodeUnknown" AS unknown
      USING product_import AS row WHERE unknown."code" = row."code"`;
    this.job.local = {
      ...this.job.local,
      removed,
      added: Number(counts?.added ?? 0),
      changed: Number(counts?.changed ?? 0),
    };
  }
}

/** What the import keeps of a line of the export, or why it keeps nothing. */
function rowOfLine(
  cells: string[],
  places: Record<Column, number>,
): ProductRow | 'code' | 'name' | 'figures' {
  const cell = (column: Column): string => cells[places[column]]!;
  const figure = (column: Column): number | null => figureOf(cell(column));
  const row = productRowOf({
    code: cell('code'),
    name: cell('product_name'),
    brands: cell('brands'),
    quantity: cell('quantity'),
    packAmount: figure('product_quantity'),
    servingAmount: figure('serving_quantity'),
    per: null,
    reading: {
      kcal: figure('energy-kcal_100g'),
      kj: figure('energy-kj_100g'),
      protein: figure('proteins_100g'),
      fat: figure('fat_100g'),
      carbs: figure('carbohydrates_100g'),
      fiber: figure('fiber_100g'),
      sugars: figure('sugars_100g'),
      salt: figure('salt_100g'),
      sodium: figure('sodium_100g'),
      saturatedFat: figure('saturated-fat_100g'),
      alcohol: figure('alcohol_100g'),
      polyols: figure('polyols_100g'),
    },
    changedAt: figure('last_modified_t'),
    scans: figure('unique_scans_n'),
  });
  if (typeof row === 'string') return row;
  // A product without figures takes room and offers nothing: a scan of its code looks it up alone.
  return row.calories === null ? 'figures' : row;
}
