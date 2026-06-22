import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { TurnstileService } from '../auth/turnstile.service.js';
import { AppConfigController } from './app-config.controller.js';

/**
 * Serves GET /api/config. TurnstileService is stateless (reads ConfigService),
 * so it's provided directly here rather than coupling to AuthModule.
 */
@Module({
  imports: [MailModule],
  controllers: [AppConfigController],
  providers: [TurnstileService],
})
export class AppConfigModule {}
