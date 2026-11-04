// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createGunzip } from 'node:zlib';
import { pipeline, Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PACKAGE_VERSION } from '../app-config/package-version.js';
import { outboundRequest, OutboundRequestError } from '../common/outbound-http.js';
import type { Env } from '../config/env.js';
import type { LabelReading } from '../engine/index.js';
import type { ProductFields } from './product-row.js';

/** Where the project's own page says who runs what asks, on an instance whose operator published no address. */
const PROJECT_PAGE = 'https://github.com/whiteravens20/diet-app';

/** How long one product may take to answer: somebody stands waiting for it. */
const ANSWER_MS = 8_000;
/** The largest answer about one product that is read. */
const MOST_ANSWER_BYTES = 512 * 1024;
/** How long reading the export may take in all. */
const LONGEST_EXPORT_MS = 100 * 60_000;
/**
 * The most text the export may unpack to, in bytes: about four times what it
 * held in November 2026, and a bound on what a broken or false file can make
 * the worker read.
 */
const MOST_EXPORT_TEXT = 60_000_000_000;

/** What is asked of a product: only what the instance keeps. */
const FIELDS = [
  'code',
  'product_name',
  'brands',
  'quantity',
  'product_quantity',
  'serving_quantity',
  'nutrition_data_per',
  'nutriments',
  'last_modified_t',
  'unique_scans_n',
].join(',');

/** Why Open Food Facts gave no answer about a code: that says nothing of whether it knows it. */
export class ProductSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductSourceError';
  }
}

/** The export could not be read to its end. */
export class ExportReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportReadError';
  }
}

/**
 * A number as it stands in a column of the export or a field of an answer;
 * null for nothing, and for anything else than a plain number.
 */
export function figureOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** What a product's label says in an answer of Open Food Facts. */
function readingOf(nutriments: Record<string, unknown>): LabelReading {
  const figure = (name: string): number | null => figureOf(nutriments[`${name}_100g`]);
  return {
    kcal: figure('energy-kcal'),
    kj: figure('energy-kj') ?? figure('energy'),
    protein: figure('proteins'),
    fat: figure('fat'),
    carbs: figure('carbohydrates'),
    fiber: figure('fiber'),
    sugars: figure('sugars'),
    salt: figure('salt'),
    sodium: figure('sodium'),
    saturatedFat: figure('saturated-fat'),
    alcohol: figure('alcohol'),
    polyols: figure('polyols'),
  };
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Open Food Facts, as this instance asks it: under the instance's own name,
 * which says who asks. Its users' addresses and accounts never go with a
 * request.
 */
@Injectable()
export class OpenFoodFacts {
  private readonly userAgent: string;
  private readonly productsAt: string;
  private readonly exportAt: string;

  constructor(config: ConfigService<Env, true>) {
    const contact = config.get('OPERATOR_CONTACT', { infer: true }) ?? PROJECT_PAGE;
    this.userAgent = `DietApp/${PACKAGE_VERSION} (${contact})`;
    this.productsAt = config.get('OPEN_FOOD_FACTS_URL', { infer: true });
    this.exportAt = config.get('OPEN_FOOD_FACTS_EXPORT_URL', { infer: true });
  }

  /** What Open Food Facts says of a code, or null where it knows none. */
  async product(code: string): Promise<ProductFields | null> {
    const address = new URL(`/api/v2/product/${code}.json`, this.productsAt);
    address.searchParams.set('fields', FIELDS);
    let answer;
    try {
      answer = await outboundRequest(address.toString(), {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        timeoutMs: ANSWER_MS,
        maxBytes: MOST_ANSWER_BYTES,
        // The address is the operator's setting, and may be a mirror on their own network.
        publicOnly: false,
      });
    } catch (err) {
      if (err instanceof OutboundRequestError) throw new ProductSourceError(err.message);
      throw err;
    }
    if (answer.status === 404) return null;
    if (answer.status !== 200) throw new ProductSourceError(`It answered ${answer.status}.`);
    let body: unknown;
    try {
      body = JSON.parse(answer.text);
    } catch {
      throw new ProductSourceError('Its answer is no JSON.');
    }
    const { status, product } = (body ?? {}) as { status?: unknown; product?: unknown };
    if (status !== 1 || typeof product !== 'object' || product === null) return null;
    const fields = product as Record<string, unknown>;
    const nutriments =
      typeof fields.nutriments === 'object' && fields.nutriments !== null
        ? (fields.nutriments as Record<string, unknown>)
        : {};
    return {
      code,
      name: textOf(fields.product_name),
      brands: textOf(fields.brands),
      quantity: textOf(fields.quantity),
      packAmount: figureOf(fields.product_quantity),
      servingAmount: figureOf(fields.serving_quantity),
      per:
        fields.nutrition_data_per === '100ml'
          ? 'ml'
          : fields.nutrition_data_per === '100g'
            ? 'g'
            : null,
      reading: readingOf(nutriments),
      changedAt: figureOf(fields.last_modified_t),
      scans: figureOf(fields.unique_scans_n),
    };
  }

  /**
   * The text of the export, unpacked as it comes and kept nowhere. It ends in
   * an error where the file ends before its packing says it does, so that
   * half a file is never taken for a whole one.
   */
  async *exportText(): AsyncGenerator<Buffer> {
    let answer: Response;
    try {
      answer = await fetch(this.exportAt, {
        headers: { 'User-Agent': this.userAgent },
        redirect: 'follow',
        signal: AbortSignal.timeout(LONGEST_EXPORT_MS),
      });
    } catch (err) {
      throw new ExportReadError(`It could not be reached: ${(err as Error).message}`);
    }
    if (!answer.ok || !answer.body)
      throw new ExportReadError(`It answered ${answer.status} ${answer.statusText}.`);
    const unpack = createGunzip();
    const body = Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]);
    pipeline(body, unpack, () => undefined);
    let unpacked = 0;
    try {
      for await (const chunk of unpack as AsyncIterable<Buffer>) {
        unpacked += chunk.length;
        if (unpacked > MOST_EXPORT_TEXT)
          throw new ExportReadError(`It unpacks to more than ${MOST_EXPORT_TEXT} bytes.`);
        yield chunk;
      }
    } catch (err) {
      if (err instanceof ExportReadError) throw err;
      throw new ExportReadError(`Reading it stopped: ${(err as Error).message}`);
    } finally {
      body.destroy();
      unpack.destroy();
    }
  }
}
