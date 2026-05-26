import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AdminController } from './admin.controller.js';
import { BasicAuthGuard } from './basic-auth.guard.js';

/**
 * F16 admin module — isolated namespace under `/api/admin/*`. No JWT, no
 * user identity; auth is HTTP Basic checked against ADMIN_USER / ADMIN_PASSWORD
 * by `BasicAuthGuard`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [BasicAuthGuard],
})
export class AdminModule {}
