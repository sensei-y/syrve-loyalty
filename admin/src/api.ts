// Вызовы API. Тот же origin (nginx / vite proxy) — cookie сессии уходит сама, CORS не нужен.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError("Немає зв'язку з сервером", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.message;
    throw new ApiError(Array.isArray(message) ? message.join('; ') : message || `Помилка ${res.status}`, res.status);
  }
  return data as T;
}

export interface GuestProfile {
  syrveCustomerId: string;
  name: string;
  phone: string;
  cards: string[];
  balance: number | null;
  linkedToBot: boolean;
}

export type OpType = 'TOPUP' | 'CHARGEOFF';
export type OpStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'UNKNOWN';

export interface Operation {
  id: string;
  type: OpType;
  amount: number;
  reason: string;
  status: OpStatus;
  error: string | null;
  admin: string;
  createdAt: string;
}

// Ключ идемпотентности формы. randomUUID есть только в secure context (https / localhost) — иначе запасной вариант.
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
