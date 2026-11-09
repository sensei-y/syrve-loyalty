import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC, SessionAdmin } from './auth.decorators';

export const SESSION_COOKIE = 'session';

// Глобальный guard: без валидного JWT в cookie — 401 на всё, кроме @Public().
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<{ headers: { cookie?: string }; admin?: SessionAdmin }>();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException('Потрібен вхід');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; login: string }>(token);
      req.admin = { id: payload.sub, login: payload.login };
      return true;
    } catch {
      throw new UnauthorizedException('Сесія недійсна, увійдіть знову');
    }
  }
}

// Без cookie-parser: нам нужна одна cookie. Повреждённое значение (`session=%`) = cookie нет → 401, а не 500.
export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
