import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { SyrveModule } from './syrve/syrve.module';

// HTTP-процесс для админки. Этапы 2–5 добавят Guests, Auth, Loyalty.
@Module({
  imports: [ConfigModule, PrismaModule, SyrveModule, HealthModule],
})
export class ApiModule {}
