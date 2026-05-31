import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { InstanceSettingsModule } from '../instance-settings/instance-settings.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ReviewController } from './review.controller.js';
import { ReviewerSessionGuard } from './reviewer-session.guard.js';

@Module({
  imports: [PrismaModule, JwtModule.register({}), InstanceSettingsModule],
  controllers: [ReviewController],
  providers: [ReviewerSessionGuard],
})
export class ReviewModule {}
