import { Logger } from '@nestjs/common';
import { Guest } from '@prisma/client';
import { Queue, UnrecoverableError } from 'bullmq';
import { BotService } from '../bot/bot.service';
import { AppConfig } from '../config/config.schema';
import { PrismaService } from '../prisma/prisma.service';
import { MockSyrveClient } from '../syrve/mock-syrve.client';
import { SyrveTransactionPage } from '../syrve/syrve-client.interface';
import { notificationText } from './notification-text';
import { NotificationsService, NotifyJob } from './notifications.service';
import { latestRevision } from './revision';

const WALLET = '0eaa0000-29b3-b8cb-7be7-08de79e05361';

function setup() {
  const syrve = new MockSyrveClient(WALLET);
  const guests: Guest[] = [];
  const notified = new Set<string>();
  const prisma = {
    guest: {
      findMany: jest.fn(async () => guests),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Guest> }) =>
        Object.assign(guests.find((g) => g.id === where.id)!, data),
      ),
    },
    notifiedTransaction: {
      findUnique: jest.fn(async ({ where }: { where: { syrveTransactionId: string } }) =>
        notified.has(where.syrveTransactionId) ? { syrveTransactionId: where.syrveTransactionId } : null,
      ),
      create: jest.fn(async ({ data }: { data: { syrveTransactionId: string } }) => {
        notified.add(data.syrveTransactionId);
        return data;
      }),
    },
  } as unknown as PrismaService;

  // Очередь как BullMQ: задача с уже существующим jobId не добавляется.
  const jobs = new Map<string, NotifyJob>();
  const notifyQueue = {
    add: jest.fn(async (_name: string, data: NotifyJob, opts: { jobId: string }) => {
      if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, data);
    }),
  } as unknown as Queue;
  const pollQueue = { upsertJobScheduler: jest.fn(), removeJobScheduler: jest.fn() } as unknown as Queue;
  const sendMessage = jest.fn(async () => ({}));
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
  // Прогнать очередь notify: как воркер BullMQ.
  async function drain() {
    for (const [id, job] of [...jobs]) {
      jobs.delete(id);
      await service.deliver(job);
    }
  }
  return { syrve, service, guests, jobs, notifyQueue, sendMessage, prisma, notified, addGuest, drain };
}

describe('NotificationsService: опитування', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('базова точка (lastRevision = null): історія не надсилається, lastRevision = остання ревізія', async () => {
    const { syrve, service, jobs, addGuest } = setup();
    const guest = await addGuest(null);
    await syrve.topup(guest.syrveCustomerId, 10);
    await syrve.chargeoff(guest.syrveCustomerId, 3);
    const last = (await syrve.transactions(guest.syrveCustomerId, 0n)).lastRevision;

    await expect(service.pollGuest(guest)).resolves.toBe(0);

    expect(jobs.size).toBe(0);
    expect(guest.lastRevision).toBe(last);
  });

  it('базова точка в гостя без історії → 0n (не null): наступна транзакція надсилається', async () => {
    const { syrve, service, jobs, guests } = setup();
    const empty = { id: 'g-empty', telegramId: 1n, syrveCustomerId: 'x', lastRevision: null } as Guest;
    guests.push(empty);
    jest.spyOn(syrve, 'transactions').mockResolvedValue({ transactions: [], lastRevision: 0n, hasMore: false });

    await service.pollGuest(empty);

    expect(empty.lastRevision).toBe(0n);
    expect(jobs.size).toBe(0);
  });

  it('фільтр: службові записи, нульова сума й чужий гаманець не надсилаються', async () => {
    const { syrve, service, jobs, addGuest } = setup();
    const guest = await addGuest(0n); // SetGuestCategory вже в історії
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

    expect([...jobs.keys()]).toEqual(['ours']);
    expect(guest.lastRevision).toBe(4n);
  });

  it('нарахування й списання → по одному повідомленню з правильним текстом', async () => {
    const { syrve, service, sendMessage, addGuest, drain } = setup();
    const guest = await addGuest(null);
    await service.pollGuest(guest); // база
    await syrve.topup(guest.syrveCustomerId, 1);
    await syrve.chargeoff(guest.syrveCustomerId, 1);

    await service.pollGuest(guest);
    await drain();

    expect(sendMessage.mock.calls).toEqual([
      ['777', 'Нараховано 1 бонус. Баланс: 1 бонус'],
      ['777', 'Списано 1 бонус. Баланс: 0 бонусів'],
    ]);
  });

  it('дубль транзакції (повторний прохід / повторна постановка) → одне повідомлення', async () => {
    const { syrve, service, sendMessage, addGuest, drain, guests } = setup();
    const guest = await addGuest(null);
    await service.pollGuest(guest);
    const before = guest.lastRevision!;
    await syrve.topup(guest.syrveCustomerId, 5);

    await service.pollGuest(guest);
    await drain(); // надіслано, jobId вже видалено з черги
    guests[0].lastRevision = before; // наприклад, оновлення lastRevision не відбулося
    await service.pollGuest(guest);
    await drain();

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('пагінація: 120 транзакцій на 3 сторінках → усі в черзі, lastRevision = остання', async () => {
    const { syrve, service, jobs, addGuest } = setup();
    const guest = await addGuest(null);
    await service.pollGuest(guest);
    for (let i = 0; i < 120; i++) await syrve.topup(guest.syrveCustomerId, 1);
    const expectedLast = await latestRevision(syrve, guest.syrveCustomerId);
    const spy = jest.spyOn(syrve, 'transactions');

    await expect(service.pollGuest(guest)).resolves.toBe(120);

    expect(jobs.size).toBe(120);
    expect(spy).toHaveBeenCalledTimes(3); // 50 + 50 + 20
    expect(guest.lastRevision).toBe(expectedLast);
  });

  it('помилка постановки в чергу → lastRevision не зсувається', async () => {
    const { syrve, service, notifyQueue, addGuest } = setup();
    const guest = await addGuest(null);
    await service.pollGuest(guest);
    const before = guest.lastRevision;
    await syrve.topup(guest.syrveCustomerId, 5);
    (notifyQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Redis down'));

    await expect(service.pollGuest(guest)).rejects.toThrow('Redis down');
    expect(guest.lastRevision).toBe(before);
  });

  it('помилка одного гостя не зупиняє інших', async () => {
    const { syrve, service, jobs, addGuest } = setup();
    const broken = await addGuest(0n);
    const ok = await addGuest(null);
    await service.pollGuest(ok);
    await syrve.topup(ok.syrveCustomerId, 2);
    jest.spyOn(syrve, 'transactions').mockImplementation(async (id, from) => {
      if (id === broken.syrveCustomerId) throw new Error('Syrve 500');
      return MockSyrveClient.prototype.transactions.call(syrve, id, from);
    });

    await service.pollAll();

    expect(jobs.size).toBe(1);
  });
});

describe('NotificationsService: надсилання', () => {
  const job: NotifyJob = { guestId: 'g1', telegramId: '777', transactionId: 'tx-1', sum: -3, balanceAfter: 2 };
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('вже надіслано (NotifiedTransaction) → Telegram не викликається', async () => {
    const { service, sendMessage, notified } = setup();
    notified.add('tx-1');

    await expect(service.deliver(job)).resolves.toBe('skipped');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('успіх → запис у NotifiedTransaction', async () => {
    const { service, notified } = setup();
    await expect(service.deliver(job)).resolves.toBe('sent');
    expect(notified.has('tx-1')).toBe(true);
  });

  it('Telegram 403 (бота заблоковано) → UnrecoverableError, без ретраїв і без запису', async () => {
    const { service, sendMessage, notified } = setup();
    sendMessage.mockRejectedValueOnce(Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 }));

    await expect(service.deliver(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(notified.has('tx-1')).toBe(false);
  });

  it('інша помилка Telegram → звичайна помилка (BullMQ повторить з backoff)', async () => {
    const { service, sendMessage, notified } = setup();
    sendMessage.mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { error_code: 429 }));

    const err = await service.deliver(job).catch((e) => e);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(notified.has('tx-1')).toBe(false);
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
