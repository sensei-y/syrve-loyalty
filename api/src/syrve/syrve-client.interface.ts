// Контракт работы с Syrve. Остальной код знает только этот интерфейс.
// Методы повторяют реальные вызовы API (docs/syrve-api-notes.md): регистрация — это
// upsertCustomer → addToProgram → addCard, и сервис делает их явно.

export const SYRVE_CLIENT = Symbol('SYRVE_CLIENT');

export interface SyrveCard {
  number: string;
  track: string;
}

export interface SyrveCustomer {
  id: string;
  name: string;
  phone: string;
  cards: SyrveCard[];
  // Баланс кошелька SYRVE_WALLET_ID. null — такого кошелька у гостя нет (гость не в программе).
  balance: number | null;
}

export type SyrveCustomerQuery = { phone: string } | { cardNumber: string } | { id: string };

export interface SyrveTransaction {
  id: string;
  revision: bigint;
  type: string; // typeName
  sum: number; // со знаком: + начисление, − списание
  walletId: string | null; // null у служебных записей
  balanceAfter: number | null;
  comment: string | null;
  createdAt: string;
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
  // null — только «гостя не найдено»; остальные ошибки пробрасываются.
  findCustomer(q: SyrveCustomerQuery): Promise<SyrveCustomer | null>;
  // create_or_update: upsert по телефону, может перезаписать имя. Возвращает только id.
  upsertCustomer(data: { phone: string; name: string }): Promise<{ id: string }>;
  // Повтор для гостя, уже состоящего в программе, безопасен (проверено на живом API).
  addToProgram(customerId: string): Promise<void>;
  addCard(customerId: string, cardNumber: string): Promise<void>;
  topup(customerId: string, sum: number, comment: string): Promise<void>;
  chargeoff(customerId: string, sum: number, comment: string): Promise<void>;
  transactions(customerId: string, fromRevision: bigint): Promise<SyrveTransactionPage>;
}
