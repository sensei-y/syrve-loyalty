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
