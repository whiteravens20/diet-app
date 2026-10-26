// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { kindOf, worded, type Violation } from './violation.js';

/** How long reports are counted before the log gets their sum. */
export const WINDOW_MINUTES = 10;
/** The most kinds of violation told apart within one window. What comes beyond is counted, and not described. */
export const MOST_KINDS = 30;

/**
 * Keeps what browsers report against the content security policy, and says
 * it in the log: each kind of violation once when it is first seen, and every
 * ten minutes how often each was reported.
 *
 * The reports come from anybody, signed in or not, so the log is not theirs
 * to fill: a flood of reports costs a line for each of at most thirty kinds
 * and one line for the sum, however many arrive. The counts are this
 * process's own; several processes each write their sum.
 */
@Injectable()
export class PolicyReportsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ContentSecurityPolicy');
  private kinds = new Map<string, { count: number; first: Violation }>();
  private beyond = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  onModuleInit(): void {
    this.timer = setInterval(() => this.summarise(), WINDOW_MINUTES * 60_000);
    // Counting reports is no reason for a process to stay up.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.summarise();
  }

  record(violations: Violation[]): void {
    for (const violation of violations) {
      const kind = kindOf(violation);
      const known = this.kinds.get(kind);
      if (known) {
        known.count += 1;
      } else if (this.kinds.size >= MOST_KINDS) {
        this.beyond += 1;
      } else {
        this.kinds.set(kind, { count: 1, first: violation });
        // Said at once, so that whoever reads the log sees a new problem when it begins.
        this.logger.warn(worded(violation));
      }
    }
  }

  /** Write the sum of the window that ends now, and begin the next. Nothing is written for a window without reports. */
  summarise(): void {
    if (this.kinds.size === 0) return;
    const counted = [...this.kinds.values()].sort((a, b) => b.count - a.count);
    const total = counted.reduce((sum, kind) => sum + kind.count, this.beyond);
    const lines = counted.map((kind) => `${kind.count}x ${worded(kind.first)}`);
    if (this.beyond > 0)
      lines.push(`${this.beyond}x of kinds beyond the ${MOST_KINDS} that are told apart`);
    this.logger.log(
      `${total} report(s) in the last ${WINDOW_MINUTES} minutes: ${lines.join('; ')}`,
    );
    this.kinds = new Map();
    this.beyond = 0;
  }
}
