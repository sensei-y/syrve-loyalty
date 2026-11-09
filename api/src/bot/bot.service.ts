import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Bot, Context, InputFile, session, SessionFlavor } from 'grammy';
import QRCode from 'qrcode';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { GuestCard, GuestsService } from '../guests/guests.service';
import { BOT_HISTORY_LIMIT, LoyaltyService } from '../loyalty/loyalty.service';
import { describeError } from '../syrve/syrve-api.error';
import { contactKeyboard, menuKeyboard, nameKeyboard } from './bot.keyboards';
import { T } from './bot.texts';

// Между шагами регистрации помним только телефон, ожидающий имени.
// Хранилище — память процесса: после рестарта worker гость просто снова жмёт /start.
interface SessionData {
  pendingPhone?: string;
}
type BotContext = Context & SessionFlavor<SessionData>;

const NAME_MIN = 2;
const NAME_MAX = 50;

// Только UI: ввод/вывод и тексты. Регистрация, карта и баланс — в GuestsService.
@Injectable()
export class BotService implements OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot?: Bot<BotContext>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly guests: GuestsService,
    private readonly loyalty: LoyaltyService,
  ) {}

  start() {
    if (!this.cfg.TELEGRAM_BOT_TOKEN) {
      this.logger.warn('TELEGRAM_BOT_TOKEN не задано — бот вимкнений');
      return;
    }
    const bot = new Bot<BotContext>(this.cfg.TELEGRAM_BOT_TOKEN);
    this.bot = bot;
    bot.use(session({ initial: (): SessionData => ({}) }));

    bot.command('start', (ctx) => this.onStart(ctx));
    bot.command('card', (ctx) => this.onCard(ctx));
    bot.hears(T.myCardButton, (ctx) => this.onCard(ctx));
    bot.command('history', (ctx) => this.onHistory(ctx));
    bot.hears(T.historyButton, (ctx) => this.onHistory(ctx));
    bot.on('message:contact', (ctx) => this.onContact(ctx));
    bot.on('message:text', (ctx) => this.onText(ctx));

    // Ошибки Syrve/БД: подробности — в лог с correlationId, гостю — нейтральный текст.
    bot.catch(async (err) => {
      this.logger.error(`Помилка обробки повідомлення: ${describeError(err.error)}`);
      await err.ctx.reply(T.unavailable).catch(() => undefined);
    });

    // Ошибка старта (неверный токен, нет сети) не должна стать unhandled rejection.
    bot
      .start({ onStart: (me) => this.logger.log(`Бот @${me.username} запущено`) })
      .catch((err: Error) => this.logger.error(`Бот зупинився з помилкою: ${err.message}`));
  }

  // Нужен другим модулям (уведомления) для отправки сообщений.
  get api() {
    return this.bot?.api;
  }

  async onModuleDestroy() {
    await this.bot?.stop();
  }

  private async onStart(ctx: BotContext) {
    ctx.session.pendingPhone = undefined;
    const card = await this.guests.getCard(BigInt(ctx.from!.id));
    if (card) return this.sendCard(ctx, card);
    await ctx.reply(T.welcome, { reply_markup: contactKeyboard() });
  }

  private async onCard(ctx: BotContext) {
    const card = await this.guests.getCard(BigInt(ctx.from!.id));
    if (!card) return ctx.reply(T.notRegistered);
    await this.sendCard(ctx, card);
  }

  // Д1: последние изменения баланса из Syrve (любой источник).
  private async onHistory(ctx: BotContext) {
    const guest = await this.guests.findByTelegramId(BigInt(ctx.from!.id));
    if (!guest) return ctx.reply(T.notRegistered);
    const items = await this.loyalty.history(guest.syrveCustomerId, BOT_HISTORY_LIMIT);
    await ctx.reply(T.history(items), { reply_markup: menuKeyboard() });
  }

  private async onContact(ctx: BotContext) {
    const contact = ctx.message!.contact!;
    // Только свой номер: контакт, отправленный кнопкой request_contact, несёт user_id отправителя.
    if (contact.user_id !== ctx.from!.id) {
      return ctx.reply(T.notOwnContact, { reply_markup: contactKeyboard() });
    }
    const result = await this.guests.handleContact(BigInt(ctx.from!.id), contact.phone_number);
    switch (result.kind) {
      case 'invalidPhone':
        return ctx.reply(T.invalidPhone, { reply_markup: contactKeyboard() });
      case 'needName':
        ctx.session.pendingPhone = result.phone;
        return ctx.reply(T.askName, { reply_markup: nameKeyboard(ctx.from!.first_name) });
      case 'registered':
        await ctx.reply(T.registered(result.card.name));
        return this.sendCard(ctx, result.card);
    }
  }

  private async onText(ctx: BotContext) {
    const phone = ctx.session.pendingPhone;
    if (!phone) {
      const registered = await this.guests.findByTelegramId(BigInt(ctx.from!.id));
      return ctx.reply(registered ? T.unknown : T.notRegistered, {
        reply_markup: registered ? menuKeyboard() : contactKeyboard(),
      });
    }

    const name = ctx.message!.text!.trim().replace(/\s+/g, ' ');
    if (name.length < NAME_MIN || name.length > NAME_MAX) return ctx.reply(T.invalidName);

    const card = await this.guests.register(BigInt(ctx.from!.id), phone, name);
    ctx.session.pendingPhone = undefined;
    await ctx.reply(T.registered(card.name));
    await this.sendCard(ctx, card);
  }

  private async sendCard(ctx: BotContext, card: GuestCard) {
    const startedAt = Date.now();
    const qr = await QRCode.toBuffer(card.cardNumber, { width: 400, margin: 2 });
    await ctx.replyWithPhoto(new InputFile(qr, 'card.png'), {
      caption: T.card(card.cardNumber, card.balance),
      reply_markup: menuKeyboard(),
    });
    this.logger.log(`Картку надіслано в Telegram за ${Date.now() - startedAt} мс`);
  }
}
