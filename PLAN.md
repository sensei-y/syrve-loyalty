# План тестового: сервис лояльности на Syrve

ТЗ получено 09.11. Сдать до **10.11, 12:00**. Своя тестовая организация, репозиторий публичный, защита — позже (демо + доработка вживую с ИИ). Вопросы Валентину — в будни 11:00–18:00.

## Цель

Обязательная часть работает end-to-end + 4 документа (README, ARCHITECTURE, AI_LOG, звіт). Доп. — только Д1 (історія операцій) и только после О1–О6.

## Обязательный объём (MVP)

| # | Функция | Готово, когда |
|---|---|---|
| О1 | Подключение к Syrve | `/api/health/syrve` возвращает «Демо В.С.» и программу |
| О2 | Регистрация в Telegram | `/start` → кнопка контакта → имя → гость в Syrve, в программе, с картой; повтор — без дубля |
| О3 | Карта и баланс в боте | номер карты, QR, актуальный баланс нашего кошелька |
| О4 | Админка: вход + поиск гостя | без входа страницы недоступны; поиск по телефону → имя, карта, баланс |
| О5 | Начисление / списание | сумма + причина, в минус нельзя, журнал: кто, когда, сколько, почему |
| О6 | Уведомления | «Нараховано N бонусів, баланс M» при любом изменении (панель или кабинет Syrve), одна операция — одно сообщение |

Доп.: **Д1 — история операций** в боте и админке (транзакции всё равно читаем для О6). Остальные Д — нет, причину написать в отчёте.

## Порядок и время

| Когда | Этап | Ветка | Готово, когда |
|---|---|---|---|
| 09.11 до 11:30 | Подготовка: репозиторий, `.env`, Docker | — | ✅ db и redis true |
| 11:30–12:30 | **О1** | `feat/o1-syrve-connection` | health/syrve зелёный, тесты токена |
| 12:30–14:30 | **О2 + О3** | `feat/o2-o3-registration` | регистрация со своего телефона, карта и баланс в боте |
| 14:30–16:30 | **О4 + О5** | `feat/o4-o5-admin` | вход, поиск, начисление/списание, журнал |
| 16:30–18:00 | **О6** | `feat/o6-notifications` | начисление в панели и в кабинете → по одному сообщению |
| вечер | **Д1** | `feat/d1-history` | история в боте и админке |
| вечер | Документы | `docs/final` | README, ARCHITECTURE, AI_LOG, звіт |
| 10.11 9:00–10:30 | Проверка с нуля на чистом клоне, правки | `fix/*` | `git clone` → `docker compose up` → все О по README |
| 10.11 до 11:00 | Отправить ссылку | — | — |

Всё, что касается Syrve API, — до 18:00, пока можно спросить. Если этап съел в 1.5 раза больше времени — упростить и записать в звіт, что упрощено.

## Процесс на каждый этап

1. `git checkout -b feat/<этап>` от свежего `main`.
2. Промпт в Claude Code → план → «ок» → код + unit-тесты на критичное.
3. `npm test`, ручная проверка по колонке «Готово, когда».
4. Ревью Codex по `AGENTS.md` → исправить или объяснить.
5. PR с описанием «что сделано / как проверено» → merge в `main`.
6. Строка в `AI_LOG.md`: запрос и где ИИ ошибся.

## Стек и почему

| Часть | Выбор | Почему, а не альтернатива |
|---|---|---|
| Backend | NestJS + TypeScript | знаю по Lyra Board; модули и DI дают структуру из коробки. Express — меньше бойлерплейта, но структуру держать самому |
| ORM | Prisma + PostgreSQL | знаю; схема читается как документация; миграции в Git. Drizzle — новый инструмент в день тестового |
| Очереди | Redis + BullMQ | стек вакансии; repeatable jobs, ретраи отправки, переживают рестарт процесса. `setInterval` теряет состояние и не ретраит |
| Бот | grammY | TS из коробки, плагин `conversations` для пошаговой регистрации. Telegraf слабее по типам |
| Админка | React + Vite | внутренняя панель, SSR не нужен. Next.js — лишняя сложность и новый для меня |
| Прокси | nginx | отдаёт статику админки и проксирует `/api` — один origin, без CORS, cookie работают как есть |
| Авторизация | `@nestjs/jwt` в httpOnly cookie + `crypto.scrypt` | scrypt встроен в Node — без нативной сборки bcrypt на Alpine. Cookie: `httpOnly`, `sameSite=lax`, `secure` в production |
| Валидация | class-validator (DTO) + zod для `.env` | нативный путь Nest; zod — упасть на старте при кривом конфиге |
| Тесты | Jest (ts-jest) | стандарт для Nest; только unit на критичную логику |
| Запуск | Docker Compose | всё одной командой |

## Архитектура: один код, два процесса

```
Admin (React) ─nginx─► api процесс           worker процесс
                       ├ AuthModule          ├ BotModule (grammY)  ◄── Telegram
                       ├ GuestsModule        ├ PollProcessor   (BullMQ)
                       ├ LoyaltyModule       └ NotifyProcessor (BullMQ)
                       └ HealthModule
                  общие: SyrveModule · PrismaModule · ConfigModule
                              │                │
                           Postgres         Redis       ──► Syrve Cloud API
```

- **api** — HTTP для админки. **worker** — бот (long polling) + обработчики очередей.
- Зачем два: бот завис или поллер упал — админка работает; рестарт независимый. Код общий.

### Модули

| Модуль | Отвечает за |
|---|---|
| `ConfigModule` | `.env` с проверкой zod (id Syrve — UUID) |
| `PrismaModule` | доступ к БД |
| `SyrveModule` | токен, вызовы API, ошибки. Единственное место, которое знает про Syrve |
| `GuestsModule` | регистрация, поиск, привязка Telegram ↔ Syrve |
| `LoyaltyModule` | баланс, начисление, списание, журнал операций |
| `AuthModule` | вход админа, JWT в httpOnly cookie, guard |
| `BotModule` | хендлеры grammY — только UI, логика в сервисах |
| `NotificationsModule` | очереди `poll` и `notify` |
| `HealthModule` | `/health`, `/health/syrve` (наружу — без деталей ошибки) |

### Syrve за интерфейсом

Контракт повторяет реальные методы API (см. `docs/syrve-api-notes.md`), а не «удобную» абстракцию: регистрация — это три вызова, и сервис делает их явно.

```ts
export interface SyrveClient {
  checkConnection(): Promise<SyrveConnectionInfo>;
  findCustomer(q: { phone: string } | { cardNumber: string } | { id: string }): Promise<SyrveCustomer | null>;
  upsertCustomer(data: { phone: string; name: string }): Promise<{ id: string }>;   // create_or_update → только id
  addToProgram(customerId: string): Promise<void>;
  addCard(customerId: string, cardNumber: string): Promise<void>;
  topup(customerId: string, sum: number, comment: string): Promise<void>;
  chargeoff(customerId: string, sum: number, comment: string): Promise<void>;
  transactions(customerId: string, fromRevision: bigint): Promise<SyrveTransactionPage>;
}

interface SyrveCustomer {
  id: string; name: string; phone: string;
  cards: { number: string; track: string }[];
  balance: number;                     // уже выбран по SYRVE_WALLET_ID
}

interface SyrveTransaction {
  id: string;
  revision: bigint;
  type: string;                        // typeName
  sum: number;                         // со знаком
  walletId: string | null;             // null у служебных записей
  balanceAfter: number | null;
  comment: string | null;
  createdAt: string;
}
```

Правило вызовов: повтор запроса — **только после 401** с новым токеном. Таймаут и сетевые ошибки не повторять: `topup` / `chargeoff` могли уже примениться.

### Уведомления: две очереди

```
poll (раз в 30 с) ── по каждому гостю: transactions(lastRevision), все страницы по 50
      └─ walletId наш && sum ≠ 0 && нет в NotifiedTransaction
            └─► notify(jobId = txId) ──► Telegram ──► запись в NotifiedTransaction
      └─ lastRevision гостя обновляется только после постановки всех уведомлений в очередь
```

- `poll` только находит изменения, `notify` только отправляет; Telegram упал — ретраится только отправка.
- Дубли закрыты дважды: `jobId = txId` в BullMQ (пока задача в Redis) и таблица `NotifiedTransaction` в Postgres (после очистки или рестарта Redis — в compose он без volume).
- Опрос, а не вебхук: нужно видеть и изменения из кабинета Syrve.
- Текст: «Нараховано N бонусів, баланс M» / «Списано N бонусів, баланс M»; M — `balanceAfter` транзакции.

## Данные: что где хранится

**В Syrve (источник правды):** гость, карта, баланс, транзакции.
**У нас:** только то, чего в Syrve нет.

```prisma
model Guest {                              // гости, зарегистрированные через бота
  id              String   @id @default(uuid())
  telegramId      BigInt   @unique
  syrveCustomerId String   @unique
  phone           String   @unique
  name            String
  cardNumber      String
  lastRevision    BigInt   @default(0)    // состояние поллера
  createdAt       DateTime @default(now())
}

model Admin {
  id           String @id @default(uuid())
  login        String @unique
  passwordHash String                     // scrypt
}

model Operation {                          // журнал ручных операций: кто, когда, сколько, почему
  id              String   @id @default(uuid())
  idempotencyKey  String   @unique
  syrveCustomerId String
  type            OpType                   // TOPUP | CHARGEOFF
  amount          Decimal
  reason          String
  status          OpStatus                 // PENDING | SUCCESS | FAILED | UNKNOWN
  error           String?
  adminId         String
  createdAt       DateTime @default(now())
  finishedAt      DateTime?
}

model NotifiedTransaction {                // дедуп уведомлений, переживает очистку Redis
  syrveTransactionId String   @id
  guestId            String
  createdAt          DateTime @default(now())
}
```

В Syrve нет метода «все гости организации» → список зарегистрированных через бота храним сами.

## Подводные камни (проверено на живом API — `docs/syrve-api-notes.md`)

1. **4 программы в организации** → `SYRVE_PROGRAM_ID` и `SYRVE_WALLET_ID` явно в `.env`; `programId ≠ walletId`.
2. **У гостя 3 кошелька** → баланс только по `SYRVE_WALLET_ID`.
3. **Syrve пускает списание в минус** → проверка баланса до `chargeoff`.
4. **«Гость не найден» = HTTP 400** с `Validation_IncorrectPhone` → `null`; остальные 400 — ошибка.
5. **`create_or_update` — upsert по телефону** и может перезаписать имя → сначала `findCustomer`.
6. **Служебные транзакции** (`SetGuestCategory`, `sum: 0`, `walletId: null`) → фильтр для уведомлений.
7. **`revision` > 2^32** → `BigInt`.
8. **Токен живёт час** → кэш, обновление за 5 минут до истечения и при 401; один общий промис на параллельные запросы.
9. **Публичный репозиторий** → `apiLogin` только в `.env`; перед push — `git grep` на ключ. Docx с ТЗ не коммитить.
10. **Настройки программ в кабинете не менять** (правило ТЗ).
11. **Телефон в Telegram** → только `request_contact` + проверка `contact.user_id === from.id`; формат везде `+380XXXXXXXXX`.

## Ключевые потоки

**Регистрация (О2):**
`/start` → есть Guest с этим telegramId? → меню.
Нет → «Надіслати контакт» → проверка `user_id` → нормализация телефона → имя → `findCustomer({ phone })`:
- нет → `upsertCustomer` → `addToProgram` → `addCard` → `findCustomer({ id })` за картой и балансом;
- есть → не перезаписывать; если нет карты — `addCard`; программу — `addToProgram` (повтор безопасен — проверить).

→ сохранить Guest → показать карту и баланс.

**Начисление / списание (О5):**
DTO-валидация (сумма > 0, максимум 2 знака, причина 3–200) →
1. `INSERT Operation (PENDING, idempotencyKey)`; конфликт ключа → вернуть результат существующей операции (это повтор);
2. для списания: `findCustomer({ id })` → баланс ≥ суммы, иначе `FAILED` «Недостатньо бонусів»;
3. вызов Syrve;
4. ответ → `SUCCESS`; явная ошибка Syrve → `FAILED`; таймаут / сеть → `UNKNOWN` (не повторять, админ сверяет в кабинете).

`idempotencyKey` генерирует фронт (UUID на открытие формы).

**Уведомления (О6):** см. «две очереди» выше.

## Тесты (unit, Jest)

| Что | Этап |
|---|---|
| токен: кэш, обновление после истечения, один запрос при параллельных вызовах, 401 → новый токен и повтор | О1 |
| ошибка Syrve → `SyrveApiError` с `errorCode`; таймаут не повторяется | О1 |
| `Validation_IncorrectPhone` → `null` | О2 |
| нормализация телефона | О2 |
| выбор кошелька по `SYRVE_WALLET_ID` | О3 |
| списание сверх баланса → `FAILED`, Syrve не вызывается | О5 |
| одинаковый `idempotencyKey` → одна операция в Syrve | О5 |
| фильтр транзакций + дедуп уведомлений | О6 |
| mock-сценарий регистрация → баланс → начисление → списание | если останется время |

## Что сдать (раздел 8 ТЗ)

1. **README.md** — запуск (`cp .env.example .env` → `docker compose up --build`), mock-режим, как проверить каждую О по шагам.
2. **ARCHITECTURE.md** — части сервиса, что храним сами / что берём из Syrve, обмен с Syrve и Telegram, почему так (таблица стека отсюда).
3. **AI_LOG.md** — инструменты, 5–10 ключевых запросов, где ИИ ошибся и как заметил, ссылки на CLAUDE.md и AGENTS.md. **Вести по ходу дня.**
4. **Звіт** (REPORT.md) — сделано / проверено и как / не сделано и почему. Отдельной строкой: каркас подготовлен 08.11, бизнес-логика — 09.11.
