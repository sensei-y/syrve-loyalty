import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { NotifyProcessor, PollProcessor } from './notifications.processors';
import { NOTIFY_QUEUE, NotificationsService, POLL_QUEUE } from './notifications.service';

// О6, только worker:
//   poll   — каждые 30 с: новые транзакции гостей бота из Syrve → задачи notify;
//   notify — сообщение в Telegram, jobId = id транзакции + таблица NotifiedTransaction (без дублей).
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        connection: { host: cfg.REDIS_HOST, port: cfg.REDIS_PORT },
      }),
    }),
    BullModule.registerQueue({ name: POLL_QUEUE }, { name: NOTIFY_QUEUE }),
    BotModule,
  ],
  providers: [NotificationsService, PollProcessor, NotifyProcessor],
})
export class NotificationsModule {}
