import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Bot } from 'grammy';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';

// Только UI: хендлеры вызывают сервисы (GuestsService, LoyaltyService), логики здесь нет.
// Этап 2: регистрация (кнопка контакта → имя). Этап 3: карта и баланс.
@Injectable()
export class BotService implements OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot?: Bot;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  start() {
    if (!this.cfg.TELEGRAM_BOT_TOKEN) {
      this.logger.warn('TELEGRAM_BOT_TOKEN не задано — бот вимкнений');
      return;
    }
    this.bot = new Bot(this.cfg.TELEGRAM_BOT_TOKEN);

    this.bot.command('start', (ctx) => ctx.reply('Бот працює. Реєстрація — на етапі 2.'));
    this.bot.catch((err) => this.logger.error(`Помилка бота: ${err.message}`));

    // Ошибка старта (неверный токен, нет сети) не должна стать unhandled rejection.
    this.bot
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
}
