import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';

export const REDIS = Symbol('REDIS');

// Отдельное подключение для health-проверок. BullMQ держит свои соединения сам.
export const redisProvider: Provider = {
  provide: REDIS,
  useFactory: (cfg: AppConfig) =>
    new Redis({ host: cfg.REDIS_HOST, port: cfg.REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 }),
  inject: [APP_CONFIG],
};
