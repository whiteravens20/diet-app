// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';
import type { Env } from '../config/env.js';

/** How much of a slow statement is written to the log. */
const MOST_OF_A_STATEMENT = 400;

/** A statement as the log gets it: one line, of a length. It holds placeholders, never the values that went with them. */
export function statementForLog(query: string): string {
  const line = query.replace(/\s+/g, ' ').trim();
  return line.length > MOST_OF_A_STATEMENT ? `${line.slice(0, MOST_OF_A_STATEMENT)}…` : line;
}

/**
 * Prisma client wrapper with Nest lifecycle hooks. Prisma 7 connects through a
 * driver adapter — here the `pg` adapter, pointed at the boot-validated
 * `DATABASE_URL` (resolved via ConfigService, not raw process.env).
 *
 * With `SLOW_QUERY_MS` set, every statement is timed and one that took that
 * long or longer is logged as a warning: the statement with its placeholders,
 * and how long it took. The values of a statement are data of the instance's
 * users and are not logged.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Database');

  constructor(config: ConfigService<Env, true>) {
    const slow = config.get('SLOW_QUERY_MS', { infer: true });
    super({
      adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL', { infer: true }) }),
      ...(slow === undefined ? {} : { log: [{ emit: 'event' as const, level: 'query' as const }] }),
    });
    if (slow !== undefined) {
      this.onStatement((event) => {
        if (event.duration >= slow)
          this.logger.warn(
            `A statement took ${Math.round(event.duration)} ms: ${statementForLog(event.query)}`,
          );
      });
    }
  }

  /**
   * Hear of every statement and how long it took. Nothing is heard unless
   * `SLOW_QUERY_MS` is set, which is what makes the client time its statements.
   */
  onStatement(listener: (event: Prisma.QueryEvent) => void): void {
    (
      this as unknown as { $on(event: 'query', listener: (event: Prisma.QueryEvent) => void): void }
    ).$on('query', listener);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
