import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { RedisModule } from './common/redis.module';
import { ConfigModule } from './config/config.module';
import { GuestsModule } from './guests/guests.module';
import { HealthModule } from './health/health.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { PrismaModule } from './prisma/prisma.module';
import { SyrveModule } from './syrve/syrve.module';

// HTTP-процесс для админки. Все маршруты закрыты AuthGuard, кроме @Public().
@Module({
  imports: [ConfigModule, RedisModule, PrismaModule, SyrveModule, AuthModule, HealthModule, GuestsModule, LoyaltyModule],
})
export class ApiModule {}
