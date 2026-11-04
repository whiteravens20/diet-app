// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A stand-in for Open Food Facts: the answers about one product a test chooses,
 * and the export it chooses, packed as the real one is. The application is
 * pointed at it by its settings, so its own client and its own import run.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

/** What is said of a product: fields as the real answer words them. */
export type ProductAnswer = Record<string, unknown>;

export interface FakeOpenFoodFacts {
  readonly url: string;
  readonly exportUrl: string;
  /** The requests about a product, in order: which code, with which headers. */
  readonly asked: { code: string; headers: IncomingHttpHeaders }[];
  /** How many times the export was read. */
  exportReads: number;
  /** What is said of a code; a number answers with that status and nothing else. */
  answers: Map<string, ProductAnswer | number>;
  /** The bytes of the export, as they are sent. */
  exportBytes: Buffer;
  close(): Promise<void>;
}

/** The columns a real export has, in an order of its own: more than the import reads, as there. */
export const EXPORT_COLUMNS = [
  'code',
  'url',
  'last_modified_t',
  'product_name',
  'generic_name',
  'quantity',
  'brands',
  'countries_tags',
  'serving_size',
  'serving_quantity',
  'product_quantity',
  'unique_scans_n',
  'energy-kj_100g',
  'energy-kcal_100g',
  'energy_100g',
  'fat_100g',
  'saturated-fat_100g',
  'carbohydrates_100g',
  'sugars_100g',
  'polyols_100g',
  'fiber_100g',
  'proteins_100g',
  'salt_100g',
  'sodium_100g',
  'alcohol_100g',
];

/** One product of a test's export: only what the test says something of. */
export type ExportRow = Partial<Record<string, string | number>>;

/** The text of an export. */
export function exportText(rows: ExportRow[], columns: string[] = EXPORT_COLUMNS): string {
  const line = (row: ExportRow): string =>
    columns.map((column) => String(row[column] ?? '')).join('\t');
  return `${columns.join('\t')}\n${rows.map(line).join('\n')}\n`;
}

/** An export as it lies on the server. */
export const packedExport = (rows: ExportRow[], columns?: string[]): Buffer =>
  gzipSync(exportText(rows, columns));

export async function startFakeOpenFoodFacts(): Promise<FakeOpenFoodFacts> {
  const fake: Omit<FakeOpenFoodFacts, 'url' | 'exportUrl' | 'close'> = {
    asked: [],
    exportReads: 0,
    answers: new Map(),
    exportBytes: packedExport([]),
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/moved/export.csv.gz') {
      res.writeHead(302, { Location: '/export.csv.gz' }).end();
      return;
    }
    if (path === '/export.csv.gz') {
      fake.exportReads += 1;
      res.writeHead(200, { 'Content-Type': 'application/gzip' }).end(fake.exportBytes);
      return;
    }
    const product = /^\/api\/v2\/product\/(\d+)\.json$/.exec(path);
    if (!product) {
      res.writeHead(500).end();
      return;
    }
    const code = product[1]!;
    fake.asked.push({ code, headers: req.headers });
    const said = fake.answers.get(code);
    if (typeof said === 'number') {
      res.writeHead(said).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (said === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ code, status: 0, status_verbose: 'product not found' }));
      return;
    }
    res.end(JSON.stringify({ code, status: 1, status_verbose: 'product found', product: said }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return Object.assign(fake, {
    url,
    // The real export answers with a redirect to where it lies.
    exportUrl: `${url}/moved/export.csv.gz`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  });
}
