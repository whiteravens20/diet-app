// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { json } from 'express';
import { PolicyReportsController } from './policy-reports.controller.js';
import { PolicyReportsService } from './policy-reports.service.js';

/** The media types a browser sends a report as: JSON under names of their own, which the body parser of the application leaves unread. */
const REPORT_MEDIA_TYPES = ['application/csp-report', 'application/reports+json'];

@Module({ controllers: [PolicyReportsController], providers: [PolicyReportsService] })
export class PolicyReportsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // A report is a few hundred bytes, most of them the policy it quotes; a browser may send the ones it had waiting together.
    consumer.apply(json({ type: REPORT_MEDIA_TYPES, limit: '64kb' })).forRoutes(PolicyReportsController);
  }
}
