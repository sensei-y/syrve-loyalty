import { AppConfig } from '../config/config.schema';
import { SyrveApiError } from './syrve-api.error';
import {
  SyrveClient,
  SyrveConnectionInfo,
  SyrveCustomer,
  SyrveCustomerQuery,
  SyrveTransactionPage,
} from './syrve-client.interface';

const TOKEN_TTL_MS = 60 * 60 * 1000; // Syrve: токен живёт 1 час
const TOKEN_REFRESH_BEFORE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

// errorCode ответа 400 «гостя не найдено» для каждого типа поиска (проверено на живом API).
const NOT_FOUND_CODE = {
  phone: 'Validation_IncorrectPhone',
  cardNumber: 'Card_CanNotFindByNumber',
  id: 'Customer_CustomerNotFound',
} as const;

interface RawResponse {
  status: number;
  body: unknown; // null — тело не JSON
}

// Поля customer/info, которые мы используем (полный ответ — в docs/syrve-api-notes.md).
interface RawCustomer {
  id: string;
  name?: string | null;
  phone?: string | null;
  cards?: { number: string; track: string }[] | null;
  walletBalances?: { id: string; balance: number }[] | null;
}

// Клиент живого Syrve Cloud API. Сам не логирует: ожидаемые ошибки (например, «гостя не найдено»)
// решает вызывающий код. apiLogin и токен не попадают ни в логи, ни в тексты ошибок.
export class RealSyrveClient implements SyrveClient {
  private readonly baseUrl: string;
  private readonly apiLogin: string;
  private readonly organizationId: string;
  private readonly programId: string;
  private readonly walletId: string;

  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(cfg: AppConfig) {
    this.baseUrl = cfg.SYRVE_API_URL.replace(/\/+$/, '');
    this.apiLogin = required(cfg.SYRVE_API_LOGIN, 'SYRVE_API_LOGIN');
    this.organizationId = required(cfg.SYRVE_ORGANIZATION_ID, 'SYRVE_ORGANIZATION_ID');
    this.programId = required(cfg.SYRVE_PROGRAM_ID, 'SYRVE_PROGRAM_ID');
    this.walletId = required(cfg.SYRVE_WALLET_ID, 'SYRVE_WALLET_ID');
  }

  async checkConnection(): Promise<SyrveConnectionInfo> {
    const { organizations = [] } = await this.post<{ organizations?: { id: string; name: string }[] }>(
      '/api/1/organizations',
      {},
    );
    const org = organizations.find((o) => sameId(o.id, this.organizationId));
    if (!org) {
      throw new Error(`Організацію ${this.organizationId} не знайдено в Syrve — перевірте SYRVE_ORGANIZATION_ID`);
    }

    // Ключ Programs — с большой буквы (см. docs/syrve-api-notes.md).
    const { Programs = [] } = await this.post<{ Programs?: { id: string; name: string; walletId: string }[] }>(
      '/api/1/loyalty/syrve/program',
      { organizationId: this.organizationId },
    );
    const program = Programs.find((p) => sameId(p.id, this.programId));
    if (!program) {
      throw new Error(`Програму ${this.programId} не знайдено в організації — перевірте SYRVE_PROGRAM_ID`);
    }
    if (!sameId(program.walletId, this.walletId)) {
      throw new Error(
        `Гаманець програми (${program.walletId}) не збігається з SYRVE_WALLET_ID (${this.walletId})`,
      );
    }

    return {
      organization: { id: org.id, name: org.name },
      program: { id: program.id, name: program.name, walletId: program.walletId },
    };
  }

  async findCustomer(q: SyrveCustomerQuery): Promise<SyrveCustomer | null> {
    const [type, value] = Object.entries(q)[0] as [keyof typeof NOT_FOUND_CODE, string];
    try {
      const raw = await this.post<RawCustomer>('/api/1/loyalty/syrve/customer/info', {
        organizationId: this.organizationId,
        type,
        [type]: value,
      });
      return this.toCustomer(raw);
    } catch (e) {
      // «Не найдено» — HTTP 400 со своим кодом для каждого типа поиска; остальные 400 — настоящие ошибки.
      if (e instanceof SyrveApiError && e.httpStatus === 400 && e.errorCode === NOT_FOUND_CODE[type]) return null;
      throw e;
    }
  }

  async upsertCustomer(data: { phone: string; name: string }): Promise<{ id: string }> {
    const path = '/api/1/loyalty/syrve/customer/create_or_update';
    const { id } = await this.post<{ id?: unknown }>(path, { organizationId: this.organizationId, ...data });
    if (typeof id !== 'string' || !id) {
      throw new SyrveApiError(`Syrve ${path}: відповідь без id`, path, 200, 'InvalidResponse', null);
    }
    return { id };
  }

  async addToProgram(customerId: string): Promise<void> {
    await this.post('/api/1/loyalty/syrve/customer/program/add', {
      organizationId: this.organizationId,
      customerId,
      programId: this.programId,
    });
  }

  async addCard(customerId: string, cardNumber: string): Promise<void> {
    // track = номер: так заведены карты в организации (docs/syrve-api-notes.md).
    await this.post('/api/1/loyalty/syrve/customer/card/add', {
      organizationId: this.organizationId,
      customerId,
      cardTrack: cardNumber,
      cardNumber,
    });
  }

  // Только наш кошелёк. Без повторов при таймауте (см. post()): операция могла примениться.
  async topup(customerId: string, sum: number, comment: string): Promise<void> {
    await this.post('/api/1/loyalty/syrve/customer/wallet/topup', this.walletBody(customerId, sum, comment));
  }

  // Syrve пускает в минус — баланс проверяет вызывающий код до chargeoff.
  async chargeoff(customerId: string, sum: number, comment: string): Promise<void> {
    await this.post('/api/1/loyalty/syrve/customer/wallet/chargeoff', this.walletBody(customerId, sum, comment));
  }

  private walletBody(customerId: string, sum: number, comment: string) {
    return { organizationId: this.organizationId, customerId, walletId: this.walletId, sum, comment };
  }

  private notImplemented(): never {
    throw new Error('RealSyrveClient: ще не реалізовано (О6)');
  }

  transactions(): Promise<SyrveTransactionPage> { return this.notImplemented(); }

  private toCustomer(raw: RawCustomer): SyrveCustomer {
    const wallet = (raw.walletBalances ?? []).find((w) => sameId(w.id, this.walletId));
    return {
      id: raw.id,
      name: raw.name ?? '',
      phone: raw.phone ?? '',
      cards: (raw.cards ?? []).map((c) => ({ number: c.number, track: c.track })),
      balance: wallet ? wallet.balance : null,
    };
  }

  // Единственная точка вызова методов Syrve.
  // Повтор — только после 401 и только один раз. Таймаут и сетевые ошибки не повторяются:
  // для topup/chargeoff неизвестно, дошёл ли запрос, повтор может задвоить операцию.
  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.getToken();
    let res = await this.send(path, body, token);
    if (res.status === 401) {
      this.invalidateToken(token);
      res = await this.send(path, body, await this.getToken());
    }
    return this.unwrap<T>(path, res);
  }

  // Параллельные вызовы ждут один общий запрос токена.
  private getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - TOKEN_REFRESH_BEFORE_MS) {
      return Promise.resolve(this.token.value);
    }
    this.tokenRequest ??= this.requestToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async requestToken(): Promise<string> {
    const path = '/api/1/access_token';
    const res = await this.send(path, { apiLogin: this.apiLogin });
    let token: unknown;
    try {
      ({ token } = this.unwrap<{ token?: unknown }>(path, res));
    } catch (e) {
      // Syrve повторяет apiLogin в errorDescription («Login <apiLogin> is not authorized») —
      // текст ответа не берём, оставляем только статус и correlationId.
      const err = e as SyrveApiError;
      throw new SyrveApiError(
        `Syrve ${path}: токен не отримано (HTTP ${err.httpStatus}), перевірте SYRVE_API_LOGIN`,
        path,
        err.httpStatus,
        err.errorCode,
        err.correlationId,
      );
    }
    if (typeof token !== 'string' || !token) {
      throw new SyrveApiError('Syrve не повернув токен', path, 200, 'InvalidResponse', null);
    }
    this.token = { value: token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token;
  }

  // Сбрасываем только тот токен, с которым получили 401: если его уже обновил
  // параллельный запрос, повторно не запрашиваем.
  private invalidateToken(used: string) {
    if (this.token?.value === used) this.token = null;
  }

  private async send(path: string, body: unknown, token?: string): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, body: parseJson(text) };
    } catch (e) {
      if (controller.signal.aborted) {
        throw new SyrveApiError(`Syrve ${path}: таймаут ${REQUEST_TIMEOUT_MS} мс`, path, null, 'Timeout', null);
      }
      throw new SyrveApiError(`Syrve ${path}: мережева помилка (${(e as Error).message})`, path, null, 'NetworkError', null);
    } finally {
      clearTimeout(timer);
    }
  }

  private unwrap<T>(path: string, res: RawResponse): T {
    if (res.status >= 200 && res.status < 300) {
      if (res.body === null) {
        throw new SyrveApiError(`Syrve ${path}: відповідь не JSON`, path, res.status, 'InvalidResponse', null);
      }
      return res.body as T;
    }
    // Форматы ошибок Syrve отличаются: у лояльности { code, errorCode, message },
    // у остальных методов { correlationId, errorDescription, error }.
    const b = (typeof res.body === 'object' && res.body !== null ? res.body : {}) as Record<string, unknown>;
    const errorCode = str(b.errorCode) ?? str(b.error) ?? str(b.code);
    const message = str(b.message) ?? str(b.errorDescription) ?? `HTTP ${res.status}`;
    throw new SyrveApiError(`Syrve ${path}: ${message}`, path, res.status, errorCode, str(b.correlationId));
  }
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function sameId(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`SYRVE_MODE=real потребує ${name}`);
  return value;
}
