import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Guest } from '@prisma/client';
import { Queue, UnrecoverableError } from 'bullmq';
import { BotService } from '../bot/bot.service';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { PrismaService } from '../prisma/prisma.service';
import { MOCK_WALLET_ID } from '../syrve/mock-syrve.client';
import { describeError } from '../syrve/syrve-api.error';
import { SYRVE_CLIENT, SyrveClient, SyrveTransaction } from '../syrve/syrve-client.interface';
import { notificationText } from './notification-text';
import { latestRevision } from './revision';

export const POLL_QUEUE = 'poll';
export const NOTIFY_QUEUE = 'notify';
export const POLL_SCHEDULER_ID = 'poll-transactions'; // фиксированный id: рестарт не плодит расписания
export const POLL_EVERY_MS = 30_000;
const MAX_PAGES_PER_POLL = 20; // остальное — в следующий проход

export interface NotifyJob {
  guestId: string;
  telegramId: string; // BigInt не сериализуется в JSON задачи
  transactionId: string;
  sum: number;
  balanceAfter: number | null;
}

// Повторы отправки: Telegram недоступен / 429 — до 5 попыток с растущей паузой от 10 с.
export const NOTIFY_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { count: 1000 },
} as const;

// О6. poll только находит изменения и ставит задачи, notify только отправляет.
// Дубли закрыты дважды: jobId = id транзакции (пока задача в Redis) и NotifiedTransaction (навсегда).
@Injectable()
export class NotificationsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly walletId: string;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    @Inject(SYRVE_CLIENT) private readonly syrve: SyrveClient,
    private readonly bot: BotService,
    @InjectQueue(POLL_QUEUE) private readonly pollQueue: Queue,
    @InjectQueue(NOTIFY_QUEUE) private readonly notifyQueue: Queue,
  ) {
    this.walletId = (cfg.SYRVE_WALLET_ID ?? MOCK_WALLET_ID).toLowerCase();
  }

  // Без бота отправлять некуда — расписание снимаем, чтобы не копить задачи.
  async onApplicationBootstrap() {
    if (!this.cfg.TELEGRAM_BOT_TOKEN) {
      await this.pollQueue.removeJobScheduler(POLL_SCHEDULER_ID);
      this.logger.warn('TELEGRAM_BOT_TOKEN не задано — сповіщення вимкнені');
      return;
    }
    await this.pollQueue.upsertJobScheduler(POLL_SCHEDULER_ID, { every: POLL_EVERY_MS }, { name: 'poll' });
    this.logger.log(`Опитування транзакцій кожні ${POLL_EVERY_MS / 1000} с`);
  }

  // Один проход поллера. Ошибка одного гостя не останавливает остальных.
  async pollAll(): Promise<void> {
    const guests = await this.prisma.guest.findMany();
    for (const guest of guests) {
      try {
        await this.pollGuest(guest);
      } catch (e) {
        this.logger.error(`Опитування гостя ${guest.syrveCustomerId}: ${describeError(e)}`);
      }
    }
  }

  async pollGuest(guest: Guest): Promise<number> {
    // Базовая точка не взята — берём текущую ревизию без уведомлений, иначе гость получит всю историю.
    if (guest.lastRevision === null) {
      const revision = await latestRevision(this.syrve, guest.syrveCustomerId);
      await this.prisma.guest.update({ where: { id: guest.id }, data: { lastRevision: revision } });
      this.logger.log(`Базова точка гостя ${guest.syrveCustomerId}: ревізія ${revision}, без сповіщень`);
      return 0;
    }

    let revision = guest.lastRevision;
    let queued = 0;
    for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
      const p = await this.syrve.transactions(guest.syrveCustomerId, revision);
      for (const tx of p.transactions.filter((t) => this.isBalanceChange(t))) {
        await this.notifyQueue.add('notify', this.job(guest, tx), { ...NOTIFY_JOB_OPTIONS, jobId: tx.id });
        queued++;
      }
      if (p.lastRevision <= revision) break; // защита: ревизия не растёт
      revision = p.lastRevision;
      if (!p.hasMore) break;
    }

    // Только после постановки всех уведомлений: упало посередине — следующий проход повторит,
    // дубли отсеют jobId и NotifiedTransaction.
    if (revision !== guest.lastRevision) {
      await this.prisma.guest.update({ where: { id: guest.id }, data: { lastRevision: revision } });
    }
    if (queued) this.logger.log(`Гість ${guest.syrveCustomerId}: у черзі ${queued} сповіщень`);
    return queued;
  }

  // Отправка одного уведомления (задача очереди notify).
  async deliver(n: NotifyJob): Promise<'sent' | 'skipped'> {
    const done = await this.prisma.notifiedTransaction.findUnique({
      where: { syrveTransactionId: n.transactionId },
    });
    if (done) return 'skipped';

    const api = this.bot.api;
    if (!api) throw new Error('Бот не запущено — повторимо пізніше');
    try {
      await api.sendMessage(n.telegramId, notificationText(n.sum, n.balanceAfter));
    } catch (e) {
      // 403 — гость заблокировал бота: повторять бессмысленно.
      if ((e as { error_code?: number }).error_code === 403) {
        this.logger.warn(`Гість ${n.guestId} заблокував бота — сповіщення ${n.transactionId} не надіслано`);
        throw new UnrecoverableError('Telegram 403: бота заблоковано');
      }
      throw e; // остальное — ретрай с backoff
    }

    // Сообщение уже ушло: ошибка записи не должна вызвать повтор (= дубль у гостя).
    await this.prisma.notifiedTransaction
      .create({ data: { syrveTransactionId: n.transactionId, guestId: n.guestId } })
      .catch((e) => this.logger.error(`Запис NotifiedTransaction ${n.transactionId}: ${describeError(e)}`));
    return 'sent';
  }

  // Изменение баланса — только наш кошелёк и ненулевая сумма (служебные записи: sum 0, walletId null).
  private isBalanceChange(tx: SyrveTransaction): boolean {
    return tx.walletId !== null && tx.walletId.toLowerCase() === this.walletId && tx.sum !== 0;
  }

  private job(guest: Guest, tx: SyrveTransaction): NotifyJob {
    return {
      guestId: guest.id,
      telegramId: guest.telegramId.toString(),
      transactionId: tx.id,
      sum: tx.sum,
      balanceAfter: tx.balanceAfter,
    };
  }
}
