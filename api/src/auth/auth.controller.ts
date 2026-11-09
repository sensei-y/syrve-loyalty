import { Body, Controller, Get, HttpCode, Inject, Post, Res, UnauthorizedException } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
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
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const token = await this.auth.login(dto.login, dto.password);
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

  // httpOnly — JS страницы не читает токен; lax — защита от CSRF с чужих сайтов; secure — только HTTPS в production.
  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: this.cfg.NODE_ENV === 'production', path: '/' };
  }
}
