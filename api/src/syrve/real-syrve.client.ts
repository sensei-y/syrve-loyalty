import { AppConfig } from '../config/config.schema';
import { SyrveClient } from './syrve-client.interface';

// Этап 1: токен (apiLogin → access_token, кэш ~1 час), вызовы API, обработка ошибок с correlationId.
export class RealSyrveClient implements SyrveClient {
  constructor(private readonly cfg: AppConfig) {}

  private notImplemented(): never {
    throw new Error('RealSyrveClient: ще не реалізовано (етап 1)');
  }

  checkConnection() { return this.notImplemented(); }
  findCustomer() { return this.notImplemented(); }
  createCustomer() { return this.notImplemented(); }
  getBalance() { return this.notImplemented(); }
  topup() { return this.notImplemented(); }
  chargeoff() { return this.notImplemented(); }
  transactions() { return this.notImplemented(); }
}
