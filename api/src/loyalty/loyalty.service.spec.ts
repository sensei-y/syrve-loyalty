import { ConflictException, Logger } from '@nestjs/common';
import { OpStatus, OpType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/config.schema';
import { PrismaService } from '../prisma/prisma.service';
import { MockSyrveClient } from '../syrve/mock-syrve.client';
import { SyrveApiError } from '../syrve/syrve-api.error';
import { LoyaltyService, OperationInput } from './loyalty.service';

const ADMIN = { id: 'admin-1', login: 'admin' };

// Таблица Operation в памяти: create с уникальным idempotencyKey (P2002, как Prisma), update, find*.
function fakePrisma() {
  type Row = Record<string, unknown> & { id: string; idempotencyKey: string; createdAt: Date };
  const rows: Row[] = [];
  const withAdmin = (r: Row) => ({ ...r, admin: { login: ADMIN.login } });
  const operation = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (rows.some((r) => r.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      const row = {
        id: randomUUID(),
        status: OpStatus.PENDING,
        error: null,
        createdAt: new Date(),
        finishedAt: null,
        ...data,
      } as unknown as Row;
      rows.push(row);
      return withAdmin(row);
    }),
    findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) => {
      const r = rows.find((x) => x.idempotencyKey === where.idempotencyKey);
      return r ? withAdmin(r) : null;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      withAdmin(Object.assign(rows.find((r) => r.id === where.id)!, data)),
    ),
    findMany: jest.fn(async ({ where }: { where: { syrveCustomerId: string } }) =>
      rows
        .filter((r) => r.syrveCustomerId === where.syrveCustomerId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(withAdmin),
    ),
    updateMany: jest.fn(async ({ where, data }: { where: { status: OpStatus }; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => r.status === where.status);
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  };
  return { rows, prisma: { operation } as unknown as PrismaService };
}

async function setup(startBalance = 0) {
  const syrve = new MockSyrveClient();
  const { id } = await syrve.upsertCustomer({ phone: '+380991234567', name: 'Олена' });
  await syrve.addToProgram(id);
  if (startBalance) await syrve.topup(id, startBalance);
  const { rows, prisma } = fakePrisma();
  const service = new LoyaltyService(prisma, syrve, { SYRVE_WALLET_ID: undefined } as AppConfig);
  const spy = { topup: jest.spyOn(syrve, 'topup'), chargeoff: jest.spyOn(syrve, 'chargeoff') };
  const input = (over: Partial<OperationInput> = {}): OperationInput => ({
    syrveCustomerId: id,
    idempotencyKey: randomUUID(),
    type: OpType.TOPUP,
    amount: 10,
    reason: 'Бонус за відгук',
    admin: ADMIN,
    ...over,
  });
  const balance = async () => (await syrve.findCustomer({ id }))!.balance;
  return { syrve, service, spy, rows, input, balance, id };
}

describe('LoyaltyService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('начислення → SUCCESS, коментар у Syrve з причиною й адміном', async () => {
    const { service, spy, input, balance, id } = await setup();

    const op = await service.run(input({ amount: 12.5 }));

    expect(op).toMatchObject({ status: OpStatus.SUCCESS, type: OpType.TOPUP, amount: 12.5, admin: 'admin', error: null });
    expect(spy.topup).toHaveBeenCalledWith(id, 12.5, 'Бонус за відгук — admin');
    await expect(balance()).resolves.toBe(12.5);
  });

  it('списання понад баланс → FAILED, Syrve не викликається', async () => {
    const { service, spy, input, balance } = await setup(5);
    spy.topup.mockClear();

    const op = await service.run(input({ type: OpType.CHARGEOFF, amount: 20 }));

    expect(op.status).toBe(OpStatus.FAILED);
    expect(op.error).toContain('Недостатньо бонусів');
    expect(spy.chargeoff).not.toHaveBeenCalled();
    await expect(balance()).resolves.toBe(5);
  });

  it('списання в межах балансу → SUCCESS', async () => {
    const { service, input, balance } = await setup(10);

    await expect(service.run(input({ type: OpType.CHARGEOFF, amount: 10 }))).resolves.toMatchObject({
      status: OpStatus.SUCCESS,
    });
    await expect(balance()).resolves.toBe(0);
  });

  it('однаковий idempotencyKey послідовно → один виклик Syrve, той самий результат', async () => {
    const { service, spy, input, rows } = await setup();
    const req = input();

    const first = await service.run(req);
    const second = await service.run(req);

    expect(second).toEqual(first);
    expect(spy.topup).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it('однаковий idempotencyKey паралельно (подвійний клік) → один виклик Syrve', async () => {
    const { service, spy, input, balance } = await setup();
    const req = input();

    const results = await Promise.all([service.run(req), service.run(req), service.run(req)]);

    expect(spy.topup).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    await expect(balance()).resolves.toBe(10);
  });

  it('той самий ключ з іншою сумою → 409, Syrve не викликається вдруге', async () => {
    const { service, spy, input } = await setup();
    const req = input();
    await service.run(req);

    await expect(service.run({ ...req, amount: 99 })).rejects.toBeInstanceOf(ConflictException);
    expect(spy.topup).toHaveBeenCalledTimes(1);
  });

  it('таймаут Syrve → UNKNOWN, без повтору', async () => {
    const { service, spy, input } = await setup();
    spy.topup.mockRejectedValue(
      new SyrveApiError('timeout', '/api/1/loyalty/syrve/customer/wallet/topup', null, 'Timeout', null),
    );

    const op = await service.run(input());

    expect(op.status).toBe(OpStatus.UNKNOWN);
    expect(op.error).toContain('кабінеті Syrve');
    expect(spy.topup).toHaveBeenCalledTimes(1);
  });

  it('Syrve відповів помилкою → FAILED з кодом', async () => {
    const { service, spy, input } = await setup(50);
    spy.chargeoff.mockRejectedValue(
      new SyrveApiError('bad', '/api/1/loyalty/syrve/customer/wallet/chargeoff', 400, 'Wallet_Error', 'corr-1'),
    );

    const op = await service.run(input({ type: OpType.CHARGEOFF, amount: 5 }));

    expect(op).toMatchObject({ status: OpStatus.FAILED, error: 'Syrve відхилив операцію (Wallet_Error)' });
  });

  it('не отримали токен (таймаут access_token) → FAILED: до операції не дійшло', async () => {
    const { service, spy, input } = await setup();
    spy.topup.mockRejectedValue(new SyrveApiError('timeout', '/api/1/access_token', null, 'Timeout', null));

    await expect(service.run(input())).resolves.toMatchObject({ status: OpStatus.FAILED });
  });

  it('два паралельні списання з різними ключами не заводять баланс у мінус', async () => {
    const { service, spy, input, balance } = await setup(10);

    const [a, b] = await Promise.all([
      service.run(input({ type: OpType.CHARGEOFF, amount: 7 })),
      service.run(input({ type: OpType.CHARGEOFF, amount: 7 })),
    ]);

    expect([a.status, b.status].sort()).toEqual([OpStatus.FAILED, OpStatus.SUCCESS]);
    expect(spy.chargeoff).toHaveBeenCalledTimes(1);
    await expect(balance()).resolves.toBe(3);
  });

  it('паралельні списання з id у різному регістрі — одна черга, баланс не в мінус', async () => {
    const { service, spy, input, balance, id } = await setup(10);

    const [a, b] = await Promise.all([
      service.run(input({ type: OpType.CHARGEOFF, amount: 7, syrveCustomerId: id.toUpperCase() })),
      service.run(input({ type: OpType.CHARGEOFF, amount: 7, syrveCustomerId: id.toLowerCase() })),
    ]);

    expect([a.status, b.status].sort()).toEqual([OpStatus.FAILED, OpStatus.SUCCESS]);
    expect(spy.chargeoff).toHaveBeenCalledTimes(1);
    await expect(balance()).resolves.toBe(3);
  });

  it('журнал за id у верхньому регістрі показує ті самі операції', async () => {
    const { service, input, id } = await setup();
    await service.run(input({ syrveCustomerId: id.toUpperCase() }));

    expect(await service.journal(id.toUpperCase())).toHaveLength(1);
    expect(await service.journal(id)).toHaveLength(1);
  });

  it('у гостя немає гаманця програми → списання FAILED без виклику Syrve', async () => {
    const { syrve, service, spy, input, id } = await setup(10);
    jest.spyOn(syrve, 'findCustomer').mockResolvedValueOnce({ id, name: 'Олена', phone: '', cards: [], balance: null });

    const op = await service.run(input({ type: OpType.CHARGEOFF, amount: 1 }));

    expect(op).toMatchObject({ status: OpStatus.FAILED, error: 'Гаманець програми в гостя недоступний' });
    expect(spy.chargeoff).not.toHaveBeenCalled();
  });

  it('старт api: PENDING від минулого процесу → UNKNOWN, інші статуси не чіпає, Syrve не викликається', async () => {
    const { service, spy, input, rows } = await setup();
    await service.run(input()); // SUCCESS
    rows.push({ ...rows[0], id: 'stale', idempotencyKey: 'k-stale', status: OpStatus.PENDING, finishedAt: null });
    spy.topup.mockClear();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.recoverInterrupted()).resolves.toBe(1);

    expect(rows.find((r) => r.id === 'stale')).toMatchObject({ status: OpStatus.UNKNOWN, error: expect.stringContaining('кабінеті Syrve') });
    expect(rows[0].status).toBe(OpStatus.SUCCESS);
    expect(spy.topup).not.toHaveBeenCalled();
  });

  it('журнал: нові зверху, з адміном, причиною й статусом', async () => {
    const { service, input, id } = await setup(5);
    await service.run(input({ reason: 'Перша' }));
    await new Promise((r) => setTimeout(r, 5));
    await service.run(input({ type: OpType.CHARGEOFF, amount: 100, reason: 'Друга' }));

    const journal = await service.journal(id);

    expect(journal.map((j) => [j.reason, j.status, j.admin])).toEqual([
      ['Друга', OpStatus.FAILED, 'admin'],
      ['Перша', OpStatus.SUCCESS, 'admin'],
    ]);
  });
});

describe('LoyaltyService.history (Д1)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('новий гість без операцій → порожньо (службова SetGuestCategory не рахується)', async () => {
    const { service, id } = await setup();
    await expect(service.history(id, 10)).resolves.toEqual([]);
  });

  it('нові зверху, з балансом після і коментарем', async () => {
    const { syrve, service, id } = await setup();
    await syrve.topup(id, 10, 'Перша');
    await syrve.chargeoff(id, 3, 'Друга');

    const history = await service.history(id.toUpperCase(), 10);

    expect(history.map((h) => [h.sum, h.balanceAfter, h.comment])).toEqual([
      [-3, 7, 'Друга'],
      [10, 10, 'Перша'],
    ]);
  });

  it('фільтр як в О6: чужий гаманець і нульова сума не потрапляють', async () => {
    const { syrve, service, id } = await setup();
    jest.spyOn(syrve, 'transactions').mockResolvedValueOnce({
      transactions: [
        { id: 'svc', revision: 1n, type: 'SetGuestCategory', sum: 0, walletId: null, balanceAfter: null, comment: null, createdAt: '' },
        { id: 'zero', revision: 2n, type: 'X', sum: 0, walletId: 'mock-wallet', balanceAfter: 0, comment: null, createdAt: '' },
        { id: 'other', revision: 3n, type: 'X', sum: 5, walletId: 'other-wallet', balanceAfter: 5, comment: null, createdAt: '' },
        { id: 'ours', revision: 4n, type: 'X', sum: 7, walletId: 'MOCK-WALLET', balanceAfter: 7, comment: null, createdAt: '' },
      ],
      lastRevision: 4n,
      hasMore: false,
    });

    expect((await service.history(id, 10)).map((h) => h.id)).toEqual(['ours']);
  });

  it('ліміт через сторінки: 120 операцій → рівно 10 найновіших', async () => {
    const { syrve, service, id } = await setup();
    for (let i = 1; i <= 120; i++) await syrve.topup(id, i);
    const spy = jest.spyOn(syrve, 'transactions');

    const history = await service.history(id, 10);

    expect(history.map((h) => h.sum)).toEqual([120, 119, 118, 117, 116, 115, 114, 113, 112, 111]);
    expect(spy).toHaveBeenCalledTimes(3); // SetGuestCategory + 120 = 121 запис: 50 + 50 + 21
  });

  it('є ще сторінки, а ревізія не зростає → помилка, а не неповна історія', async () => {
    const { syrve, service, id } = await setup();
    jest.spyOn(syrve, 'transactions').mockResolvedValue({ transactions: [], lastRevision: 0n, hasMore: true });

    await expect(service.history(id, 10)).rejects.toThrow('не зростає');
  });
});
