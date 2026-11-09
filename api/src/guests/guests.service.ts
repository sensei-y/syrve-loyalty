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
  balance: number | null; // null — у гостя нет кошелька нашей программы
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
  // Guest.cardNumber — только кэш: карту могли заменить или удалить в кабинете Syrve.
  async getCard(telegramId: bigint): Promise<GuestCard | null> {
    const guest = await this.findByTelegramId(telegramId);
    if (!guest) return null;
    const customer = await this.mustFind(guest.syrveCustomerId);
    const cardNumber = currentCard(customer, guest.cardNumber);
    if (cardNumber !== guest.cardNumber) {
      await this.prisma.guest.update({ where: { id: guest.id }, data: { cardNumber } });
      this.logger.log(`Картку гостя ${customer.id} оновлено з даних Syrve`);
    }
    return this.toCard(customer, cardNumber);
  }

  private async doRegister(telegramId: bigint, phone: string, name?: string): Promise<GuestCard> {
    const known = await this.findByTelegramId(telegramId);
    if (known) return this.getCard(telegramId) as Promise<GuestCard>;

    const startedAt = Date.now();
    const existing = await this.syrve.findCustomer({ phone });
    let customerId: string;
    if (!existing) {
      if (!name) throw new Error("Для нового гостя потрібне ім'я");
      ({ id: customerId } = await this.syrve.upsertCustomer({ phone, name }));
      await this.syrve.addToProgram(customerId);
      await this.syrve.addCard(customerId, await this.freeCardNumber());
    } else {
      // Существующий гость: create_or_update не вызываем — он перезаписал бы имя.
      // Повтор program/add безопасен (проверено на живом API).
      customerId = existing.id;
      await this.syrve.addToProgram(customerId);
      if (existing.cards.length === 0) await this.syrve.addCard(customerId, await this.freeCardNumber());
    }

    // После program/add — всегда свежий гость: появился кошелёк, могли начислиться стартовые бонусы.
    const customer = await this.mustFind(customerId);
    if (customer.balance === null) {
      throw new Error(`Після program/add у гостя ${customerId} немає гаманця SYRVE_WALLET_ID`);
    }
    const cardNumber = currentCard(customer);

    // Телефон уже привязан к другому Telegram — перепривязываем: контакт подтверждён (user_id).
    await this.prisma.guest.upsert({
      where: { phone },
      create: { telegramId, phone, name: customer.name, syrveCustomerId: customer.id, cardNumber },
      update: { telegramId, name: customer.name, syrveCustomerId: customer.id, cardNumber },
    });
    this.logger.log(
      `Гість ${customer.id} ${existing ? 'привʼязаний' : 'створений'} у Syrve за ${Date.now() - startedAt} мс`,
    );
    return this.toCard(customer, cardNumber);
  }

  // null-баланс не превращаем в 0: «нет кошелька» и «ноль бонусов» — разные вещи.
  private toCard(customer: SyrveCustomer, cardNumber: string): GuestCard {
    if (customer.balance === null) {
      this.logger.warn(`У гостя ${customer.id} немає гаманця SYRVE_WALLET_ID — гість не в програмі`);
    }
    return { name: customer.name, cardNumber, balance: customer.balance };
  }

  private async mustFind(id: string): Promise<SyrveCustomer> {
    const customer = await this.syrve.findCustomer({ id });
    if (!customer) throw new Error(`Гостя ${id} не знайдено в Syrve`);
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

// Карта для показа: сохранённая, если она ещё есть у гостя в Syrve (у гостя их может быть несколько),
// иначе — первая актуальная.
function currentCard(customer: SyrveCustomer, preferred?: string): string {
  const numbers = customer.cards.map((c) => c.number);
  if (preferred && numbers.includes(preferred)) return preferred;
  if (!numbers[0]) throw new Error(`У гостя ${customer.id} немає картки в Syrve`);
  return numbers[0];
}
