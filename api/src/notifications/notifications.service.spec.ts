import { Logger } from '@nestjs/common';
import { Guest, NotificationStatus } from '@prisma/client';
import { Queue, UnrecoverableError } from 'bullmq';
import { HttpError } from 'grammy';
import { BotService } from '../bot/bot.service';
import { AppConfig } from '../config/config.schema';
import { PrismaService } from '../prisma/prisma.service';
import { MockSyrveClient } from '../syrve/mock-syrve.client';
import { SyrveTransactionPage } from '../syrve/syrve-client.interface';
import { notificationText } from './notification-text';
import { NotificationsService, NotifyJob } from './notifications.service';
import { latestRevision } from './revision';

const WALLET = '0eaa0000-29b3-b8cb-7be7-08de79e05361';

interface Row {
  syrveTransactionId: string;
  guestId: string;
  sum: number;
  balanceAfter: number | null;
  status: NotificationStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  sentAt: Date | null;
}

// Prisma в памяти: операции ленивые (как PrismaPromise), $transaction выполняет их по очереди
// и откатывает состояние при ошибке — иначе атомарность «строки outbox + курсор» не проверить.
function fakePrisma() {
  const guests: Guest[] = [];
  const outbox = new Map<string, Row>();
  const lazy = <T>(fn: () => T | Promise<T>) => {
    let p: Promise<T> | undefined;
    return { then: (ok: (v: T) => unknown, err?: (e: unknown) => unknown) => (p ??= Promise.resolve().then(fn)).then(ok, err) };
  };
  const matches = (r: Row, where: Record<string, unknown>) =>
    (where.syrveTransactionId === undefined || r.syrveTransactionId === where.syrveTransactionId) &&
    (where.status === undefined || r.status === where.status) &&
    (where.claimedAt === undefined || (r.claimedAt !== null && r.claimedAt < (where.claimedAt as { lt: Date }).lt));
  const apply = (r: Row, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      (r as unknown as Record<string, unknown>)[k] =
        typeof v === 'object' && v !== null && 'increment' in v ? (r.attempts += (v as { increment: number }).increment) : v;
    }
  };

  const prisma = {
    guest: {
      findMany: jest.fn(() => lazy(() => guests)),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => lazy(() => guests.find((g) => g.id === where.id) ?? null)),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<Guest> }) =>
        lazy(() => Object.assign(guests.find((g) => g.id === where.id)!, data)),
      ),
    },
    notification: {
      createMany: jest.fn(({ data }: { data: Omit<Row, 'status' | 'attempts' | 'lastError' | 'createdAt' | 'claimedAt' | 'sentAt'>[] }) =>
        lazy(() => {
          for (const d of data) {
            if (outbox.has(d.syrveTransactionId)) continue; // skipDuplicates
            outbox.set(d.syrveTransactionId, {
              ...d, status: NotificationStatus.PENDING, attempts: 0, lastError: null, createdAt: new Date(), claimedAt: null, sentAt: null,
            });
          }
          return { count: data.length };
        }),
      ),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        lazy(() => [...outbox.values()].filter((r) => matches(r, where))),
      ),
      findUnique: jest.fn(({ where }: { where: { syrveTransactionId: string } }) => lazy(() => outbox.get(where.syrveTransactionId) ?? null)),
      updateMany: jest.fn(({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) =>
        lazy(() => {
          const hit = [...outbox.values()].filter((r) => matches(r, where));
          hit.forEach((r) => apply(r, data));
          return { count: hit.length };
        }),
      ),
      update: jest.fn(({ where, data }: { where: { syrveTransactionId: string }; data: Record<string, unknown> }) =>
        lazy(() => {
          const r = outbox.get(where.syrveTransactionId);
          if (!r) throw new Error('not found');
          apply(r, data);
          return r;
        }),
      ),
    },
    $transaction: jest.fn(async (ops: PromiseLike<unknown>[]) => {
      const snapshotGuests = guests.map((g) => ({ ...g }));
      const snapshotOutbox = new Map([...outbox].map(([k, v]) => [k, { ...v }]));
      try {
        const results = [];
        for (const op of ops) results.push(await op);
        return results;
      } catch (e) {
        guests.forEach((g, i) => Object.assign(g, snapshotGuests[i]));
        outbox.clear();
        snapshotOutbox.forEach((v, k) => outbox.set(k, v));
        throw e;
      }
    }),
  };
  return { guests, outbox, prisma: prisma as unknown as PrismaService, raw: prisma };
}

function setup() {
  const syrve = new MockSyrveClient(WALLET);
  const { guests, outbox, prisma, raw } = fakePrisma();
  // Очередь как BullMQ: задача с уже стоящим jobId не добавляется.
  const jobs = new Map<string, NotifyJob>();
  const notifyQueue = {
    add: jest.fn(async (_name: string, data: NotifyJob, opts: { jobId: string }) => {
      if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, data);
    }),
  } as unknown as Queue;
  const pollQueue = { upsertJobScheduler: jest.fn(), removeJobScheduler: jest.fn() } as unknown as Queue;
  const sendMessage = jest.fn(async (..._args: unknown[]) => ({}));
  const bot = { api: { sendMessage } } as unknown as BotService;
  const cfg = { SYRVE_WALLET_ID: WALLET, TELEGRAM_BOT_TOKEN: 't' } as AppConfig;
  const service = new NotificationsService(cfg, prisma, syrve, bot, pollQueue, notifyQueue);

  async function addGuest(lastRevision: bigint | null) {
    const { id } = await syrve.upsertCustomer({ phone: `+38099${guests.length}000000`, name: 'Олена' });
    await syrve.addToProgram(id);
    const guest = { id: `g${guests.length}`, telegramId: 777n, syrveCustomerId: id, phone: '', name: 'Олена',
      cardNumber: '1', lastRevision, createdAt: new Date() } as Guest;
    guests.push(guest);
    return guest;
  }
  // Полный проход поллера + воркер notify, как в BullMQ (очередь опустошается, задачи удаляются).
  async function cycle() {
    await service.pollAll();
    for (const [id, job] of [...jobs]) {
      jobs.delete(id);
      await service.deliver(job.transactionId).catch(() => undefined);
    }
  }
  return { syrve, service, guests, outbox, jobs, notifyQueue, sendMessage, raw, addGuest, cycle };
}

const quiet = () => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
};

describe('NotificationsService: опитування', () => {
  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());

  it('базова точка (lastRevision = null): історія не надсилається, lastRevision = остання ревізія', async () => {
    const { syrve, service, outbox, addGuest } = setup();
    const guest = await addGuest(null);
    await syrve.topup(guest.syrveCustomerId, 10);
    await syrve.chargeoff(guest.syrveCustomerId, 3);
    const last = await latestRevision(syrve, guest.syrveCustomerId);

    await expect(service.pollGuest(guest)).resolves.toBe(0);

    expect(outbox.size).toBe(0);
    expect(guest.lastRevision).toBe(last);
  });

  it('базова точка в гостя без історії → 0n (не null)', async () => {
    const { syrve, service, outbox, guests } = setup();
    const empty = { id: 'g-empty', telegramId: 1n, syrveCustomerId: 'x', lastRevision: null } as Guest;
    guests.push(empty);
    jest.spyOn(syrve, 'transactions').mockResolvedValue({ transactions: [], lastRevision: 0n, hasMore: false });

    await service.pollGuest(empty);

    expect(empty.lastRevision).toBe(0n);
    expect(outbox.size).toBe(0);
  });

  it('фільтр: службові записи, нульова сума й чужий гаманець не потрапляють в outbox', async () => {
    const { syrve, service, outbox, addGuest } = setup();
    const guest = await addGuest(0n);
    const page: SyrveTransactionPage = {
      transactions: [
        { id: 'svc', revision: 1n, type: 'SetGuestCategory', sum: 0, walletId: null, balanceAfter: null, comment: null, createdAt: '' },
        { id: 'zero', revision: 2n, type: 'X', sum: 0, walletId: WALLET, balanceAfter: 5, comment: null, createdAt: '' },
        { id: 'other', revision: 3n, type: 'X', sum: 50, walletId: '0ba20000-29b3-b8cb-4481-08dd0f9b7994', balanceAfter: 50, comment: null, createdAt: '' },
        { id: 'ours', revision: 4n, type: 'RefillWalletFromApi', sum: 10, walletId: WALLET.toUpperCase(), balanceAfter: 10, comment: null, createdAt: '' },
      ],
      lastRevision: 4n,
      hasMore: false,
    };
    jest.spyOn(syrve, 'transactions').mockResolvedValueOnce(page);

    await service.pollGuest(guest);

    expect([...outbox.keys()]).toEqual(['ours']);
    expect(guest.lastRevision).toBe(4n);
  });

  it('нарахування й списання → по одному повідомленню з правильним текстом, статус SENT', async () => {
    const { syrve, service, sendMessage, outbox, addGuest, cycle } = setup();
    const guest = await addGuest(null);
    await service.pollGuest(guest); // база
    await syrve.topup(guest.syrveCustomerId, 1);
    await syrve.chargeoff(guest.syrveCustomerId, 1);

    await cycle();

    expect(sendMessage.mock.calls).toEqual([
      ['777', 'Нараховано 1 бонус. Баланс: 1 бонус'],
      ['777', 'Списано 1 бонус. Баланс: 0 бонусів'],
    ]);
    expect([...outbox.values()].map((r) => r.status)).toEqual([NotificationStatus.SENT, NotificationStatus.SENT]);
  });

  it('дубль транзакції (курсор відкотився, транзакцію прочитано вдруге) → одне повідомлення', async () => {
    const { syrve, service, sendMessage, addGuest, cycle, guests } = setup();
    const guest = await addGuest(null);
    await service.pollGuest(guest);
    const before = guest.lastRevision!;
    await syrve.topup(guest.syrveCustomerId, 5);

    await cycle();
    guests[0].lastRevision = before;
    await cycle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('пагінація: 120 транзакцій на 3 сторінках → усі в outbox, lastRevision = остання', async () => {
    const { syrve, service, outbox, addGuest } = setup();
    const guest = await addGuest(null);
    await service.pollGuest(guest);
    for (let i = 0; i < 120; i++) await syrve.topup(guest.syrveCustomerId, 1);
    const expectedLast = await latestRevision(syrve, guest.syrveCustomerId);
    const spy = jest.spyOn(syrve, 'transactions');

    await expect(service.pollGuest(guest)).resolves.toBe(120);

    expect(outbox.size).toBe(120);
    expect(spy).toHaveBeenCalledTimes(3); // 50 + 50 + 20
    expect(guest.lastRevision).toBe(expectedLast);
  });

  it('outbox і курсор атомарні: запис outbox упав → lastRevision не зсувається', async () => {
    const { syrve, service, guests, outbox, raw, addGuest } = setup();
    const guest = await addGuest(null);
    await service.pollGuest(guest);
    const before = guest.lastRevision;
    await syrve.topup(guest.syrveCustomerId, 5);
    raw.notification.createMany.mockImplementationOnce(() => ({
      then: (_ok: unknown, err?: (e: unknown) => unknown) => Promise.reject(new Error('DB down')).then(undefined, err),
    }));

    await expect(service.pollGuest(guest)).rejects.toThrow('DB down');
    expect(guests[0].lastRevision).toBe(before);
    expect(outbox.size).toBe(0);
  });

  it('Redis втратив задачі після зсуву курсора → наступний прохід ставить PENDING знову, повідомлення одне', async () => {
    const { syrve, service, jobs, notifyQueue, sendMessage, addGuest, cycle } = setup();
    const guest = await addGuest(null);
    await service.pollGuest(guest);
    await syrve.topup(guest.syrveCustomerId, 5);

    // Перший прохід: outbox записано, курсор зсунуто, але Redis «впав» на постановці.
    (notifyQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Redis down'));
    await service.pollAll().catch(() => undefined);
    jobs.clear(); // очистка Redis
    expect(sendMessage).not.toHaveBeenCalled();

    await cycle(); // Redis знову є

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('помилка одного гостя не зупиняє інших', async () => {
    const { syrve, service, outbox, addGuest } = setup();
    const broken = await addGuest(0n);
    const ok = await addGuest(null);
    await service.pollGuest(ok);
    await syrve.topup(ok.syrveCustomerId, 2);
    const real = syrve.transactions.bind(syrve);
    jest.spyOn(syrve, 'transactions').mockImplementation(async (id, from) => {
      if (id === broken.syrveCustomerId) throw new Error('Syrve 500');
      return real(id, from);
    });

    await service.pollAll();

    expect(outbox.size).toBe(1);
  });
});

describe('NotificationsService: надсилання (outbox)', () => {
  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());

  async function withPending() {
    const ctx = setup();
    const guest = await ctx.addGuest(null);
    await ctx.service.pollGuest(guest);
    await ctx.syrve.chargeoff(guest.syrveCustomerId, 3);
    await ctx.service.pollGuest(guest);
    const txId = [...ctx.outbox.keys()][0];
    return { ...ctx, txId };
  }

  it('вже SENT → Telegram не викликається', async () => {
    const { service, sendMessage, outbox, txId } = await withPending();
    outbox.get(txId)!.status = NotificationStatus.SENT;

    await expect(service.deliver(txId)).resolves.toBe('skipped');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('дві задачі на одну транзакцію одночасно → одне повідомлення', async () => {
    const { service, sendMessage, txId } = await withPending();

    await Promise.all([service.deliver(txId), service.deliver(txId)]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('SENT не записався після надсилання → повтор задачі нічого не шле; рестарт → UNKNOWN', async () => {
    const { service, sendMessage, outbox, raw, txId } = await withPending();
    raw.notification.update.mockImplementationOnce(() => ({
      then: (_ok: unknown, err?: (e: unknown) => unknown) => Promise.reject(new Error('DB down')).then(undefined, err),
    }));

    await expect(service.deliver(txId)).resolves.toBe('sent');
    expect(outbox.get(txId)!.status).toBe(NotificationStatus.SENDING);
    await expect(service.deliver(txId)).resolves.toBe('skipped'); // ретрай BullMQ
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Новий процес worker: SENDING, захоплені до його старту → UNKNOWN, без повторного надсилання.
    const restarted = new NotificationsService(
      { SYRVE_WALLET_ID: WALLET } as AppConfig, (service as unknown as { prisma: PrismaService }).prisma,
      new MockSyrveClient(WALLET), { api: { sendMessage } } as unknown as BotService, {} as Queue, {} as Queue,
    );
    outbox.get(txId)!.claimedAt = new Date(Date.now() - 1000);
    await expect(restarted.recoverInterrupted()).resolves.toBe(1);
    expect(outbox.get(txId)!.status).toBe(NotificationStatus.UNKNOWN);
  });

  it('рестарт не чіпає SENDING, захоплені вже новим процесом', async () => {
    const { service, outbox, txId } = await withPending();
    Object.assign(outbox.get(txId)!, { status: NotificationStatus.SENDING, claimedAt: new Date(Date.now() + 60_000) });

    await expect(service.recoverInterrupted()).resolves.toBe(0);
  });

  it('Telegram 403 (бота заблоковано) → FAILED, UnrecoverableError', async () => {
    const { service, sendMessage, outbox, txId } = await withPending();
    sendMessage.mockRejectedValueOnce(Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 }));

    await expect(service.deliver(txId)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(outbox.get(txId)!.status).toBe(NotificationStatus.FAILED);
  });

  it('інша помилка Telegram → назад у PENDING і помилка для ретраю; остання спроба → FAILED', async () => {
    const { service, sendMessage, outbox, txId } = await withPending();
    const tooMany = () => Object.assign(new Error('Too Many Requests'), { error_code: 429 });
    sendMessage.mockRejectedValueOnce(tooMany());

    const err = await service.deliver(txId).catch((e) => e);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(outbox.get(txId)!.status).toBe(NotificationStatus.PENDING);

    sendMessage.mockRejectedValueOnce(tooMany());
    await service.deliver(txId, true).catch(() => undefined);
    expect(outbox.get(txId)).toMatchObject({ status: NotificationStatus.FAILED, attempts: 2 });
  });
});

describe('NotificationsService: неоднозначні помилки Telegram', () => {
  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());

  async function withPending() {
    const ctx = setup();
    const guest = await ctx.addGuest(null);
    await ctx.service.pollGuest(guest);
    await ctx.syrve.topup(guest.syrveCustomerId, 2);
    await ctx.service.pollGuest(guest);
    return { ...ctx, txId: [...ctx.outbox.keys()][0] };
  }
  const netError = (code: string) =>
    new HttpError("Network request for 'sendMessage' failed!", Object.assign(new Error(code), { code }));

  it('побічний ефект стався (Telegram прийняв), потім відповідь втрачено → UNKNOWN, без повторного надсилання', async () => {
    const { service, sendMessage, outbox, txId } = await withPending();
    const delivered: unknown[] = [];
    sendMessage.mockImplementationOnce(async (...args: unknown[]) => {
      delivered.push(args); // сообщение у гостя
      throw netError('ECONNRESET'); // а ответ до нас не дошёл
    });

    await expect(service.deliver(txId)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(outbox.get(txId)!.status).toBe(NotificationStatus.UNKNOWN);

    await expect(service.deliver(txId)).resolves.toBe('skipped'); // ретрай / новый проход
    expect(delivered).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('зʼєднання не встановлено (ECONNREFUSED) → запит точно не пішов: PENDING і повтор', async () => {
    const { service, sendMessage, outbox, txId } = await withPending();
    sendMessage.mockRejectedValueOnce(netError('ECONNREFUSED'));

    const err = await service.deliver(txId).catch((e) => e);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(outbox.get(txId)!.status).toBe(NotificationStatus.PENDING);
  });

  it('відповідь Telegram 400 (chat not found) → FAILED, без повторів', async () => {
    const { service, sendMessage, outbox, txId } = await withPending();
    sendMessage.mockRejectedValueOnce(Object.assign(new Error('Bad Request: chat not found'), { error_code: 400 }));

    await expect(service.deliver(txId)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(outbox.get(txId)!.status).toBe(NotificationStatus.FAILED);
  });

  // 5xx приходит уже после того, как запрос дошёл до Telegram / шлюза: отсутствие эффекта не доказано.
  it.each([500, 502, 504])('відповідь Telegram %d → UNKNOWN, без повторів (можливий побічний ефект)', async (code) => {
    const { service, sendMessage, outbox, txId } = await withPending();
    sendMessage.mockRejectedValueOnce(Object.assign(new Error('Server error'), { error_code: code }));

    await expect(service.deliver(txId)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(outbox.get(txId)!.status).toBe(NotificationStatus.UNKNOWN);
    await expect(service.deliver(txId)).resolves.toBe('skipped');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('latestRevision (базова точка)', () => {
  it('є ще сторінки, а ревізія не зростає → помилка, не проміжна ревізія', async () => {
    const syrve = new MockSyrveClient(WALLET);
    jest.spyOn(syrve, 'transactions').mockResolvedValue({ transactions: [], lastRevision: 0n, hasMore: true });

    await expect(latestRevision(syrve, 'c')).rejects.toThrow('не зростає');
  });
});

describe('notificationText', () => {
  it.each([
    [10, 15, 'Нараховано 10 бонусів. Баланс: 15 бонусів'],
    [1, 21, 'Нараховано 1 бонус. Баланс: 21 бонус'],
    [-2, 22, 'Списано 2 бонуси. Баланс: 22 бонуси'],
    [-5, null, 'Списано 5 бонусів.'],
  ])('%d, %s → %s', (sum, after, text) => {
    expect(notificationText(sum, after)).toBe(text);
  });
});
