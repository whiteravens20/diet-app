// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module.js';
import { InstanceFilesService } from './instance-files.service.js';

/** The instance's own files, for the curation queue that ships into them and the update of the catalogue. */
@Module({
  imports: [PrismaModule],
  providers: [InstanceFilesService],
  exports: [InstanceFilesService],
})
export class InstanceFilesModule {}
