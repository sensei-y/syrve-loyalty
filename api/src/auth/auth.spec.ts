import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/config.schema';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, readCookie } from './auth.guard';
import { AuthService } from './auth.service';
import * as passwordModule from './password';
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
    return { guard: new AuthGuard(reflector, jwt, { ADMIN_LOGIN: 'admin' }), context, req };
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

  it('валідний токен прежнього логіна (до зміни ADMIN_LOGIN) → 401', async () => {
    const token = await jwt.signAsync({ sub: 'a0', login: 'old-admin' });
    const { guard, context } = ctx(`session=${token}`);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
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

describe('readCookie: пошкоджена cookie', () => {
  it('session=% → null (→ 401), а не виняток (→ 500)', () => {
    expect(() => readCookie('session=%', 'session')).not.toThrow();
    expect(readCookie('session=%', 'session')).toBeNull();
  });
});

describe('AuthService: обмеження спроб входу', () => {
  async function setup() {
    const passwordHash = await hashPassword('right-password');
    const prisma = {
      admin: {
        findUnique: jest.fn(async ({ where }: { where: { login: string } }) =>
          where.login === 'admin' ? { id: 'a1', login: 'admin', passwordHash } : null,
        ),
      },
    } as unknown as PrismaService;
    const cfg = { ADMIN_LOGIN: 'admin', ADMIN_PASSWORD: 'right-password' } as AppConfig;
    const service = new AuthService(cfg, prisma, new JwtService({ secret: 's'.repeat(32) }));
    const verify = jest.spyOn(passwordModule, 'verifyPassword');
    return { service, verify };
  }

  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('10 невдалих спроб з IP → 11-а: 429 без запуску scrypt', async () => {
    const { service, verify } = await setup();
    for (let i = 0; i < 10; i++) await expect(service.login('admin', 'wrong', '1.1.1.1')).resolves.toBeNull();
    verify.mockClear();

    await expect(service.login('admin', 'right-password', '1.1.1.1')).rejects.toMatchObject({ status: 429 });
    expect(verify).not.toHaveBeenCalled();
  });

  it('з іншого IP той самий логін ще пускає (до ліміту на логін)', async () => {
    const { service } = await setup();
    for (let i = 0; i < 10; i++) await service.login('admin', 'wrong', '1.1.1.1');

    await expect(service.login('admin', 'right-password', '2.2.2.2')).resolves.toEqual(expect.any(String));
  });

  it('30 невдач з різних IP → логін заблоковано (підробка X-Real-IP не допомагає)', async () => {
    const { service } = await setup();
    for (let i = 0; i < 30; i++) await service.login('admin', 'wrong', `10.0.0.${i}`);

    await expect(service.login('admin', 'right-password', '10.0.1.1')).rejects.toMatchObject({ status: 429 });
  });

  it('прежній логін, що лишився в БД, не входить навіть зі своїм паролем', async () => {
    const { service, verify } = await setup();
    const prisma = (service as unknown as { prisma: { admin: { findUnique: jest.Mock } } }).prisma;
    prisma.admin.findUnique.mockResolvedValue({ id: 'a0', login: 'old-admin', passwordHash: await hashPassword('old-password') });

    await expect(service.login('old-admin', 'old-password', '1.1.1.1')).resolves.toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  const failuresSize = (service: AuthService) =>
    (service as unknown as { failures: Map<string, unknown> }).failures.size;

  it('вигадані логіни з підробленими IP не роздувають таблицю невдач', async () => {
    const { service, verify } = await setup();
    for (let i = 0; i < 1000; i++) {
      await expect(service.login(`user-${i}`, 'wrong', `10.${i >> 8}.${i & 255}.1`)).resolves.toBeNull();
    }

    expect(failuresSize(service)).toBe(0);
    expect(verify).not.toHaveBeenCalled(); // scrypt для неіснуючого логіна не запускається
  });

  it('1000 невдач під admin з різних IP → не більше 31 запису, далі 429', async () => {
    const { service } = await setup();
    let blocked = 0;
    for (let i = 0; i < 1000; i++) {
      await service.login('admin', 'wrong', `10.${i >> 8}.${i & 255}.1`).catch(() => blocked++);
    }

    expect(failuresSize(service)).toBeLessThanOrEqual(31);
    expect(blocked).toBe(1000 - 30);
  });

  it('успішний вхід скидає лічильник', async () => {
    const { service } = await setup();
    for (let i = 0; i < 9; i++) await service.login('admin', 'wrong', '1.1.1.1');
    await service.login('admin', 'right-password', '1.1.1.1');

    for (let i = 0; i < 9; i++) await expect(service.login('admin', 'wrong', '1.1.1.1')).resolves.toBeNull();
  });
});
