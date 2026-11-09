// Ошибка вызова Syrve. Поля — для логов (correlationId) и для решений вызывающего кода (errorCode).
// httpStatus = null — ответа не было (таймаут или сеть).
export class SyrveApiError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly httpStatus: number | null,
    readonly errorCode: string | null,
    readonly correlationId: string | null,
  ) {
    super(message);
    this.name = 'SyrveApiError';
  }
}

// Строка для лога: у ошибок Syrve — поля с correlationId, без текста ответа
// (в нём бывают телефоны гостей); у остальных — message.
export function describeError(e: unknown): string {
  if (e instanceof SyrveApiError) {
    return `Syrve path=${e.path} httpStatus=${e.httpStatus} errorCode=${e.errorCode} correlationId=${e.correlationId}`;
  }
  return e instanceof Error ? e.message : String(e);
}
