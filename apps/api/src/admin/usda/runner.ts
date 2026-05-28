/**
 * USDA importer background-job runner (F16 extension).
 *
 * Mirrors {@link SeedRunner}'s single-flight pattern. Bulk-imports from the
 * FDC API can take minutes (Foundation: seconds; Foundation + SR Legacy:
 * several minutes throttled at 200/page + 250 ms inter-page), so the HTTP
 * handler kicks the job off and the admin panel polls
 * `GET /api/admin/db/import-usda/status` for progress.
 *
 * State is in-process; an API restart drops it. That's fine — the importer
 * is idempotent (output file is byte-stable for identical input) and the
 * panel re-derives "import done" from the file's presence on disk.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { resolveDataDir } from '../seed/data-hash.js';
import { runImport, type ImportProgress, type ImportResult } from './importer.js';

export type ImportStatus = 'idle' | 'running' | 'done' | 'error';

export interface ImportRunnerState {
  status: ImportStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Page progress (`page` and `totalPages` populated while running). */
  page: number | null;
  totalPages: number | null;
  kept: number;
  skipped: number;
  excluded: number;
  /** Comma-separated FDC dataTypes for this run. */
  dataTypes: string | null;
  /** True if the API key was DEMO_KEY (panel surfaces a hint). */
  demoKey: boolean;
  /** Populated on `done`. */
  result: ImportResult | null;
  error: string | null;
}

@Injectable()
export class UsdaImportRunner {
  private readonly logger = new Logger(UsdaImportRunner.name);
  private state: ImportRunnerState = UsdaImportRunner.idle();

  constructor(private readonly config: ConfigService<Env, true>) {}

  getState(): ImportRunnerState {
    return this.state;
  }

  /**
   * Kick off an import. Returns false if a job is already in flight so the
   * caller can answer 409. `dataTypesOverride` lets the admin panel pick
   * `Foundation` vs `Foundation,SR Legacy` without editing `.env`.
   */
  start(dataTypesOverride?: string): boolean {
    if (this.state.status === 'running') return false;

    const apiKey = process.env.FDC_API_KEY ?? 'DEMO_KEY';
    const dataTypes = (dataTypesOverride ?? process.env.FDC_DATA_TYPES ?? 'Foundation').trim();

    this.state = {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      page: null,
      totalPages: null,
      kept: 0,
      skipped: 0,
      excluded: 0,
      dataTypes,
      demoKey: apiKey === 'DEMO_KEY',
      result: null,
      error: null,
    };

    void this.run(apiKey, dataTypes);
    return true;
  }

  private async run(apiKey: string, dataTypes: string): Promise<void> {
    const onProgress = (p: ImportProgress): void => {
      this.state = {
        ...this.state,
        page: p.page,
        totalPages: p.totalPages,
        kept: p.kept,
        skipped: p.skipped,
        excluded: p.excluded,
      };
    };

    try {
      const outDir = resolveDataDir();
      this.logger.log(`USDA import starting: dataTypes=${dataTypes} outDir=${outDir}`);
      const result = await runImport({ apiKey, dataTypes, outDir, onProgress });
      this.logger.log(
        `USDA import done: kept=${result.kept} skipped=${result.skipped} excluded=${result.excluded}`,
      );
      this.state = {
        ...this.state,
        status: 'done',
        finishedAt: new Date().toISOString(),
        kept: result.kept,
        skipped: result.skipped,
        excluded: result.excluded,
        totalPages: result.totalPages,
        result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`USDA import failed: ${message}`);
      this.state = {
        ...this.state,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: message,
      };
    }
  }

  private static idle(): ImportRunnerState {
    return {
      status: 'idle',
      startedAt: null,
      finishedAt: null,
      page: null,
      totalPages: null,
      kept: 0,
      skipped: 0,
      excluded: 0,
      dataTypes: null,
      demoKey: false,
      result: null,
      error: null,
    };
  }
}
