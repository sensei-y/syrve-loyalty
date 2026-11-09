import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { SyrveModule } from './syrve/syrve.module';

// HTTP-процесс для админки. Все маршруты закрыты AuthGuard, кроме @Public().
@Module({
  imports: [ConfigModule, PrismaModule, SyrveModule, AuthModule, HealthModule],
})
export class ApiModule {}
