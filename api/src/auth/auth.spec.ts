import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard, readCookie } from './auth.guard';
import { hashPassword, verifyPassword } from './password';

describe('password (scrypt)', () => {
  it('вірний пароль проходить, невірний — ні; хеш не містить пароля', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(stored).not.toContain('correct horse');
    await expect(verifyPassword('correct horse', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong', stored)).resolves.toBe(false);
  });

  it('однаковий пароль → різні хеші (сіль)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('пошкоджений хеш → false, без винятку', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
  });
});

describe('AuthGuard', () => {
  const jwt = new JwtService({ secret: 's'.repeat(32) });
  const otherJwt = new JwtService({ secret: 'o'.repeat(32) });

  function ctx(cookie: string | undefined, isPublic = false) {
    const req: { headers: { cookie?: string }; admin?: unknown } = { headers: { cookie } };
    const reflector = { getAllAndOverride: () => isPublic } as unknown as Reflector;
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { guard: new AuthGuard(reflector, jwt), context, req };
  }

  it('без cookie → 401', async () => {
    const { guard, context } = ctx(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('токен з чужим підписом → 401', async () => {
    const forged = await otherJwt.signAsync({ sub: 'a1', login: 'admin' });
    const { guard, context } = ctx(`session=${forged}`);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('протермінований токен → 401', async () => {
    const expired = await jwt.signAsync({ sub: 'a1', login: 'admin' }, { expiresIn: -10 });
    const { guard, context } = ctx(`session=${expired}`);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('валідний токен → пропускає і кладе адміна в запит', async () => {
    const token = await jwt.signAsync({ sub: 'a1', login: 'admin' });
    const { guard, context, req } = ctx(`theme=dark; session=${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.admin).toEqual({ id: 'a1', login: 'admin' });
  });

  it('@Public() маршрут → без cookie пропускає', async () => {
    const { guard, context } = ctx(undefined, true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('readCookie знаходить потрібну cookie серед інших', () => {
    expect(readCookie('a=1; session=abc; b=2', 'session')).toBe('abc');
    expect(readCookie('xsession=abc', 'session')).toBeNull();
    expect(readCookie(undefined, 'session')).toBeNull();
  });
});
