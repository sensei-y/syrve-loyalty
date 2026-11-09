import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';

export const REDIS = Symbol('REDIS');

// Общее подключение процесса: health-check и Redis-backed MockSyrveClient.
// BullMQ держит свои соединения сам.
export const redisProvider: Provider = {
  provide: REDIS,
  useFactory: (cfg: AppConfig) =>
    new Redis({
      host: cfg.REDIS_HOST,
      port: cfg.REDIS_PORT,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // INCR revision должен оставаться точным и после Number.MAX_SAFE_INTEGER.
      stringNumbers: true,
    }),
  inject: [APP_CONFIG],
};
