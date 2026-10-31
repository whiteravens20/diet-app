// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** How many of the latest requests are kept: a flood of them replaces these and takes no more memory. */
const KEPT = 1000;

/**
 * How long the latest requests of this process took and whether the server
 * failed them: two numbers a request, in arrays of a fixed size. No address, no
 * path and no account. It is the figure of one process, as the limiter's counts
 * are, and is lost with it: it says how this process does now.
 */
@Injectable()
export class RequestTimes {
  private readonly times = new Float64Array(KEPT);
  private readonly failed = new Uint8Array(KEPT);
  private next = 0;
  private counted = 0;

  note(ms: number, status: number): void {
    this.times[this.next] = ms;
    this.failed[this.next] = status >= 500 ? 1 : 0;
    this.next = (this.next + 1) % KEPT;
    this.counted = Math.min(this.counted + 1, KEPT);
  }

  summary(): {
    counted: number;
    medianMs: number | null;
    p95Ms: number | null;
    serverErrors: number;
  } {
    if (this.counted === 0) return { counted: 0, medianMs: null, p95Ms: null, serverErrors: 0 };
    const sorted = this.times.slice(0, this.counted).sort();
    const at = (share: number): number => Math.round(sorted[Math.ceil(share * sorted.length) - 1]!);
    return {
      counted: this.counted,
      medianMs: at(0.5),
      p95Ms: at(0.95),
      serverErrors: this.failed.slice(0, this.counted).reduce((sum, one) => sum + one, 0),
    };
  }
}

/** Times every request but the health checks, which come every few seconds and would be all there is on a quiet instance. */
export function timeRequests(
  times: RequestTimes,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (req.originalUrl.startsWith('/api/health')) {
      next();
      return;
    }
    const started = performance.now();
    res.once('finish', () => times.note(performance.now() - started, res.statusCode));
    next();
  };
}
