import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { Public } from '../auth/auth.decorators';
import { REDIS } from '../common/redis.provider';
import { PrismaService } from '../prisma/prisma.service';
import { describeError } from '../syrve/syrve-api.error';
import { SYRVE_CLIENT, SyrveClient } from '../syrve/syrve-client.interface';

// Открыт без входа: проверки Docker / мониторинга. Наружу — без деталей ошибок.
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

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

  // Подробности — только в лог (с correlationId), наружу — нейтральный текст.
  @Get('syrve')
  async syrveHealth() {
    try {
      return { status: 'ok', ...(await this.syrve.checkConnection()) };
    } catch (e) {
      this.logger.error(`Перевірка Syrve не пройшла: ${describeError(e)}`);
      throw new ServiceUnavailableException({ status: 'error', message: "Немає зв'язку з Syrve" });
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
