import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../common/redis.provider';
import { PrismaService } from '../prisma/prisma.service';
import { SYRVE_CLIENT, SyrveClient } from '../syrve/syrve-client.interface';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(SYRVE_CLIENT) private readonly syrve: SyrveClient,
  ) {}

  @Get()
  async health() {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    const status = db && redis ? 'ok' : 'degraded';
    if (status !== 'ok') throw new ServiceUnavailableException({ status, db, redis });
    return { status, db, redis };
  }

  @Get('syrve')
  async syrveHealth() {
    try {
      return { status: 'ok', ...(await this.syrve.checkConnection()) };
    } catch (e) {
      throw new ServiceUnavailableException({ status: 'error', message: (e as Error).message });
    }
  }

  private async checkDb() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis() {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
