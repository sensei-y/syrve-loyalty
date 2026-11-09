import { randomUUID } from 'node:crypto';
import {
  SyrveClient,
  SyrveCustomer,
  SyrveCustomerQuery,
  SyrveTransactionPage,
} from './syrve-client.interface';

interface MockCustomer {
  id: string;
  name: string;
  phone: string;
  cards: string[];
  inProgram: boolean;
  balance: number;
}

// Mock для работы без доступа к Syrve: гости в памяти процесса.
// Поведение повторяет живой API: upsert по телефону перезаписывает имя, повтор addToProgram безопасен.
export class MockSyrveClient implements SyrveClient {
  private readonly customers = new Map<string, MockCustomer>();

  async checkConnection() {
    return {
      organization: { id: 'mock-org', name: 'Mock organization' },
      program: { id: 'mock-program', name: 'Mock program', walletId: 'mock-wallet' },
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
    const customer: MockCustomer = { id: randomUUID(), ...data, cards: [], inProgram: false, balance: 0 };
    this.customers.set(customer.id, customer);
    return { id: customer.id };
  }

  async addToProgram(customerId: string): Promise<void> {
    this.get(customerId).inProgram = true;
  }

  async addCard(customerId: string, cardNumber: string): Promise<void> {
    this.get(customerId).cards.push(cardNumber);
  }

  private get(customerId: string): MockCustomer {
    const c = this.customers.get(customerId.toLowerCase()); // как живой Syrve: id в любом регистре
    if (!c) throw new Error(`MockSyrveClient: гостя ${customerId} немає`);
    return c;
  }

  async topup(customerId: string, sum: number): Promise<void> {
    this.get(customerId).balance += sum;
  }

  // Как живой API: в минус пускает, проверка баланса — на стороне вызывающего.
  async chargeoff(customerId: string, sum: number): Promise<void> {
    this.get(customerId).balance -= sum;
  }

  private notImplemented(): never {
    throw new Error('MockSyrveClient: ще не реалізовано (О6)');
  }

  transactions(): Promise<SyrveTransactionPage> { return this.notImplemented(); }
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
