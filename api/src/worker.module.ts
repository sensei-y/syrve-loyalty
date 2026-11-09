import { Module } from '@nestjs/common';
import { BotModule } from './bot/bot.module';
import { RedisModule } from './common/redis.module';
import { ConfigModule } from './config/config.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { SyrveModule } from './syrve/syrve.module';

// Фоновый процесс: бот + очереди, без HTTP. Падение здесь не роняет админку.
@Module({
  imports: [ConfigModule, RedisModule, PrismaModule, SyrveModule, BotModule, NotificationsModule],
})
export class WorkerModule {}
