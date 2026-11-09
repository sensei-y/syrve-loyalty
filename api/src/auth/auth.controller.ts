import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { CurrentAdmin, Public, SessionAdmin } from './auth.decorators';
import { SESSION_COOKIE } from './auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // За nginx реальный IP — в X-Real-IP; напрямую в api — адрес сокета.
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? 'unknown');
    const token = await this.auth.login(dto.login, dto.password, ip);
    if (!token) throw new UnauthorizedException('Невірний логін або пароль');
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions(), maxAge: SESSION_TTL_MS });
    return { login: dto.login };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    return { ok: true };
  }

  @Get('me')
  me(@CurrentAdmin() admin: SessionAdmin) {
    return { login: admin.login };
  }

  // httpOnly — JS страницы не читает токен; lax — защита от CSRF с чужих сайтов;
  // secure — только HTTPS: по умолчанию в production, COOKIE_SECURE=false — для локального http.
  private cookieOptions(): CookieOptions {
    const secure = this.cfg.COOKIE_SECURE ?? this.cfg.NODE_ENV === 'production';
    return { httpOnly: true, sameSite: 'lax', secure, path: '/' };
  }
}
