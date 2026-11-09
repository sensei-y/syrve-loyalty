import { HttpException, HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';

// Ограничение подбора пароля (и CPU DoS через дорогой scrypt): счётчик неудач проверяется ДО scrypt.
// По паре IP+логин — 10 неудач за 15 минут; по логину с любых IP — 30 (IP можно подделать,
// если ходить в api мимо nginx). Память процесса: api — один процесс.
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { ipLogin: 10, login: 30 };

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  // Админ из .env: создаём при первом старте, пароль обновляем, если в .env он другой.
  async onModuleInit() {
    const login = this.cfg.ADMIN_LOGIN;
    const existing = await this.prisma.admin.findUnique({ where: { login } });
    if (existing && (await verifyPassword(this.cfg.ADMIN_PASSWORD, existing.passwordHash))) return;
    const passwordHash = await hashPassword(this.cfg.ADMIN_PASSWORD);
    await this.prisma.admin.upsert({ where: { login }, create: { login, passwordHash }, update: { passwordHash } });
    this.logger.log(`Адміна «${login}» ${existing ? 'оновлено' : 'створено'} з .env`);
  }

  // JWT для cookie или null, если логин/пароль неверны. 429 — слишком много неудачных попыток.
  async login(login: string, password: string, ip: string): Promise<string | null> {
    const keys = [`ip:${ip}|${login.toLowerCase()}`, `login:${login.toLowerCase()}`] as const;
    if (this.blocked(keys[0], LIMITS.ipLogin) || this.blocked(keys[1], LIMITS.login)) {
      this.logger.warn(`Вхід «${login}» з ${ip} заблоковано: забагато невдалих спроб`);
      throw new HttpException('Забагато невдалих спроб. Спробуйте за 15 хвилин.', HttpStatus.TOO_MANY_REQUESTS);
    }

    const admin = await this.prisma.admin.findUnique({ where: { login } });
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      keys.forEach((k) => this.recordFailure(k));
      return null;
    }
    keys.forEach((k) => this.failures.delete(k));
    return this.jwt.signAsync({ sub: admin.id, login: admin.login });
  }

  private blocked(key: string, limit: number): boolean {
    const f = this.failures.get(key);
    return !!f && Date.now() - f.since < WINDOW_MS && f.count >= limit;
  }

  private recordFailure(key: string) {
    const now = Date.now();
    const f = this.failures.get(key);
    if (!f || now - f.since >= WINDOW_MS) this.failures.set(key, { count: 1, since: now });
    else f.count++;
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (now - v.since >= WINDOW_MS) this.failures.delete(k);
    }
  }
}
