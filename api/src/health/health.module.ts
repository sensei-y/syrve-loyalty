import { Module } from '@nestjs/common';
import { redisProvider } from '../common/redis.provider';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [redisProvider],
})
export class HealthModule {}
