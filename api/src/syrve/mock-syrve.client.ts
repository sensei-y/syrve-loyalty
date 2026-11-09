import { randomUUID } from 'node:crypto';
import {
  SyrveClient,
  SyrveCustomer,
  SyrveCustomerQuery,
  SyrveTransaction,
  SyrveTransactionPage,
} from './syrve-client.interface';

// Кошелёк программы в mock-режиме, если SYRVE_WALLET_ID не задан.
export const MOCK_WALLET_ID = 'mock-wallet';
const PAGE_SIZE = 50;

interface MockCustomer {
  id: string;
  name: string;
  phone: string;
  cards: string[];
  inProgram: boolean;
  balance: number;
  history: SyrveTransaction[];
}

// Mock для работы без доступа к Syrve: гости и их история в памяти процесса.
// Поведение повторяет живой API: upsert по телефону перезаписывает имя, повтор addToProgram безопасен,
// id в любом регистре, by_revision отдаёт revision > fromRevision, у нового гостя — служебная запись.
export class MockSyrveClient implements SyrveClient {
  private readonly customers = new Map<string, MockCustomer>();
  private revision = 1000n; // общая для организации, как в Syrve

  constructor(private readonly walletId: string = MOCK_WALLET_ID) {}

  async checkConnection() {
    return {
      organization: { id: 'mock-org', name: 'Mock organization' },
      program: { id: 'mock-program', name: 'Mock program', walletId: this.walletId },
    };
  }

  async findCustomer(q: SyrveCustomerQuery): Promise<SyrveCustomer | null> {
    const found = [...this.customers.values()].find((c) =>
      'phone' in q ? c.phone === q.phone : 'cardNumber' in q ? c.cards.includes(q.cardNumber) : c.id === q.id.toLowerCase(),
    );
    return found ? toCustomer(found) : null;
  }

  async upsertCustomer(data: { phone: string; name: string }): Promise<{ id: string }> {
    const existing = [...this.customers.values()].find((c) => c.phone === data.phone);
    if (existing) {
      existing.name = data.name;
      return { id: existing.id };
    }
    const customer: MockCustomer = { id: randomUUID(), ...data, cards: [], inProgram: false, balance: 0, history: [] };
    this.customers.set(customer.id, customer);
    // Как в живом API: новому гостю назначается категория — служебная запись без суммы и кошелька.
    this.record(customer, { type: 'SetGuestCategory', sum: 0, walletId: null, balanceAfter: null });
    return { id: customer.id };
  }

  async addToProgram(customerId: string): Promise<void> {
    this.get(customerId).inProgram = true;
  }

  async addCard(customerId: string, cardNumber: string): Promise<void> {
    this.get(customerId).cards.push(cardNumber);
  }

  async topup(customerId: string, sum: number, comment = ''): Promise<void> {
    const c = this.get(customerId);
    c.balance += sum;
    this.record(c, { type: 'RefillWalletFromApi', sum, walletId: this.walletId, balanceAfter: c.balance, comment });
  }

  // Как живой API: в минус пускает, проверка баланса — на стороне вызывающего.
  async chargeoff(customerId: string, sum: number, comment = ''): Promise<void> {
    const c = this.get(customerId);
    c.balance -= sum;
    this.record(c, { type: 'WithdrawWalletFromApi', sum: -sum, walletId: this.walletId, balanceAfter: c.balance, comment });
  }

  async transactions(customerId: string, fromRevision: bigint): Promise<SyrveTransactionPage> {
    const transactions = this.get(customerId)
      .history.filter((t) => t.revision > fromRevision)
      .slice(0, PAGE_SIZE);
    return {
      transactions,
      lastRevision: transactions.at(-1)?.revision ?? fromRevision,
      hasMore: transactions.length >= PAGE_SIZE,
    };
  }

  private get(customerId: string): MockCustomer {
    const c = this.customers.get(customerId.toLowerCase()); // как живой Syrve: id в любом регистре
    if (!c) throw new Error(`MockSyrveClient: гостя ${customerId} немає`);
    return c;
  }

  private record(
    c: MockCustomer,
    t: { type: string; sum: number; walletId: string | null; balanceAfter: number | null; comment?: string },
  ) {
    this.revision += 10n;
    c.history.push({
      id: randomUUID(),
      revision: this.revision,
      comment: t.comment ?? null,
      createdAt: new Date().toISOString(),
      type: t.type,
      sum: t.sum,
      walletId: t.walletId,
      balanceAfter: t.balanceAfter,
    });
  }
}

function toCustomer(c: MockCustomer): SyrveCustomer {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    cards: c.cards.map((number) => ({ number, track: number })),
    balance: c.inProgram ? c.balance : null,
  };
}
