import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BasicAuthGuard } from '../admin/basic-auth.guard.js';
import { InstanceSettingsController } from './instance-settings.controller.js';
import { InstanceSettingsService } from './instance-settings.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [InstanceSettingsController],
  providers: [BasicAuthGuard, InstanceSettingsService],
  exports: [InstanceSettingsService],
})
export class InstanceSettingsModule {}
