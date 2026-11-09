import { Logger } from '@nestjs/common';
import { Guest } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MockSyrveClient } from '../syrve/mock-syrve.client';
import { GuestsService } from './guests.service';

// Таблица Guest в памяти: только те вызовы Prisma, что использует сервис.
function fakePrisma() {
  const rows: Guest[] = [];
  const guest = {
    findUnique: jest.fn(async ({ where }: { where: { telegramId: bigint } }) =>
      rows.find((r) => r.telegramId === where.telegramId) ?? null,
    ),
    upsert: jest.fn(
      async ({ where, create, update }: { where: { phone: string }; create: Partial<Guest>; update: Partial<Guest> }) => {
        const existing = rows.find((r) => r.phone === where.phone);
        if (existing) return Object.assign(existing, update);
        const row = { id: `g${rows.length + 1}`, lastRevision: 0n, createdAt: new Date(), ...create } as Guest;
        rows.push(row);
        return row;
      },
    ),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Guest> }) =>
      Object.assign(rows.find((r) => r.id === where.id)!, data),
    ),
  };
  return { rows, prisma: { guest } as unknown as PrismaService };
}

// Прямой доступ к гостю внутри mock — чтобы смоделировать изменения «в кабинете Syrve».
function mockRow(syrve: MockSyrveClient, id: string) {
  return (syrve as unknown as { customers: Map<string, { cards: string[]; balance: number; inProgram: boolean }> })
    .customers.get(id)!;
}

const TG = 111n;
const PHONE = '+380991234567';

function setup() {
  const syrve = new MockSyrveClient();
  const { rows, prisma } = fakePrisma();
  const service = new GuestsService(prisma, syrve);
  const spy = {
    upsert: jest.spyOn(syrve, 'upsertCustomer'),
    addToProgram: jest.spyOn(syrve, 'addToProgram'),
    addCard: jest.spyOn(syrve, 'addCard'),
  };
  return { syrve, rows, service, spy };
}

describe('GuestsService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('невалідний телефон → invalidPhone, Syrve не викликається', async () => {
    const { service, spy } = setup();
    await expect(service.handleContact(TG, '+48123456789')).resolves.toEqual({ kind: 'invalidPhone' });
    expect(spy.upsert).not.toHaveBeenCalled();
  });

  it('новий гість: питаємо ім’я, далі upsert → addToProgram → addCard', async () => {
    const { service, spy, rows } = setup();

    await expect(service.handleContact(TG, '380991234567')).resolves.toEqual({ kind: 'needName', phone: PHONE });
    const card = await service.register(TG, PHONE, 'Олена');

    expect(card).toEqual({ name: 'Олена', cardNumber: expect.stringMatching(/^[1-9]\d{9}$/), balance: 0 });
    expect(spy.upsert).toHaveBeenCalledWith({ phone: PHONE, name: 'Олена' });
    const order = [spy.upsert, spy.addToProgram, spy.addCard].map((s) => s.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ telegramId: TG, phone: PHONE, cardNumber: card.cardNumber });
  });

  it('гість уже є в Syrve з карткою: без upsert, ім’я не змінюється, картка не дублюється', async () => {
    const { syrve, service, spy } = setup();
    const { id } = await syrve.upsertCustomer({ phone: PHONE, name: 'Стара назва' });
    await syrve.addCard(id, '5550001111');
    spy.upsert.mockClear();
    spy.addCard.mockClear();

    const result = await service.handleContact(TG, PHONE);

    expect(result).toEqual({ kind: 'registered', card: { name: 'Стара назва', cardNumber: '5550001111', balance: 0 } });
    expect(spy.upsert).not.toHaveBeenCalled();
    expect(spy.addCard).not.toHaveBeenCalled();
    expect(spy.addToProgram).toHaveBeenCalledWith(id);
    expect((await syrve.findCustomer({ id }))!.name).toBe('Стара назва');
  });

  it('гість є в Syrve без картки → одна нова картка', async () => {
    const { syrve, service, spy } = setup();
    const { id } = await syrve.upsertCustomer({ phone: PHONE, name: 'Без картки' });
    spy.upsert.mockClear();

    const result = await service.handleContact(TG, PHONE);

    expect(spy.addCard).toHaveBeenCalledTimes(1);
    expect((await syrve.findCustomer({ id }))!.cards).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'registered', card: { name: 'Без картки' } });
  });

  it('повторна реєстрація того ж Telegram: без дубля і без нових викликів Syrve', async () => {
    const { service, spy, rows } = setup();
    const first = await service.register(TG, PHONE, 'Олена');
    spy.addCard.mockClear();
    spy.addToProgram.mockClear();

    const again = await service.handleContact(TG, PHONE);

    expect(again).toEqual({ kind: 'registered', card: first });
    expect(spy.addCard).not.toHaveBeenCalled();
    expect(spy.addToProgram).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('той самий телефон з іншого Telegram → перепривʼязка, без дубля в Syrve', async () => {
    const { service, spy, rows } = setup();
    const first = await service.register(TG, PHONE, 'Олена');
    spy.addCard.mockClear();

    const result = await service.handleContact(222n, PHONE);

    expect(result).toEqual({ kind: 'registered', card: first });
    expect(spy.addCard).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0].telegramId).toBe(222n);
  });

  it('зайнятий номер картки → генерується інший', async () => {
    const { syrve, service } = setup();
    const { id: foreign } = await syrve.upsertCustomer({ phone: '+380500000000', name: 'Чужий' });
    await syrve.addCard(foreign, '1111111111');
    jest
      .spyOn(service as unknown as { generateCardNumber(): string }, 'generateCardNumber')
      .mockReturnValueOnce('1111111111')
      .mockReturnValueOnce('2222222222');

    const card = await service.register(TG, PHONE, 'Олена');

    expect(card.cardNumber).toBe('2222222222');
  });

  it('подвійний виклик реєстрації → одна картка', async () => {
    const { service, spy } = setup();

    const [a, b] = await Promise.all([service.register(TG, PHONE, 'Олена'), service.register(TG, PHONE, 'Олена')]);

    expect(a).toEqual(b);
    expect(spy.upsert).toHaveBeenCalledTimes(1);
    expect(spy.addCard).toHaveBeenCalledTimes(1);
  });

  it('існуючий гість із карткою, ще не в програмі → баланс з повторного запиту після addToProgram', async () => {
    const { syrve, service } = setup();
    const { id } = await syrve.upsertCustomer({ phone: PHONE, name: 'Стара назва' });
    await syrve.addCard(id, '5550001111');
    mockRow(syrve, id).balance = 120; // стартовые бонусы появятся, когда гость попадёт в программу

    const result = await service.handleContact(TG, PHONE);

    expect(result).toMatchObject({ kind: 'registered', card: { balance: 120 } });
  });

  it('гаманця немає навіть після addToProgram → реєстрація падає, Guest не зберігається', async () => {
    const { syrve, service, spy, rows } = setup();
    await syrve.upsertCustomer({ phone: PHONE, name: 'Стара назва' });
    spy.addToProgram.mockResolvedValue(undefined); // program/add «прошёл», но кошелёк не появился

    await expect(service.handleContact(TG, PHONE)).rejects.toThrow('SYRVE_WALLET_ID');
    expect(rows).toHaveLength(0);
  });

  it('картку замінили в Syrve → getCard показує нову й оновлює кеш', async () => {
    const { syrve, service, rows } = setup();
    await service.register(TG, PHONE, 'Олена');
    mockRow(syrve, rows[0].syrveCustomerId).cards = ['7777777777'];

    await expect(service.getCard(TG)).resolves.toMatchObject({ cardNumber: '7777777777' });
    expect(rows[0].cardNumber).toBe('7777777777');
  });

  it('кілька карток, збережена серед них → getCard лишає збережену', async () => {
    const { syrve, service, rows } = setup();
    const { cardNumber } = await service.register(TG, PHONE, 'Олена');
    mockRow(syrve, rows[0].syrveCustomerId).cards = ['8888888888', cardNumber];

    await expect(service.getCard(TG)).resolves.toMatchObject({ cardNumber });
  });

  it('карток у Syrve не лишилось → getCard падає з помилкою', async () => {
    const { syrve, service, rows } = setup();
    await service.register(TG, PHONE, 'Олена');
    mockRow(syrve, rows[0].syrveCustomerId).cards = [];

    await expect(service.getCard(TG)).rejects.toThrow('немає картки');
  });

  it('у гостя немає нашого гаманця → balance: null (не 0) і попередження в лозі', async () => {
    const { syrve, service, rows } = setup();
    await service.register(TG, PHONE, 'Олена');
    // гость «выпал» из программы: mock отдаёт balance: null
    jest.spyOn(syrve, 'findCustomer').mockResolvedValueOnce({
      id: rows[0].syrveCustomerId,
      name: 'Олена',
      phone: PHONE,
      cards: [{ number: rows[0].cardNumber, track: rows[0].cardNumber }],
      balance: null,
    });

    await expect(service.getCard(TG)).resolves.toMatchObject({ balance: null });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('не в програмі'));
  });

  it('реєстрація фіксує базову точку сповіщень (останню ревізію історії)', async () => {
    const { syrve, service, rows } = setup();
    await service.register(TG, PHONE, 'Олена');

    const last = (await syrve.transactions(rows[0].syrveCustomerId, 0n)).lastRevision;
    expect(last).toBeGreaterThan(0n); // у нового гостя є службова SetGuestCategory
    expect(rows[0].lastRevision).toBe(last);
  });

  it('Syrve не віддав історію → реєстрація проходить, lastRevision = null (базу візьме поллер)', async () => {
    const { syrve, service, rows } = setup();
    jest.spyOn(syrve, 'transactions').mockRejectedValue(new Error('Syrve 500'));

    await expect(service.register(TG, PHONE, 'Олена')).resolves.toMatchObject({ name: 'Олена' });
    expect(rows[0].lastRevision).toBeNull();
  });

  it('перепривʼязка до іншого Telegram не скидає позицію поллера', async () => {
    const { service, rows } = setup();
    await service.register(TG, PHONE, 'Олена');
    rows[0].lastRevision = 999999n;

    await service.handleContact(222n, PHONE);

    expect(rows[0].lastRevision).toBe(999999n);
  });

  it('незареєстрований Telegram → getCard повертає null', async () => {
    const { service } = setup();
    await expect(service.getCard(999n)).resolves.toBeNull();
  });
});
