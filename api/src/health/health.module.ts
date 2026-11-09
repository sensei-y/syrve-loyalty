import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS, redisProvider } from '../common/redis.provider';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [redisProvider],
})
export class HealthModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // Закрываем подключение health-check, иначе процесс не завершается чисто.
  onApplicationShutdown() {
    this.redis.disconnect();
  }
}
