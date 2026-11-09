import { Inject, Injectable, Logger } from '@nestjs/common';
import { Guest } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import { SYRVE_CLIENT, SyrveClient, SyrveCustomer } from '../syrve/syrve-client.interface';

const CARD_NUMBER_ATTEMPTS = 5;

export interface GuestCard {
  name: string;
  cardNumber: string;
  balance: number;
}

export type ContactResult =
  | { kind: 'invalidPhone' }
  | { kind: 'needName'; phone: string } // гостя в Syrve нет — спросить имя
  | { kind: 'registered'; card: GuestCard };

// Регистрация через бота и данные карты. Источник правды по гостю, карте и балансу — Syrve;
// у нас — только привязка Telegram ↔ Syrve (таблица Guest).
@Injectable()
export class GuestsService {
  private readonly logger = new Logger(GuestsService.name);
  // Двойное нажатие / повтор сообщения: второй вызов ждёт первый, иначе две карты.
  private readonly inFlight = new Map<string, Promise<GuestCard>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SYRVE_CLIENT) private readonly syrve: SyrveClient,
  ) {}

  findByTelegramId(telegramId: bigint): Promise<Guest | null> {
    return this.prisma.guest.findUnique({ where: { telegramId } });
  }

  // Шаг после контакта. Гость уже есть в Syrve — регистрируем сразу с его именем
  // (имя не спрашиваем и не перезаписываем); нет — нужно имя.
  async handleContact(telegramId: bigint, rawPhone: string): Promise<ContactResult> {
    const phone = normalizePhone(rawPhone);
    if (!phone) return { kind: 'invalidPhone' };
    if (!(await this.findByTelegramId(telegramId)) && !(await this.syrve.findCustomer({ phone }))) {
      return { kind: 'needName', phone };
    }
    return { kind: 'registered', card: await this.register(telegramId, phone) };
  }

  register(telegramId: bigint, phone: string, name?: string): Promise<GuestCard> {
    const key = telegramId.toString();
    const running = this.inFlight.get(key);
    if (running) return running;
    const job = this.doRegister(telegramId, phone, name).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  // Актуальные карта и баланс из Syrve. null — гость не зарегистрирован в боте.
  async getCard(telegramId: bigint): Promise<GuestCard | null> {
    const guest = await this.findByTelegramId(telegramId);
    if (!guest) return null;
    const customer = await this.syrve.findCustomer({ id: guest.syrveCustomerId });
    if (!customer) throw new Error(`Гостя ${guest.syrveCustomerId} немає в Syrve`);
    return this.toCard(customer, guest.cardNumber);
  }

  private async doRegister(telegramId: bigint, phone: string, name?: string): Promise<GuestCard> {
    const known = await this.findByTelegramId(telegramId);
    if (known) return this.getCard(telegramId) as Promise<GuestCard>;

    let customer = await this.syrve.findCustomer({ phone });
    if (!customer) {
      if (!name) throw new Error("Для нового гостя потрібне ім'я");
      const { id } = await this.syrve.upsertCustomer({ phone, name });
      await this.syrve.addToProgram(id);
      await this.syrve.addCard(id, await this.freeCardNumber());
      customer = await this.mustFind(id);
    } else {
      // Существующий гость: create_or_update не вызываем — он перезаписал бы имя.
      // Повтор program/add безопасен (проверено на живом API).
      await this.syrve.addToProgram(customer.id);
      if (customer.cards.length === 0) {
        await this.syrve.addCard(customer.id, await this.freeCardNumber());
        customer = await this.mustFind(customer.id);
      }
    }

    const cardNumber = customer.cards[0]?.number;
    if (!cardNumber) throw new Error(`У гостя ${customer.id} немає картки після реєстрації`);

    // Телефон уже привязан к другому Telegram — перепривязываем: контакт подтверждён (user_id).
    await this.prisma.guest.upsert({
      where: { phone },
      create: { telegramId, phone, name: customer.name, syrveCustomerId: customer.id, cardNumber },
      update: { telegramId, name: customer.name, syrveCustomerId: customer.id, cardNumber },
    });
    return this.toCard(customer, cardNumber);
  }

  private toCard(customer: SyrveCustomer, cardNumber: string): GuestCard {
    if (customer.balance === null) {
      this.logger.warn(`У гостя ${customer.id} немає гаманця SYRVE_WALLET_ID — гість не в програмі; показуємо 0`);
    }
    return { name: customer.name, cardNumber, balance: customer.balance ?? 0 };
  }

  private async mustFind(id: string): Promise<SyrveCustomer> {
    const customer = await this.syrve.findCustomer({ id });
    if (!customer) throw new Error(`Гостя ${id} не знайдено в Syrve одразу після створення`);
    return customer;
  }

  // В организации есть чужие гости с 10-значными картами — номер проверяем на занятость.
  private async freeCardNumber(): Promise<string> {
    for (let i = 0; i < CARD_NUMBER_ATTEMPTS; i++) {
      const candidate = this.generateCardNumber();
      if (!(await this.syrve.findCustomer({ cardNumber: candidate }))) return candidate;
    }
    throw new Error(`Не вдалося підібрати вільний номер картки за ${CARD_NUMBER_ATTEMPTS} спроб`);
  }

  // 10 цифр, первая не ноль. Формат произвольный (подтверждено), маски карт не обязательны.
  protected generateCardNumber(): string {
    return String(randomInt(1_000_000_000, 10_000_000_000));
  }
}
