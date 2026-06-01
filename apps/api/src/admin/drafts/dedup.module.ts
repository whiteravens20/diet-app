import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { DedupService } from './dedup.js';

/**
 * Standalone module so non-admin services (recipes, meal-plans) can use the
 * dedup helper without pulling the whole DraftsModule (and its AI / runner
 * deps) into their dependency graph.
 */
@Module({
  imports: [PrismaModule],
  providers: [DedupService],
  exports: [DedupService],
})
export class DedupModule {}
