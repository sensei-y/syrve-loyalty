import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';

export const POLL_QUEUE = 'poll';
export const NOTIFY_QUEUE = 'notify';

// Этап 6:
//   poll   — repeatable job раз в 30 с: новые транзакции гостей из Syrve
//   notify — отправка сообщения в Telegram, jobId = id транзакции (защита от дублей)
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        connection: { host: cfg.REDIS_HOST, port: cfg.REDIS_PORT },
      }),
    }),
    BullModule.registerQueue({ name: POLL_QUEUE }, { name: NOTIFY_QUEUE }),
  ],
})
export class NotificationsModule {}
