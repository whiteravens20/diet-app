// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * USDA importer background-job runner.
 *
 * Mirrors {@link SeedRunner}'s single-flight pattern. Bulk-imports from the
 * FDC API can take minutes (Foundation: seconds; Foundation + SR Legacy:
 * several minutes throttled at 200/page + 250 ms inter-page), so the HTTP
 * handler kicks the job off and the admin panel polls
 * `GET /api/admin/db/import-usda/status` for progress.
 *
 * Where the job stands is kept in the database (`JobState`), so every process
 * of the API answers the same and one of them runs it. A run whose process
 * died is seen as failed and can be started again: the importer is idempotent
 * (output file is byte-stable for identical input) and the panel re-derives
 * "import done" from the file's presence on disk.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobState } from '../job-state.js';
import { resolveDataDir } from '../seed/data-hash.js';
import { ImportFailure, runImport, type ImportFailureReason, type ImportProgress, type ImportResult } from './importer.js';

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
  /** Foods left out because their record is incomplete; `result.refusals` names them. */
  refused: number;
  /** Comma-separated FDC dataTypes for this run. */
  dataTypes: string | null;
  /** True if the API key was DEMO_KEY (panel surfaces a hint). */
  demoKey: boolean;
  /** Populated on `done`. */
  result: ImportResult | null;
  /** Populated on `error`: what went wrong, for the log and as detail on the panel. */
  error: string | null;
  /** Populated on `error`: why, so that the panel can say what to do about it. */
  errorReason: ImportFailureReason | null;
  /** How long the source asks to wait before the next try, in seconds, when it said so. */
  retryAfterSeconds: number | null;
}

@Injectable()
export class UsdaImportRunner {
  private readonly logger = new Logger(UsdaImportRunner.name);
  private readonly job: JobState<ImportRunnerState>;

  /** Where the run stands as this process knows it. What every process is told is `getState`. */
  private get state(): ImportRunnerState {
    return this.job.local;
  }

  private set state(next: ImportRunnerState) {
    this.job.local = next;
  }

  constructor(
    private readonly config: ConfigService<Env, true>,
    prisma: PrismaService,
  ) {
    this.job = new JobState(prisma, 'food import', UsdaImportRunner.idle);
  }

  getState(): Promise<ImportRunnerState> {
    return this.job.read();
  }

  /**
   * Kick off an import. Returns false if a job is already in flight so the
   * caller can answer 409. `dataTypesOverride` lets the admin panel pick
   * `Foundation` vs `Foundation,SR Legacy` without editing `.env`.
   */
  async start(dataTypesOverride?: string): Promise<boolean> {
    if (this.state.status === 'running') return false;

    const apiKey = this.config.get('FDC_API_KEY', { infer: true }) ?? 'DEMO_KEY';
    const dataTypes = (
      dataTypesOverride ??
      this.config.get('FDC_DATA_TYPES', { infer: true }) ??
      'Foundation'
    ).trim();

    this.state = {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      page: null,
      totalPages: null,
      kept: 0,
      skipped: 0,
      excluded: 0,
      refused: 0,
      dataTypes,
      demoKey: apiKey === 'DEMO_KEY',
      result: null,
      error: null,
      errorReason: null,
      retryAfterSeconds: null,
    };

    if (!(await this.job.begin())) return false;
    void this.job.during(() => this.run(apiKey, dataTypes));
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
        refused: p.refused,
      };
    };

    try {
      const outDir = resolveDataDir();
      this.logger.log(`USDA import starting: dataTypes=${dataTypes} outDir=${outDir}`);
      const result = await runImport({ apiKey, dataTypes, outDir, onProgress });
      this.logger.log(
        `USDA import done: kept=${result.kept} refused=${result.refused} skipped=${result.skipped} excluded=${result.excluded}`,
      );
      this.state = {
        ...this.state,
        status: 'done',
        finishedAt: new Date().toISOString(),
        kept: result.kept,
        skipped: result.skipped,
        excluded: result.excluded,
        refused: result.refused,
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
        errorReason: err instanceof ImportFailure ? err.reason : 'failed',
        retryAfterSeconds: err instanceof ImportFailure ? (err.retryAfterSeconds ?? null) : null,
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
      refused: 0,
      dataTypes: null,
      demoKey: false,
      result: null,
      error: null,
      errorReason: null,
      retryAfterSeconds: null,
    };
  }
}
