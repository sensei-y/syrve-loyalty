import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { Admin, Operation, OpStatus, OpType } from '@prisma/client';
import { SessionAdmin } from '../auth/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { describeError, SyrveApiError } from '../syrve/syrve-api.error';
import { SYRVE_CLIENT, SyrveClient } from '../syrve/syrve-client.interface';

export interface OperationInput {
  syrveCustomerId: string;
  idempotencyKey: string;
  type: OpType;
  amount: number;
  reason: string;
  admin: SessionAdmin;
}

// Строка журнала: кто, когда, сколько, тип, причина, статус.
export interface OperationView {
  id: string;
  idempotencyKey: string;
  type: OpType;
  amount: number;
  reason: string;
  status: OpStatus;
  error: string | null;
  admin: string;
  createdAt: Date;
  finishedAt: Date | null;
}

type OperationWithAdmin = Operation & { admin: Pick<Admin, 'login'> };
const withAdmin = { admin: { select: { login: true } } } as const;
const JOURNAL_LIMIT = 100;

// Ручное начисление / списание из панели. Порядок (CLAUDE.md):
// 1) Operation PENDING с уникальным idempotencyKey — до Syrve; конфликт ключа = повтор, Syrve не вызываем;
// 2) списание: свежий баланс из Syrve, не хватает — FAILED (Syrve пускает в минус);
// 3) вызов Syrve без повторов; 4) SUCCESS / FAILED / UNKNOWN.
@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);
  // Операции одного гостя — строго по очереди: иначе два списания с разными ключами
  // одновременно пройдут проверку баланса. Достаточно памяти: api — один процесс.
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SYRVE_CLIENT) private readonly syrve: SyrveClient,
  ) {}

  async run(raw: OperationInput): Promise<OperationView> {
    // id — ключ очереди и журнала: один гость = одна строка, в каком бы регистре ни пришёл id.
    const input = { ...raw, syrveCustomerId: raw.syrveCustomerId.toLowerCase() };
    let op: OperationWithAdmin;
    try {
      op = await this.prisma.operation.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          syrveCustomerId: input.syrveCustomerId,
          type: input.type,
          amount: input.amount,
          reason: input.reason,
          adminId: input.admin.id,
        },
        include: withAdmin,
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return this.existing(input);
    }
    return this.serialized(input.syrveCustomerId, () => this.execute(op, input));
  }

  // Вызывается при старте api (main.ts). PENDING от прошлого процесса — его прервал рестарт:
  // процесс мог упасть и до вызова Syrve, и после применения операции. Повторять нельзя —
  // переводим в UNKNOWN, админ сверяет в кабинете Syrve. Не из onModuleInit: модуль может
  // подключить и worker, а его рестарт не должен трогать операции работающего api.
  async recoverInterrupted(): Promise<number> {
    const { count } = await this.prisma.operation.updateMany({
      where: { status: OpStatus.PENDING },
      data: {
        status: OpStatus.UNKNOWN,
        error: 'api перезапустився під час операції — перевірте операцію в кабінеті Syrve',
        finishedAt: new Date(),
      },
    });
    if (count) this.logger.warn(`Незавершених операцій після рестарту: ${count} → UNKNOWN`);
    return count;
  }

  async journal(syrveCustomerId: string): Promise<OperationView[]> {
    const rows = await this.prisma.operation.findMany({
      where: { syrveCustomerId: syrveCustomerId.toLowerCase() },
      orderBy: { createdAt: 'desc' },
      take: JOURNAL_LIMIT,
      include: withAdmin,
    });
    return rows.map(toView);
  }

  // Повтор запроса с тем же ключом: результат уже созданной операции (возможно, ещё PENDING).
  private async existing(input: OperationInput): Promise<OperationView> {
    const op = await this.prisma.operation.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: withAdmin,
    });
    if (!op) throw new Error(`Операцію з ключем ${input.idempotencyKey} не знайдено після конфлікту`);
    const same =
      op.syrveCustomerId === input.syrveCustomerId &&
      op.type === input.type &&
      Number(op.amount) === input.amount &&
      op.reason === input.reason;
    if (!same) throw new ConflictException('Цей ключ уже використано для іншої операції. Оновіть форму.');
    return toView(op);
  }

  private async execute(op: OperationWithAdmin, input: OperationInput): Promise<OperationView> {
    const { syrveCustomerId: id, amount } = input;

    if (input.type === OpType.CHARGEOFF) {
      let balance: number | null;
      try {
        const customer = await this.syrve.findCustomer({ id });
        if (!customer) return this.finish(op, OpStatus.FAILED, 'Гостя не знайдено в Syrve');
        balance = customer.balance;
      } catch (e) {
        // Списание ещё не отправляли — бонусы точно не изменились.
        this.logger.error(`Перевірка балансу перед списанням ${op.id}: ${describeError(e)}`);
        return this.finish(op, OpStatus.FAILED, 'Не вдалося перевірити баланс у Syrve');
      }
      if (balance === null) return this.finish(op, OpStatus.FAILED, 'Гаманець програми в гостя недоступний');
      if (balance < amount) return this.finish(op, OpStatus.FAILED, `Недостатньо бонусів: на рахунку ${balance}`);
    }

    const comment = `${input.reason} — ${input.admin.login}`;
    try {
      if (input.type === OpType.TOPUP) await this.syrve.topup(id, amount, comment);
      else await this.syrve.chargeoff(id, amount, comment);
      return this.finish(op, OpStatus.SUCCESS, null);
    } catch (e) {
      this.logger.error(`Операція ${op.id} (${input.type}): ${describeError(e)}`);
      if (mayHaveApplied(e)) {
        return this.finish(op, OpStatus.UNKNOWN, 'Немає відповіді від Syrve — перевірте операцію в кабінеті Syrve');
      }
      const code = e instanceof SyrveApiError ? (e.errorCode ?? `HTTP ${e.httpStatus}`) : 'помилка';
      return this.finish(op, OpStatus.FAILED, `Syrve відхилив операцію (${code})`);
    }
  }

  private async finish(op: OperationWithAdmin, status: OpStatus, error: string | null): Promise<OperationView> {
    const done = await this.prisma.operation.update({
      where: { id: op.id },
      data: { status, error, finishedAt: new Date() },
      include: withAdmin,
    });
    return toView(done);
  }

  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.queues.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    return next;
  }
}

// Таймаут или сеть при самой операции: Syrve мог её применить — повторять нельзя, статус UNKNOWN.
// Ответ Syrve с ошибкой или неполученный токен (до операции дело не дошло) — FAILED.
function mayHaveApplied(e: unknown): boolean {
  if (!(e instanceof SyrveApiError)) return true;
  return e.httpStatus === null && e.path !== '/api/1/access_token';
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function toView(op: OperationWithAdmin): OperationView {
  return {
    id: op.id,
    idempotencyKey: op.idempotencyKey,
    type: op.type,
    amount: Number(op.amount),
    reason: op.reason,
    status: op.status,
    error: op.error,
    admin: op.admin.login,
    createdAt: op.createdAt,
    finishedAt: op.finishedAt,
  };
}
