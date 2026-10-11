// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Job runner for the admin DB updater.
 *
 * The seed/update workload takes minutes — far longer than any sensible HTTP
 * proxy idle timeout — so we run it detached in the background and let the
 * admin panel poll {@link SeedRunner.getState} every second. Single-flight: a
 * second POST while a job is running returns 409.
 *
 * Where the job stands is kept in the database (`JobState`), so every process
 * of the API answers the same and one of them runs it. A job whose process
 * died is seen as failed and can be started again: it is idempotent (the
 * seeder upserts and the prune step is safe to re-run), and the admin panel
 * re-derives "update available" from the on-disk hash, not from the runner.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobState } from '../job-state.js';
import { resolveDataDir } from './data-hash.js';
import { updateDatabase, type SeedProgress, type UpdateResult } from './seeder.js';

export type RunnerStatus = 'idle' | 'running' | 'done' | 'error';

export interface RunnerState {
  status: RunnerStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Latest stage the seeder reported (`recipes`, `ingredients`, etc.). */
  stage: string | null;
  /** Determinate progress when the current stage knows its total. */
  current: number | null;
  total: number | null;
  /** Populated on `done`. Same shape as the old synchronous response. */
  result: {
    deletedRecipes: number;
    deletedIngredients: number;
    retiredRecipes: number;
    retiredIngredients: number;
    repairedProfiles: number;
    counts: { ingredients: number; recipes: number; substitutions: number };
    hash: string;
    seededAt: string;
  } | null;
  /** Populated on `error`. */
  error: string | null;
}

@Injectable()
export class SeedRunner {
  private readonly logger = new Logger(SeedRunner.name);
  private readonly job: JobState<RunnerState>;

  /** Where the run stands as this process knows it. What every process is told is `getState`. */
  private get state(): RunnerState {
    return this.job.local;
  }

  private set state(next: RunnerState) {
    this.job.local = next;
  }

  constructor(private readonly prisma: PrismaService) {
    this.job = new JobState(prisma, 'catalogue update', SeedRunner.idle);
  }

  getState(): Promise<RunnerState> {
    return this.job.read();
  }

  /**
   * Kick off the updater unless one is already running. Returns false if a
   * job is already in flight so the caller can answer 409. The promise we
   * await internally is detached — this method resolves immediately.
   */
  async start(): Promise<boolean> {
    if (this.state.status === 'running') return false;

    this.state = {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stage: 'starting',
      current: null,
      total: null,
      result: null,
      error: null,
    };

    if (!(await this.job.begin())) return false;
    void this.job.during(() => this.run());
    return true;
  }

  private async run(): Promise<void> {
    const onProgress = (p: SeedProgress): void => {
      this.state = {
        ...this.state,
        stage: p.stage,
        current: p.current ?? null,
        total: p.total ?? null,
      };
    };

    try {
      const result: UpdateResult = await updateDatabase(
        this.prisma,
        resolveDataDir(),
        (msg) => this.logger.log(msg),
        onProgress,
      );
      this.state = {
        ...this.state,
        status: 'done',
        finishedAt: new Date().toISOString(),
        stage: 'done',
        current: null,
        total: null,
        result: {
          deletedRecipes: result.deletedRecipes,
          deletedIngredients: result.deletedIngredients,
          retiredRecipes: result.retiredRecipes,
          retiredIngredients: result.retiredIngredients,
          repairedProfiles: result.repairedProfiles,
          counts: {
            ingredients: result.ingredients,
            recipes: result.recipes,
            substitutions: result.substitutions,
          },
          hash: result.hash,
          seededAt: result.seededAt.toISOString(),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Seed update failed: ${message}`);
      this.state = {
        ...this.state,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: message,
      };
    }
  }

  private static idle(): RunnerState {
    return {
      status: 'idle',
      startedAt: null,
      finishedAt: null,
      stage: null,
      current: null,
      total: null,
      result: null,
      error: null,
    };
  }
}
