// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { InstanceFilesModule } from '../admin/drafts/ship/instance-files.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProductReviewService } from './product-review.service.js';

/** What accounts send to the base and what becomes of it: for the reviewers and for the panel. */
@Module({
  imports: [PrismaModule, NotificationsModule, InstanceFilesModule],
  providers: [ProductReviewService],
  exports: [ProductReviewService],
})
export class ProductReviewModule {}
