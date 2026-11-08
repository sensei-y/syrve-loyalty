import { SyrveClient } from './syrve-client.interface';

// Mock для работы без доступа к Syrve. Наполняется по мере этапов,
// поведение повторяет живой API (в т.ч. списание в минус не блокируется).
export class MockSyrveClient implements SyrveClient {
  async checkConnection() {
    return {
      organization: { id: 'mock-org', name: 'Mock organization' },
      program: { id: 'mock-program', name: 'Mock program', walletId: 'mock-wallet' },
    };
  }

  private notImplemented(): never {
    throw new Error('MockSyrveClient: ще не реалізовано');
  }

  findCustomer() { return this.notImplemented(); }
  createCustomer() { return this.notImplemented(); }
  getBalance() { return this.notImplemented(); }
  topup() { return this.notImplemented(); }
  chargeoff() { return this.notImplemented(); }
  transactions() { return this.notImplemented(); }
}
