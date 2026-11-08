// Контракт работы с Syrve. Остальной код знает только этот интерфейс.
// Поля типов — предварительные: сверить с реальными ответами (docs/api-samples/) на этапе 1.

export const SYRVE_CLIENT = Symbol('SYRVE_CLIENT');

export interface SyrveCustomer {
  id: string;
  name: string;
  phone: string;
  cardNumber: string | null;
}

export interface NewSyrveCustomer {
  name: string;
  phone: string;
}

export interface SyrveTransaction {
  id: string;
  revision: bigint;
  sum: number; // знак суммы: + начисление, − списание
  balanceAfter: number;
  createdAt: string;
  comment: string | null;
}

export interface SyrveTransactionPage {
  transactions: SyrveTransaction[];
  lastRevision: bigint;
}

export interface SyrveConnectionInfo {
  organization: { id: string; name: string };
  program: { id: string; name: string; walletId: string };
}

export interface SyrveClient {
  checkConnection(): Promise<SyrveConnectionInfo>;
  findCustomer(q: { phone?: string; cardNumber?: string; id?: string }): Promise<SyrveCustomer | null>;
  createCustomer(data: NewSyrveCustomer): Promise<SyrveCustomer>;
  getBalance(customerId: string): Promise<number>;
  topup(customerId: string, sum: number, comment: string): Promise<void>;
  chargeoff(customerId: string, sum: number, comment: string): Promise<void>;
  transactions(customerId: string, fromRevision: bigint): Promise<SyrveTransactionPage>;
}
