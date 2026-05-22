import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** Global so every feature module can inject PrismaService without re-importing. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
