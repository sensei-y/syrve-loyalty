import { FakeRedis } from './fake-redis.test-helper';
import { programWalletId } from '../loyalty/balance-change';
import {
  MOCK_ORGANIZATION_ID,
  MOCK_OTHER_WALLET_IDS,
  MOCK_PROGRAM_ID,
  MOCK_WALLET_ID,
  MockSyrveClient,
} from './mock-syrve.client';
import { SyrveApiError } from './syrve-api.error';

const PHONE = '+380991234567';

describe('MockSyrveClient: Redis-backed demo', () => {
  it('mock завжди використовує фіксований wallet id, навіть якщо в .env лишився real id', () => {
    expect(programWalletId({ SYRVE_MODE: 'mock', SYRVE_WALLET_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })).toBe(
      MOCK_WALLET_ID,
    );
  });

  it('два екземпляри (api / worker) бачать спільного гостя, картку і баланс', async () => {
    const redis = new FakeRedis();
    const api = new MockSyrveClient(redis);
    const worker = new MockSyrveClient(redis);
    const { id } = await worker.upsertCustomer({ phone: PHONE, name: 'Олена' });
    await worker.addToProgram(id);
    await worker.addCard(id, '1234567890');
    await api.topup(id, 7, 'Панель');

    await expect(api.findCustomer({ phone: PHONE })).resolves.toMatchObject({ id, balance: 7 });
    await expect(worker.findCustomer({ cardNumber: '1234567890' })).resolves.toMatchObject({
      id,
      cards: [{ number: '1234567890', track: '1234567890' }],
      balance: 7,
    });
  });

  it('фіксовані id, три гаманці; сервіс повертає баланс лише гаманця програми', async () => {
    const redis = new FakeRedis();
    const client = new MockSyrveClient(redis);
    await expect(client.checkConnection()).resolves.toEqual({
      organization: { id: MOCK_ORGANIZATION_ID, name: 'Mock organization' },
      program: { id: MOCK_PROGRAM_ID, name: 'Mock loyalty program', walletId: MOCK_WALLET_ID },
    });
    const { id } = await client.upsertCustomer({ phone: PHONE, name: 'Олена' });
    await client.addToProgram(id);

    const customerHash = [...redis.hashes.values()].find((h) => h.get('id') === id)!;
    const walletFields = [...customerHash.keys()].filter((key) => key.startsWith('wallet:'));
    expect(walletFields).toHaveLength(3);
    expect(walletFields).toEqual(expect.arrayContaining([`wallet:${MOCK_WALLET_ID}`, ...MOCK_OTHER_WALLET_IDS.map((x) => `wallet:${x}`)]));
    await expect(client.findCustomer({ id })).resolves.toMatchObject({ balance: 0 });
  });

  it('findCustomer: відсутній телефон → null, як RealSyrveClient після HTTP 400 Validation_IncorrectPhone', async () => {
    const client = new MockSyrveClient(new FakeRedis());
    await expect(client.findCustomer({ phone: PHONE })).resolves.toBeNull();
  });

  it('паралельний upsert за телефоном через SET NX → один гість; повтор перезаписує імʼя', async () => {
    const redis = new FakeRedis();
    const a = new MockSyrveClient(redis);
    const b = new MockSyrveClient(redis);
    const [first, second] = await Promise.all([
      a.upsertCustomer({ phone: PHONE, name: 'Перша' }),
      b.upsertCustomer({ phone: PHONE, name: 'Друга' }),
    ]);

    expect(first.id).toBe(second.id);
    await a.upsertCustomer({ phone: PHONE, name: 'Остаточне імʼя' });
    await expect(b.findCustomer({ phone: PHONE })).resolves.toMatchObject({ id: first.id, name: 'Остаточне імʼя' });
  });

  it('повтор addToProgram безпечний; chargeoff допускає мінус', async () => {
    const client = new MockSyrveClient(new FakeRedis());
    const { id } = await client.upsertCustomer({ phone: PHONE, name: 'Олена' });
    await client.addToProgram(id);
    await client.addToProgram(id);
    await client.chargeoff(id, 5, 'Тест мінуса');

    await expect(client.findCustomer({ id })).resolves.toMatchObject({ balance: -5 });
  });

  it('новий гість має SetGuestCategory; by_revision — межа не включається', async () => {
    const client = new MockSyrveClient(new FakeRedis());
    const { id } = await client.upsertCustomer({ phone: PHONE, name: 'Олена' });
    const first = await client.transactions(id, 0n);

    expect(first.transactions).toHaveLength(1);
    expect(first.transactions[0]).toMatchObject({ type: 'SetGuestCategory', sum: 0, walletId: null });
    await expect(client.transactions(id, first.lastRevision)).resolves.toEqual({
      transactions: [],
      lastRevision: first.lastRevision,
      hasMore: false,
    });
  });

  it('INCR дає унікальні revision, HINCRBYFLOAT — коректний balanceAfter; сторінка 50', async () => {
    const redis = new FakeRedis();
    const a = new MockSyrveClient(redis);
    const b = new MockSyrveClient(redis);
    const { id } = await a.upsertCustomer({ phone: PHONE, name: 'Олена' });
    await a.addToProgram(id);
    await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).topup(id, 1, `#${i}`)));

    const page1 = await a.transactions(id, 0n);
    const page2 = await b.transactions(id, page1.lastRevision);
    const all = [...page1.transactions, ...page2.transactions];
    expect(page1).toMatchObject({ hasMore: true });
    expect(page1.transactions).toHaveLength(50);
    expect(all).toHaveLength(61); // SetGuestCategory + 60 поповнень
    expect(new Set(all.map((t) => t.revision.toString())).size).toBe(61);
    expect(all.map((t) => t.revision)).toEqual([...all.map((t) => t.revision)].sort((x, y) => (x < y ? -1 : 1)));
    expect(all.filter((t) => t.sum === 1).map((t) => t.balanceAfter).sort((x, y) => Number(x) - Number(y))).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
    await expect(a.findCustomer({ id })).resolves.toMatchObject({ balance: 60 });
  });

  it('одна картка не може належати двом гостям', async () => {
    const client = new MockSyrveClient(new FakeRedis());
    const a = await client.upsertCustomer({ phone: PHONE, name: 'А' });
    const b = await client.upsertCustomer({ phone: '+380991234568', name: 'Б' });
    await client.addCard(a.id, '1234567890');

    const error = await client.addCard(b.id, '1234567890').catch((e) => e);
    expect(error).toBeInstanceOf(SyrveApiError);
    expect(error).toMatchObject({ httpStatus: 400, errorCode: 'Card_AlreadyExists' });
  });
});
