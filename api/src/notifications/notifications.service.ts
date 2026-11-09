import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Guest, NotificationStatus } from '@prisma/client';
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
const REQUEUE_BATCH = 500;
const SCHEDULER_CHECK_MS = 60_000;

// Задача notify несёт только id: всё остальное — в Postgres (outbox Notification).
export interface NotifyJob {
  transactionId: string;
}

// Повторы отправки: Telegram недоступен / 429 — до 5 попыток с растущей паузой от 10 с.
export const NOTIFY_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { count: 1000 },
} as const;

// О6. Источник правды — outbox Notification в Postgres; BullMQ — только «будильник» с ретраями.
//  poll:   страница транзакций → строки PENDING + сдвиг lastRevision в ОДНОЙ транзакции БД,
//          затем в очередь ставятся все PENDING (в т.ч. потерянные при очистке Redis).
//  notify: PENDING → SENDING (захват) → Telegram → SENT. Повтор — только если Telegram явно не принял
//          (429 / 5xx) или соединение не установилось. Ответа нет (обрыв) → UNKNOWN; SENT не записался →
//          остаётся SENDING (при старте → UNKNOWN). Одна транзакция = максимум одно сообщение.
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly walletId: string;
  private readonly startedAt = new Date();
  private schedulerTimer?: NodeJS.Timeout;

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

  async onApplicationBootstrap() {
    await this.recoverInterrupted();
    // Без бота отправлять некуда — расписание снимаем, чтобы не копить задачи.
    if (!this.cfg.TELEGRAM_BOT_TOKEN) {
      await this.pollQueue.removeJobScheduler(POLL_SCHEDULER_ID);
      this.logger.warn('TELEGRAM_BOT_TOKEN не задано — сповіщення вимкнені');
      return;
    }
    await this.ensureScheduler();
    this.logger.log(`Опитування транзакцій кожні ${POLL_EVERY_MS / 1000} с`);
    // Расписание живёт в Redis: после его очистки / рестарта (в compose без volume) поллер встал бы
    // до рестарта worker. Раз в минуту восстанавливаем (upsert идемпотентен).
    this.schedulerTimer = setInterval(
      () => this.ensureScheduler().catch((e) => this.logger.error(`Розклад опитування: ${describeError(e)}`)),
      SCHEDULER_CHECK_MS,
    );
  }

  onModuleDestroy() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
  }

  private async ensureScheduler() {
    await this.pollQueue.upsertJobScheduler(POLL_SCHEDULER_ID, { every: POLL_EVERY_MS }, { name: 'poll' });
  }

  // SENDING от прошлого процесса: он упал во время отправки — дошло ли сообщение, неизвестно.
  // Повторять нельзя (дубль у гостя) — UNKNOWN. Только строки, захваченные до старта этого процесса.
  async recoverInterrupted(): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { status: NotificationStatus.SENDING, claimedAt: { lt: this.startedAt } },
      data: { status: NotificationStatus.UNKNOWN, lastError: 'worker перезапустився під час надсилання' },
    });
    if (count) this.logger.warn(`Сповіщень з невідомим результатом після рестарту: ${count} → UNKNOWN`);
    return count;
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
    await this.enqueuePending();
  }

  async pollGuest(guest: Guest): Promise<number> {
    // Базовая точка не взята — берём последнюю ревизию без уведомлений, иначе гость получит всю историю.
    if (guest.lastRevision === null) {
      const revision = await latestRevision(this.syrve, guest.syrveCustomerId);
      await this.prisma.guest.update({ where: { id: guest.id }, data: { lastRevision: revision } });
      guest.lastRevision = revision;
      this.logger.log(`Базова точка гостя ${guest.syrveCustomerId}: ревізія ${revision}, без сповіщень`);
      return 0;
    }

    let revision = guest.lastRevision;
    let found = 0;
    for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
      const p = await this.syrve.transactions(guest.syrveCustomerId, revision);
      if (p.lastRevision <= revision) {
        if (p.hasMore) this.logger.error(`Гість ${guest.syrveCustomerId}: ревізія не зростає (${revision}), зупиняюсь`);
        break;
      }
      const rows = p.transactions
        .filter((t) => this.isBalanceChange(t))
        .map((t) => ({ syrveTransactionId: t.id, guestId: guest.id, sum: t.sum, balanceAfter: t.balanceAfter }));
      // Строки outbox и курсор — атомарно: курсор не уйдёт вперёд без записанных уведомлений.
      await this.prisma.$transaction([
        this.prisma.notification.createMany({ data: rows, skipDuplicates: true }),
        this.prisma.guest.update({ where: { id: guest.id }, data: { lastRevision: p.lastRevision } }),
      ]);
      revision = p.lastRevision;
      guest.lastRevision = revision;
      found += rows.length;
      if (!p.hasMore) break;
    }
    if (found) this.logger.log(`Гість ${guest.syrveCustomerId}: нових сповіщень ${found}`);
    return found;
  }

  // Все PENDING — в очередь. jobId = id транзакции: уже стоящая задача не дублируется,
  // а потерянная (очистка Redis) появится снова. Вызывается каждым проходом поллера.
  async enqueuePending(): Promise<number> {
    const pending = await this.prisma.notification.findMany({
      where: { status: NotificationStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: REQUEUE_BATCH,
      select: { syrveTransactionId: true },
    });
    for (const { syrveTransactionId } of pending) {
      await this.notifyQueue.add('notify', { transactionId: syrveTransactionId } satisfies NotifyJob, {
        ...NOTIFY_JOB_OPTIONS,
        jobId: syrveTransactionId,
      });
    }
    return pending.length;
  }

  // Отправка одного уведомления. lastAttempt — последняя попытка BullMQ: при ошибке строка → FAILED.
  async deliver(transactionId: string, lastAttempt = false): Promise<'sent' | 'skipped'> {
    // Фаза 1: захват. Не PENDING (уже SENDING / SENT / FAILED / UNKNOWN) — не шлём.
    const claimed = await this.prisma.notification.updateMany({
      where: { syrveTransactionId: transactionId, status: NotificationStatus.PENDING },
      data: { status: NotificationStatus.SENDING, claimedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return 'skipped';

    const n = await this.prisma.notification.findUnique({ where: { syrveTransactionId: transactionId } });
    const guest = n && (await this.prisma.guest.findUnique({ where: { id: n.guestId } }));
    if (!n || !guest) {
      await this.setStatus(transactionId, NotificationStatus.FAILED, 'гостя немає в БД');
      return 'skipped';
    }
    const api = this.bot.api;
    if (!api) {
      await this.setStatus(transactionId, NotificationStatus.PENDING, 'бот не запущено');
      throw new Error('Бот не запущено — повторимо пізніше');
    }

    try {
      await api.sendMessage(
        guest.telegramId.toString(),
        notificationText(Number(n.sum), n.balanceAfter === null ? null : Number(n.balanceAfter)),
      );
    } catch (e) {
      const error = describeError(e);
      switch (classifySendError(e)) {
        case 'blocked':
          await this.setStatus(transactionId, NotificationStatus.FAILED, `Telegram 403: ${error}`);
          this.logger.warn(`Гість ${guest.id} заблокував бота — сповіщення ${transactionId} не надіслано`);
          throw new UnrecoverableError('Telegram 403: бота заблоковано');
        case 'rejected':
          await this.setStatus(transactionId, NotificationStatus.FAILED, error);
          throw new UnrecoverableError(`Telegram відхилив повідомлення: ${error}`);
        case 'unknown':
          // Запрос мог дойти: Telegram принял сообщение, а ответ потерялся. Повтор = возможный дубль.
          await this.setStatus(transactionId, NotificationStatus.UNKNOWN, `Немає відповіді Telegram: ${error}`);
          this.logger.warn(`Сповіщення ${transactionId}: результат невідомий (${error}) — не повторюємо`);
          throw new UnrecoverableError(`Невідомо, чи надіслано: ${error}`);
        case 'retry':
          // Telegram явно не принял (429 / 5xx) или соединение не установилось — повтор безопасен.
          await this.setStatus(transactionId, lastAttempt ? NotificationStatus.FAILED : NotificationStatus.PENDING, error);
          throw e;
      }
    }

    // Фаза 2. Не записалось — строка остаётся SENDING: повторно не шлём, при старте worker → UNKNOWN.
    try {
      await this.prisma.notification.update({
        where: { syrveTransactionId: transactionId },
        data: { status: NotificationStatus.SENT, sentAt: new Date(), lastError: null },
      });
    } catch (e) {
      this.logger.error(`Сповіщення ${transactionId} надіслано, але статус SENT не записано: ${describeError(e)}`);
    }
    return 'sent';
  }

  private async setStatus(transactionId: string, status: NotificationStatus, lastError: string) {
    await this.prisma.notification.update({ where: { syrveTransactionId: transactionId }, data: { status, lastError } });
  }

  // Изменение баланса — только наш кошелёк и ненулевая сумма (служебные записи: sum 0, walletId null).
  private isBalanceChange(tx: SyrveTransaction): boolean {
    return tx.walletId !== null && tx.walletId.toLowerCase() === this.walletId && tx.sum !== 0;
  }
}

// Сетевые ошибки, при которых соединение не установилось: запрос до Telegram точно не дошёл.
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// Что значит ошибка sendMessage для гарантии «максимум одно сообщение»:
//  blocked  — ответ 403: гость заблокировал бота;
//  rejected — ответ 4xx (кроме 429): Telegram отказал, повтор не поможет;
//  retry    — ответ 429 / 5xx или соединение не установилось: сообщение точно не принято;
//  unknown  — ответа нет (grammY HttpError: обрыв, таймаут, сброс) — сообщение могло уйти.
export function classifySendError(e: unknown): 'blocked' | 'rejected' | 'retry' | 'unknown' {
  const code = (e as { error_code?: unknown }).error_code;
  if (typeof code === 'number') {
    if (code === 403) return 'blocked';
    if (code === 429 || code >= 500) return 'retry';
    return 'rejected';
  }
  // HttpError.error → исходная ошибка fetch; системный код может лежать и глубже, в cause.
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    const c = cur as { code?: unknown; error?: unknown; cause?: unknown };
    if (typeof c.code === 'string' && NOT_CONNECTED.has(c.code)) return 'retry';
    cur = c.error ?? c.cause;
  }
  return 'unknown';
}
