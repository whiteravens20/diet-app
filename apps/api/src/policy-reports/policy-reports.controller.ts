// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PolicyReport } from '@diet-app/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PolicyReportsService } from './policy-reports.service.js';
import { violationsIn } from './violation.js';

/** Where the web application tells browsers to send their reports, under `/api`. */
const POLICY_REPORTS_PATH = 'csp-reports';

/**
 * Takes what a browser reports when a page broke the content security
 * policy. A browser sends this by itself, without a session, so the route is
 * open to anybody; what it does with a report is count it (see the service).
 *
 * Sixty a minute for a sender, which behind the web server without
 * `TRUST_PROXY` is everybody together: beyond that reports are lost, and
 * nothing else of anybody's is. A page that breaks the policy does so a few
 * times for each time it is loaded.
 */
@Controller(POLICY_REPORTS_PATH)
export class PolicyReportsController {
  constructor(private readonly reports: PolicyReportsService) {}

  /** Take a browser's report of something a page was not allowed to do. */
  @Post()
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  receive(@Body(new ZodValidationPipe(PolicyReport)) body: PolicyReport): void {
    this.reports.record(violationsIn(body));
  }
}
