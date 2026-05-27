/**
 * In-memory job runner for the admin DB updater (F16).
 *
 * The seed/update workload takes minutes — far longer than any sensible HTTP
 * proxy idle timeout — so we run it detached in the background and let the
 * admin panel poll {@link SeedRunner.state} every second. Single-flight: a
 * second POST while a job is running returns 409.
 *
 * State lives in-process. An API restart drops it; the next status poll just
 * sees `idle` again. That's acceptable because the job itself is idempotent
 * (the seeder upserts and the prune step is safe to re-run) and the admin
 * panel re-derives "update available" from the on-disk hash, not the runner.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
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
  private state: RunnerState = SeedRunner.idle();

  constructor(private readonly prisma: PrismaService) {}

  getState(): RunnerState {
    return this.state;
  }

  /**
   * Kick off the updater unless one is already running. Returns false if a
   * job is already in flight so the caller can answer 409. The promise we
   * await internally is detached — this method resolves immediately.
   */
  start(): boolean {
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

    void this.run();
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
