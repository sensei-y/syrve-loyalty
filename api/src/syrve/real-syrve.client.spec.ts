import { AppConfig } from '../config/config.schema';
import { RealSyrveClient } from './real-syrve.client';
import { SyrveApiError } from './syrve-api.error';

const ORG = '67018360-fb28-4d49-b4e0-391d83ec6c57';
const PROGRAM = '0eaa0000-29b3-b8cb-5653-08de79e05361';
const WALLET = '0eaa0000-29b3-b8cb-7be7-08de79e05361';

const cfg = {
  SYRVE_API_URL: 'https://syrve.test',
  SYRVE_API_LOGIN: 'test-login',
  SYRVE_ORGANIZATION_ID: ORG,
  SYRVE_PROGRAM_ID: PROGRAM,
  SYRVE_WALLET_ID: WALLET,
} as AppConfig;

const MIN = 60 * 1000;

type Handler = (auth: string | undefined, init: RequestInit) => Promise<Response> | Response;

function reply(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text } as Response;
}

// Подмена fetch по пути запроса. Токены выдаются по порядку: t1, t2, …
function mockSyrve(overrides: Record<string, Handler> = {}) {
  let tokens = 0;
  const handlers: Record<string, Handler> = {
    '/api/1/access_token': () => reply(200, { token: `t${++tokens}` }),
    '/api/1/organizations': () => reply(200, { organizations: [{ id: ORG, name: 'Демо В.С.', code: '1' }] }),
    '/api/1/loyalty/syrve/program': () =>
      reply(200, { Programs: [{ id: PROGRAM, name: 'Бонусная программа', walletId: WALLET, isActive: true }] }),
    ...overrides,
  };
  const spy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected ${path}`);
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    return handler(auth, init);
  });
  const calls = (path: string) => spy.mock.calls.filter(([url]) => String(url).endsWith(path)).length;
  return { spy, calls };
}

describe('RealSyrveClient', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-11-09T10:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('checkConnection повертає організацію, програму і гаманець', async () => {
    mockSyrve();
    await expect(new RealSyrveClient(cfg).checkConnection()).resolves.toEqual({
      organization: { id: ORG, name: 'Демо В.С.' },
      program: { id: PROGRAM, name: 'Бонусная программа', walletId: WALLET },
    });
  });

  it('кешує токен і не передає apiLogin у звичайні запити', async () => {
    const { spy, calls } = mockSyrve();
    const client = new RealSyrveClient(cfg);

    await client.checkConnection();
    jest.setSystemTime(Date.now() + 54 * MIN);
    await client.checkConnection();

    expect(calls('/access_token')).toBe(1);
    const orgCall = spy.mock.calls.find(([url]) => String(url).endsWith('/organizations'))!;
    expect((orgCall[1]!.headers as Record<string, string>).Authorization).toBe('Bearer t1');
    expect(String(orgCall[1]!.body)).not.toContain('test-login');
  });

  it('оновлює токен за 5 хвилин до закінчення', async () => {
    const { spy, calls } = mockSyrve();
    const client = new RealSyrveClient(cfg);

    await client.checkConnection();
    jest.setSystemTime(Date.now() + 55 * MIN + 1);
    await client.checkConnection();

    expect(calls('/access_token')).toBe(2);
    const lastOrgCall = spy.mock.calls.filter(([url]) => String(url).endsWith('/organizations')).pop()!;
    expect((lastOrgCall[1]!.headers as Record<string, string>).Authorization).toBe('Bearer t2');
  });

  it('паралельні виклики роблять один запит токена', async () => {
    const { calls } = mockSyrve();
    const client = new RealSyrveClient(cfg);

    await Promise.all([client.checkConnection(), client.checkConnection(), client.checkConnection()]);

    expect(calls('/access_token')).toBe(1);
  });

  it('паралельні виклики після закінчення токена оновлюють його один раз', async () => {
    const { spy, calls } = mockSyrve();
    const client = new RealSyrveClient(cfg);

    await client.checkConnection();
    jest.setSystemTime(Date.now() + 55 * MIN + 1);
    await Promise.all([client.checkConnection(), client.checkConnection(), client.checkConnection()]);

    expect(calls('/access_token')).toBe(2);
    const afterRefresh = spy.mock.calls.filter(([url]) => String(url).endsWith('/organizations')).slice(1);
    expect(afterRefresh).toHaveLength(3);
    for (const [, init] of afterRefresh) {
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer t2');
    }
  });

  it('після 401 бере новий токен і повторює запит один раз', async () => {
    const { calls } = mockSyrve({
      '/api/1/organizations': (auth) =>
        auth === 'Bearer t1'
          ? reply(401, {})
          : reply(200, { organizations: [{ id: ORG, name: 'Демо В.С.' }] }),
    });

    await expect(new RealSyrveClient(cfg).checkConnection()).resolves.toMatchObject({
      organization: { name: 'Демо В.С.' },
    });
    expect(calls('/access_token')).toBe(2);
    expect(calls('/organizations')).toBe(2);
  });

  it('повторний 401 не повторюється вдруге', async () => {
    const { calls } = mockSyrve({ '/api/1/organizations': () => reply(401, {}) });

    await expect(new RealSyrveClient(cfg).checkConnection()).rejects.toMatchObject({ httpStatus: 401 });
    expect(calls('/organizations')).toBe(2);
  });

  it('таймаут 15 с не повторюється', async () => {
    const { calls } = mockSyrve({
      '/api/1/organizations': (_auth, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });

    const result = new RealSyrveClient(cfg).checkConnection();
    const assertion = expect(result).rejects.toMatchObject({ errorCode: 'Timeout', httpStatus: null });
    await jest.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(calls('/organizations')).toBe(1);
  });

  it('мережева помилка не повторюється', async () => {
    const { calls } = mockSyrve({
      '/api/1/organizations': () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(new RealSyrveClient(cfg).checkConnection()).rejects.toMatchObject({ errorCode: 'NetworkError' });
    expect(calls('/organizations')).toBe(1);
  });

  it('помилка лояльності → SyrveApiError з errorCode', async () => {
    mockSyrve({
      '/api/1/organizations': () =>
        reply(400, {
          code: 'Transport_WrongCustomerNumber',
          errorCode: 'Validation_IncorrectPhone',
          message: 'There is no user with phone +380990000001',
          httpStatusCode: 400,
        }),
    });

    const error = await new RealSyrveClient(cfg).checkConnection().catch((e) => e);
    expect(error).toBeInstanceOf(SyrveApiError);
    expect(error).toMatchObject({
      httpStatus: 400,
      errorCode: 'Validation_IncorrectPhone',
      correlationId: null,
      path: '/api/1/organizations',
    });
  });

  it('загальна помилка Syrve → errorCode з error і correlationId', async () => {
    mockSyrve({
      '/api/1/organizations': () =>
        reply(400, { correlationId: 'corr-1', errorDescription: 'Bad organization', error: 'BAD_REQUEST' }),
    });

    await expect(new RealSyrveClient(cfg).checkConnection()).rejects.toMatchObject({
      httpStatus: 400,
      errorCode: 'BAD_REQUEST',
      correlationId: 'corr-1',
    });
  });

  // Живой Syrve повторяет apiLogin в errorDescription (см. docs/syrve-api-notes.md).
  it('помилка запиту токена не містить apiLogin, навіть якщо Syrve його повторює', async () => {
    mockSyrve({
      '/api/1/access_token': (_auth, init) => {
        const { apiLogin } = JSON.parse(String(init.body));
        return reply(401, { correlationId: 'corr-401', errorDescription: `Login ${apiLogin} is not authorized.` });
      },
    });

    const error = await new RealSyrveClient(cfg).checkConnection().catch((e) => e);
    expect(error).toBeInstanceOf(SyrveApiError);
    expect(error).toMatchObject({ httpStatus: 401, path: '/api/1/access_token', correlationId: 'corr-401' });
    expect(String(error.message)).not.toContain('test-login');
    expect(JSON.stringify(error)).not.toContain('test-login');
  });

  it('організацію не знайдено → зрозуміла помилка', async () => {
    mockSyrve({ '/api/1/organizations': () => reply(200, { organizations: [] }) });

    await expect(new RealSyrveClient(cfg).checkConnection()).rejects.toThrow('SYRVE_ORGANIZATION_ID');
  });

  it('програму не знайдено → зрозуміла помилка', async () => {
    mockSyrve({ '/api/1/loyalty/syrve/program': () => reply(200, { Programs: [] }) });

    await expect(new RealSyrveClient(cfg).checkConnection()).rejects.toThrow('SYRVE_PROGRAM_ID');
  });

  it('гаманець програми не збігається → зрозуміла помилка', async () => {
    mockSyrve({
      '/api/1/loyalty/syrve/program': () =>
        reply(200, { Programs: [{ id: PROGRAM, name: 'P', walletId: '00000000-0000-0000-0000-000000000001' }] }),
    });

    await expect(new RealSyrveClient(cfg).checkConnection()).rejects.toThrow('SYRVE_WALLET_ID');
  });
});

describe('RealSyrveClient: гості', () => {
  const OTHER_WALLET_1 = '0ba20000-29b3-b8cb-4481-08dd0f9b7994';
  const OTHER_WALLET_2 = '0eaa0000-29b3-b8cb-c92d-08de5f1082c1';
  const CUSTOMER_ID = '0eaa0000-29b3-b8cb-0844-08df3e3e3ed2';

  // Скорочена реальна відповідь customer/info (docs/syrve-api-notes.md): наш гаманець — не перший.
  const customerInfo = (walletBalances = [
    { id: OTHER_WALLET_1, name: 'Бонусная программа в зале', type: 1, balance: 0 },
    { id: WALLET, name: 'Бонусная программа в зале и в доставке', type: 1, balance: -400 },
    { id: OTHER_WALLET_2, name: 'Бонусная программа доставка', type: 1, balance: 15 },
  ]) => ({
    id: CUSTOMER_ID,
    name: 'Тест',
    phone: '+380990000001',
    cards: [{ id: 'c1', track: '100001', number: '100001', validToDate: null }],
    walletBalances,
  });

  afterEach(() => jest.restoreAllMocks());

  const bodyOf = (spy: jest.SpyInstance, path: string) =>
    JSON.parse(String(spy.mock.calls.find(([url]) => String(url).endsWith(path))![1]!.body));

  it('баланс береться з гаманця SYRVE_WALLET_ID, а не з першого', async () => {
    mockSyrve({ '/api/1/loyalty/syrve/customer/info': () => reply(200, customerInfo()) });

    await expect(new RealSyrveClient(cfg).findCustomer({ phone: '+380990000001' })).resolves.toEqual({
      id: CUSTOMER_ID,
      name: 'Тест',
      phone: '+380990000001',
      cards: [{ number: '100001', track: '100001' }],
      balance: -400,
    });
  });

  it('нашого гаманця немає → balance: null', async () => {
    mockSyrve({
      '/api/1/loyalty/syrve/customer/info': () =>
        reply(200, customerInfo([{ id: OTHER_WALLET_1, name: 'x', type: 1, balance: 50 }])),
    });

    await expect(new RealSyrveClient(cfg).findCustomer({ id: CUSTOMER_ID })).resolves.toMatchObject({ balance: null });
  });

  it.each([
    ['phone', { phone: '+380990000002' }, 'Transport_WrongCustomerNumber', 'Validation_IncorrectPhone'],
    ['cardNumber', { cardNumber: '9520894156' }, 'Transport_WrongCardNumber', 'Card_CanNotFindByNumber'],
    ['id', { id: '00000000-0000-0000-0000-0000000000a1' }, 'Transport_WrongCustomerId', 'Customer_CustomerNotFound'],
  ])('«не знайдено» за %s → null', async (type, query, code, errorCode) => {
    const { spy } = mockSyrve({
      '/api/1/loyalty/syrve/customer/info': () =>
        reply(400, { code, errorCode, message: 'There is no user', httpStatusCode: 400 }),
    });

    await expect(new RealSyrveClient(cfg).findCustomer(query as never)).resolves.toBeNull();
    expect(bodyOf(spy, '/customer/info')).toEqual({ organizationId: ORG, type, ...query });
  });

  it('інша помилка 400 не ковтається', async () => {
    mockSyrve({
      '/api/1/loyalty/syrve/customer/info': () =>
        reply(400, { correlationId: 'corr-2', errorDescription: 'Bad request' }),
    });

    await expect(new RealSyrveClient(cfg).findCustomer({ phone: '+380990000001' })).rejects.toMatchObject({
      httpStatus: 400,
      correlationId: 'corr-2',
    });
  });

  it('код «не знайдено» іншого типу пошуку не перетворюється на null', async () => {
    mockSyrve({
      '/api/1/loyalty/syrve/customer/info': () =>
        reply(400, { errorCode: 'Card_CanNotFindByNumber', message: 'There is no user', httpStatusCode: 400 }),
    });

    await expect(new RealSyrveClient(cfg).findCustomer({ phone: '+380990000001' })).rejects.toBeInstanceOf(
      SyrveApiError,
    );
  });

  it('upsertCustomer, addToProgram, addCard шлють тіла як у живому API', async () => {
    const { spy } = mockSyrve({
      '/api/1/loyalty/syrve/customer/create_or_update': () => reply(200, { id: CUSTOMER_ID }),
      '/api/1/loyalty/syrve/customer/program/add': () => reply(200, { userWalletId: 'uw', walletId: WALLET }),
      '/api/1/loyalty/syrve/customer/card/add': () => reply(200, {}),
    });
    const client = new RealSyrveClient(cfg);

    await expect(client.upsertCustomer({ phone: '+380990000001', name: 'Тест' })).resolves.toEqual({ id: CUSTOMER_ID });
    await client.addToProgram(CUSTOMER_ID);
    await client.addCard(CUSTOMER_ID, '1234567890');

    expect(bodyOf(spy, '/create_or_update')).toEqual({ organizationId: ORG, phone: '+380990000001', name: 'Тест' });
    expect(bodyOf(spy, '/program/add')).toEqual({ organizationId: ORG, customerId: CUSTOMER_ID, programId: PROGRAM });
    expect(bodyOf(spy, '/card/add')).toEqual({
      organizationId: ORG,
      customerId: CUSTOMER_ID,
      cardTrack: '1234567890',
      cardNumber: '1234567890',
    });
  });
});
