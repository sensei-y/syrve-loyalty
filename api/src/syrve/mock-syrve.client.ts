import { randomUUID } from 'node:crypto';
import { SyrveApiError } from './syrve-api.error';
import {
  SyrveClient,
  SyrveCustomer,
  SyrveCustomerQuery,
  SyrveTransaction,
  SyrveTransactionPage,
} from './syrve-client.interface';

export const MOCK_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';
export const MOCK_PROGRAM_ID = '00000000-0000-0000-0000-000000000002';
export const MOCK_WALLET_ID = '00000000-0000-0000-0000-000000000003';
export const MOCK_OTHER_WALLET_IDS = [
  '00000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000005',
] as const;

const PREFIX = 'syrve:mock:v1';
const REVISION_KEY = `${PREFIX}:revision`;
const PAGE_SIZE = 50;

// Узкий контракт нужен, чтобы unit-тесты подменяли Redis без сети и сторонней библиотеки.
export interface MockRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'NX'): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  hset(key: string, values: Record<string, string | number>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hincrbyfloat(key: string, field: string, increment: number): Promise<string>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  incr(key: string): Promise<number | string>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

interface MockCustomerRecord {
  id: string;
  name: string;
  phone: string;
  inProgram: string;
  [field: string]: string;
}

interface StoredTransaction extends Omit<SyrveTransaction, 'revision'> {
  revision: string;
}

// Демо-реализация Syrve поверх общего Redis: api и worker видят один state.
// Как и RealSyrveClient, findCustomer преобразует сырой Syrve 400 «не найдено» в null.
export class MockSyrveClient implements SyrveClient {
  constructor(private readonly redis: MockRedis) {}

  async checkConnection() {
    return {
      organization: { id: MOCK_ORGANIZATION_ID, name: 'Mock organization' },
      program: { id: MOCK_PROGRAM_ID, name: 'Mock loyalty program', walletId: MOCK_WALLET_ID },
    };
  }

  async findCustomer(q: SyrveCustomerQuery): Promise<SyrveCustomer | null> {
    const id =
      'phone' in q
        ? await this.redis.get(phoneKey(q.phone))
        : 'cardNumber' in q
          ? await this.redis.get(cardKey(q.cardNumber))
          : q.id.toLowerCase();
    if (!id) return null;
    const record = await this.record(id);
    return record ? this.toCustomer(record) : null;
  }

  async upsertCustomer(data: { phone: string; name: string }): Promise<{ id: string }> {
    const existingId = await this.redis.get(phoneKey(data.phone));
    if (existingId) {
      await this.redis.hset(customerKey(existingId), { name: data.name });
      return { id: existingId };
    }

    // Сначала готовим полностью заполненного кандидата, потом публикуем его через SET NX:
    // читатель никогда не увидит индекс телефона без записи гостя.
    const candidateId = randomUUID().toLowerCase();
    await this.redis.hset(customerKey(candidateId), {
      id: candidateId,
      name: data.name,
      phone: data.phone,
      inProgram: '0',
      [walletField(MOCK_WALLET_ID)]: '0',
      [walletField(MOCK_OTHER_WALLET_IDS[0])]: '125',
      [walletField(MOCK_OTHER_WALLET_IDS[1])]: '50',
    });
    await this.recordTransaction(candidateId, {
      type: 'SetGuestCategory',
      sum: 0,
      walletId: null,
      balanceAfter: null,
      comment: 'Mock default category',
    });

    if ((await this.redis.set(phoneKey(data.phone), candidateId, 'NX')) === 'OK') return { id: candidateId };

    // Другой процесс выиграл upsert того же телефона. Удаляем недоступного кандидата
    // и повторяем семантику create_or_update: имя существующего гостя перезаписывается.
    await this.redis.del(customerKey(candidateId), cardsKey(candidateId), historyKey(candidateId));
    const winnerId = await this.redis.get(phoneKey(data.phone));
    if (!winnerId) throw new Error(`MockSyrveClient: індекс телефону ${data.phone} зник під час upsert`);
    await this.redis.hset(customerKey(winnerId), { name: data.name });
    return { id: winnerId };
  }

  async addToProgram(customerId: string): Promise<void> {
    const c = await this.mustRecord(customerId);
    await this.redis.hset(customerKey(c.id), { inProgram: '1' });
  }

  async addCard(customerId: string, cardNumber: string): Promise<void> {
    const c = await this.mustRecord(customerId);
    const index = cardKey(cardNumber);
    const owner = await this.redis.get(index);
    if (owner && owner !== c.id) throw cardOccupied();
    if (!owner && (await this.redis.set(index, c.id, 'NX')) !== 'OK') {
      const winner = await this.redis.get(index);
      if (winner !== c.id) throw cardOccupied();
    }
    await this.redis.sadd(cardsKey(c.id), cardNumber);
  }

  async topup(customerId: string, sum: number, comment = ''): Promise<void> {
    await this.changeBalance(customerId, sum, 'RefillWalletFromApi', comment);
  }

  // Как живой API: chargeoff сам не проверяет остаток и допускает минус.
  async chargeoff(customerId: string, sum: number, comment = ''): Promise<void> {
    await this.changeBalance(customerId, -sum, 'WithdrawWalletFromApi', comment);
  }

  async transactions(customerId: string, fromRevision: bigint): Promise<SyrveTransactionPage> {
    const c = await this.mustRecord(customerId);
    const all = (await this.redis.lrange(historyKey(c.id), 0, -1))
      .map(parseTransaction)
      .filter((t) => t.revision > fromRevision)
      // RPUSH разных процессов может завершиться не в порядке INCR — revision задаёт истинный порядок.
      .sort((a, b) => (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0));
    const transactions = all.slice(0, PAGE_SIZE);
    return {
      transactions,
      lastRevision: transactions.at(-1)?.revision ?? fromRevision,
      hasMore: transactions.length >= PAGE_SIZE,
    };
  }

  private async changeBalance(customerId: string, delta: number, type: string, comment: string) {
    const c = await this.mustRecord(customerId);
    const balanceAfter = Number(await this.redis.hincrbyfloat(customerKey(c.id), walletField(MOCK_WALLET_ID), delta));
    await this.recordTransaction(c.id, { type, sum: delta, walletId: MOCK_WALLET_ID, balanceAfter, comment });
  }

  private async recordTransaction(
    customerId: string,
    t: { type: string; sum: number; walletId: string | null; balanceAfter: number | null; comment: string },
  ) {
    const revision = String(await this.redis.incr(REVISION_KEY));
    const stored: StoredTransaction = {
      id: randomUUID(),
      revision,
      type: t.type,
      sum: t.sum,
      walletId: t.walletId,
      balanceAfter: t.balanceAfter,
      comment: t.comment || null,
      createdAt: new Date().toISOString(),
    };
    await this.redis.rpush(historyKey(customerId), JSON.stringify(stored));
  }

  private async record(id: string): Promise<MockCustomerRecord | null> {
    const record = (await this.redis.hgetall(customerKey(id.toLowerCase()))) as MockCustomerRecord;
    return record.id ? record : null;
  }

  private async mustRecord(id: string): Promise<MockCustomerRecord> {
    const record = await this.record(id);
    if (record) return record;
    throw new SyrveApiError(
      `Mock Syrve: гостя ${id} не знайдено`,
      '/api/1/loyalty/syrve/customer/info',
      400,
      'Customer_CustomerNotFound',
      null,
    );
  }

  private async toCustomer(c: MockCustomerRecord): Promise<SyrveCustomer> {
    const cards = await this.redis.smembers(cardsKey(c.id));
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      cards: cards.map((number) => ({ number, track: number })),
      balance: c.inProgram === '1' ? Number(c[walletField(MOCK_WALLET_ID)]) : null,
    };
  }
}

function customerKey(id: string) {
  return `${PREFIX}:customer:${id.toLowerCase()}`;
}

function phoneKey(phone: string) {
  return `${PREFIX}:phone:${phone}`;
}

function cardKey(card: string) {
  return `${PREFIX}:card:${card}`;
}

function cardsKey(id: string) {
  return `${customerKey(id)}:cards`;
}

function historyKey(id: string) {
  return `${customerKey(id)}:transactions`;
}

function walletField(id: string) {
  return `wallet:${id.toLowerCase()}`;
}

function parseTransaction(raw: string): SyrveTransaction {
  const stored = JSON.parse(raw) as StoredTransaction;
  return { ...stored, revision: BigInt(stored.revision) };
}

function cardOccupied() {
  return new SyrveApiError(
    'Mock Syrve: картку вже зайнято',
    '/api/1/loyalty/syrve/customer/card/add',
    400,
    'Card_AlreadyExists',
    null,
  );
}
