// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

/** How often a job that runs writes down where it stands. */
const WRITTEN_EVERY_MS = 2_000;
/** A job that says it runs and has written nothing for this long stopped with its process. */
const SILENT_AFTER_MS = 45_000;

/** What every job of the administrator's says of itself. */
interface Standing {
  status: string;
  finishedAt: string | null;
  error: string | null;
}

/**
 * Where one background job of the administrator's stands, kept in the
 * database: whichever process of the API is asked answers the same, and of
 * several processes one runs the job.
 *
 * The process that runs the job keeps the state in memory as before and
 * writes it down every two seconds, which is also how the others know that
 * it is alive. A job whose process died is seen as failed after three
 * quarters of a minute, and can be started again.
 */
export class JobState<T extends Standing> {
  private current: T;
  private writing: ReturnType<typeof setInterval> | null = null;
  private stop = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly name: string,
    private readonly idle: () => T,
  ) {
    this.current = idle();
  }

  /** Where the job stands as this process knows it: what the job itself goes by while it runs here. */
  get local(): T {
    return this.current;
  }

  set local(next: T) {
    this.current = next;
  }

  /** Whether somebody asked the job that runs here to stop, in whichever process they asked. */
  get stopRequested(): boolean {
    return this.stop;
  }

  /** Where the job stands, for whoever asks. The process that runs it answers with what it has at this moment. */
  async read(): Promise<T> {
    if (this.writing) return this.current;
    // Silence is measured by the database's clock, the one the heartbeat is written by.
    const [row] = await this.prisma.$queryRaw<{ state: T; heartbeatAt: Date; silent: boolean }[]>`
      SELECT "state", "heartbeatAt", "heartbeatAt" < NOW() - make_interval(secs => ${SILENT_AFTER_MS / 1000}) AS "silent"
      FROM "JobState" WHERE "name" = ${this.name}`;
    if (!row) return this.idle();
    if (row.state.status !== 'running' || !row.silent) return row.state;
    return { ...row.state, status: 'error', finishedAt: row.heartbeatAt.toISOString(), error: 'The run stopped with the process that ran it. Start it again.' };
  }

  /**
   * Begin the job here with the state this process has set, unless the job
   * runs somewhere. False when it does: the state here is then nobody's, and
   * goes back to idle.
   */
  async begin(): Promise<boolean> {
    const silent = SILENT_AFTER_MS / 1000;
    const begun = await this.prisma.$executeRaw`
      INSERT INTO "JobState" ("name", "state", "heartbeatAt", "stopRequested")
      VALUES (${this.name}, ${JSON.stringify(this.current)}::jsonb, NOW(), false)
      ON CONFLICT ("name") DO UPDATE SET "state" = EXCLUDED."state", "heartbeatAt" = NOW(), "stopRequested" = false
      WHERE "JobState"."state"->>'status' <> 'running' OR "JobState"."heartbeatAt" < NOW() - make_interval(secs => ${silent})`;
    if (begun !== 1) {
      this.current = this.idle();
      return false;
    }
    this.stop = false;
    this.writing = setInterval(() => void this.write().catch(() => undefined), WRITTEN_EVERY_MS);
    this.writing.unref();
    return true;
  }

  /** Run the job's work, and write its last state when it is over, however it ended. */
  async during(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } finally {
      if (this.writing) clearInterval(this.writing);
      this.writing = null;
      await this.write().catch(() => undefined);
    }
  }

  /** Write down a state that no run led to: a start that was refused for a reason the panel should show. */
  async settle(): Promise<void> {
    const state = this.current as unknown as Prisma.InputJsonValue;
    await this.prisma.jobState.upsert({ where: { name: this.name }, create: { name: this.name, state, heartbeatAt: new Date() }, update: { state, heartbeatAt: new Date(), stopRequested: false } });
  }

  /** Ask the job to stop, wherever it runs. False when it does not run. */
  async requestStop(): Promise<boolean> {
    const asked = await this.prisma.$executeRaw`UPDATE "JobState" SET "stopRequested" = true WHERE "name" = ${this.name} AND "state"->>'status' = 'running'`;
    if (asked === 1 && this.writing) this.stop = true;
    return asked === 1;
  }

  /** Write the state down, say that the process is alive, and hear whether a stop was asked for. */
  private async write(): Promise<void> {
    const [row] = await this.prisma.$queryRaw<{ stopRequested: boolean }[]>`
      UPDATE "JobState" SET "state" = ${JSON.stringify(this.current)}::jsonb, "heartbeatAt" = NOW()
      WHERE "name" = ${this.name} RETURNING "stopRequested"`;
    if (row?.stopRequested) this.stop = true;
  }
}
