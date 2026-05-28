import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AdminController } from './admin.controller.js';
import { BasicAuthGuard } from './basic-auth.guard.js';
import { SeedRunner } from './seed/runner.js';
import { TranslateRunner } from './translate/runner.js';

/**
 * F16 admin module — isolated namespace under `/api/admin/*`. No JWT, no
 * user identity; auth is HTTP Basic checked against ADMIN_USER / ADMIN_PASSWORD
 * by `BasicAuthGuard`.
 */
@Module({
  imports: [PrismaModule, AiModule],
  controllers: [AdminController],
  providers: [BasicAuthGuard, SeedRunner, TranslateRunner],
})
export class AdminModule {}
