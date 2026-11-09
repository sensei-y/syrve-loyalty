import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

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

  // JWT для cookie или null, если логин/пароль неверны.
  async login(login: string, password: string): Promise<string | null> {
    const admin = await this.prisma.admin.findUnique({ where: { login } });
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) return null;
    return this.jwt.signAsync({ sub: admin.id, login: admin.login });
  }
}
