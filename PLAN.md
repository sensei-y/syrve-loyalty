# План тестового: сервис лояльности на Syrve

Предположение: ТЗ = О1–О6 обязательные + доп. пункты. Если ТЗ другое — первым делом сверить и поправить этот план.

## Цель на день

Обязательная часть работает end-to-end + понятный README. Доп. функции — только после этого, максимум 1–2.

## Обязательный объём (MVP)

| # | Функция | Готово, когда |
|---|---|---|
| О1 | Подключение к Syrve | `/api/health/syrve` возвращает организацию и программу |
| О2 | Регистрация в Telegram | `/start` → кнопка контакта → имя → гость создан в Syrve, карта выдана |
| О3 | Карта и баланс в боте | QR с номером карты + актуальный баланс |
| О4 | Админка: вход + поиск гостя | поиск по телефону или номеру карты |
| О5 | Начисление / списание | сумма + причина, проверка баланса, журнал |
| О6 | Уведомления | гостю в Telegram при любом изменении баланса, без дублей |

Доп. (по порядку, если останется время): история операций в боте → список гостей в админке.

## Тайминг (~9 часов)

| Время | Что | Результат |
|---|---|---|
| 0:00–0:30 | Прочитать ТЗ, задать 3–5 вопросов, поправить план | вопросы отправлены |
| 0:30–1:30 | Разведка Syrve API: токен, организации, программы, тестовый гость | id в `.env`, примеры ответов в `docs/api-samples/` |
| 1:30–2:00 | Скелет (если не готов заранее): compose, Nest, Prisma, health | `docker compose up` поднимает всё |
| 2:00–3:30 | О1: `SyrveModule` (токен, ретраи, ошибки) | `/health/syrve` зелёный |
| 3:30–5:00 | О2 + О3: `GuestsModule` + `BotModule` | регистрация и баланс на живом API |
| 5:00–6:30 | О4 + О5: `AuthModule` + `LoyaltyModule` + админка | поиск, начисление, списание, журнал |
| 6:30–7:30 | О6: `NotificationsModule` (BullMQ) | изменение баланса → сообщение, без дублей |
| 7:30–8:30 | README, `.env.example`, проверка с нуля | `git clone` → `docker compose up` работает |
| 8:30–9:00 | Буфер | — |

Правило: если пункт съел в 1.5 раза больше времени — упростить и записать в README, что упрощено.

## Стек и почему

| Часть | Выбор | Почему, а не альтернатива |
|---|---|---|
| Backend | NestJS + TypeScript | знаю по Lyra Board; модули и DI дают структуру из коробки. Express — меньше бойлерплейта, но структуру держать самому |
| ORM | Prisma + PostgreSQL | знаю; схема читается как документация; миграции в Git. Drizzle — новый инструмент в день тестового |
| Очереди | Redis + BullMQ | стек вакансии; repeatable jobs, ретраи, переживают рестарт, дедуп через `jobId`. `setInterval` теряет состояние |
| Бот | grammY | TS из коробки, плагин `conversations` для пошаговой регистрации. Telegraf слабее по типам |
| Админка | React + Vite | внутренняя панель, SSR не нужен. Next.js — лишняя сложность и новый для меня |
| Прокси | nginx | отдаёт статику админки и проксирует `/api` — один origin, без CORS |
| Валидация | class-validator (DTO) + zod для `.env` | нативный путь Nest; zod — упасть на старте при кривом конфиге |
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

- **api** — HTTP для админки.
- **worker** — бот (long polling) + обработчики очередей.
- Зачем два: бот завис или поллер упал — админка работает; рестарт независимый. Код общий.

```ts
// main.ts — API
const app = await NestFactory.create(ApiModule);
await app.listen(3000);

// worker.ts — бот + очереди, без HTTP
const app = await NestFactory.createApplicationContext(WorkerModule);
app.get(BotService).start();
```

Compose: `postgres`, `redis`, `api`, `worker`, `admin` (nginx + статика).

### Модули

| Модуль | Отвечает за |
|---|---|
| `ConfigModule` | `.env` с проверкой zod |
| `PrismaModule` | доступ к БД |
| `SyrveModule` | токен, вызовы API, ошибки. Единственное место, которое знает про Syrve |
| `GuestsModule` | регистрация, поиск, привязка Telegram ↔ Syrve |
| `LoyaltyModule` | баланс, начисление, списание, журнал операций |
| `AuthModule` | вход админа, JWT в httpOnly cookie, guard |
| `BotModule` | хендлеры grammY — только UI, логика в сервисах |
| `NotificationsModule` | очереди `poll` и `notify` |
| `HealthModule` | `/health`, `/health/syrve` |

Бот и контроллеры тонкие — регистрация из бота и поиск из админки идут через один `GuestsService`.

### Syrve за интерфейсом

```ts
export interface SyrveClient {
  findCustomer(q: { phone?: string; card?: string }): Promise<Customer | null>;
  createCustomer(data: NewCustomer): Promise<Customer>;
  getBalance(customerId: string): Promise<number>;
  topup(customerId: string, sum: number, comment: string): Promise<void>;
  chargeoff(customerId: string, sum: number, comment: string): Promise<void>;
  transactions(customerId: string, fromRevision: bigint): Promise<TxPage>;
}

@Module({
  providers: [{
    provide: SYRVE_CLIENT,
    useFactory: (cfg: Config) => cfg.SYRVE_MODE === 'mock'
      ? new MockSyrveClient()
      : new RealSyrveClient(cfg),
    inject: [Config],
  }],
  exports: [SYRVE_CLIENT],
})
export class SyrveModule {}
```

Зачем: работа без доступа к API; формат Syrve меняется — правка в одном месте.

### Уведомления: две очереди

```
poll (раз в 30 с) ── по каждому гостю: transactions(lastRevision)
      └─ новая транзакция ──► notify(jobId = txId) ──► Telegram
```

- `poll` только находит изменения, `notify` только отправляет.
- `jobId = txId` → BullMQ не создаст дубль.
- Telegram упал → ретраится только отправка.
- Опрос, а не вебхук: нужно видеть и изменения с кассы / из кабинета Syrve. Если в документации есть вебхук на изменение кошелька — взять его и описать в README.

## Данные: что где хранится

**В Syrve (источник правды):** гость, карта, баланс, транзакции.
**У нас:** только то, чего в Syrve нет.

```prisma
model Guest {
  id              String   @id @default(uuid())
  telegramId      BigInt   @unique
  syrveCustomerId String   @unique
  phone           String   @unique
  name            String
  cardNumber      String
  lastRevision    BigInt   @default(0)   // состояние поллера
  createdAt       DateTime @default(now())
}

model Admin {
  id           String @id @default(uuid())
  login        String @unique
  passwordHash String
}

model Operation {                          // журнал ручных операций админки
  id              String   @id @default(uuid())
  syrveCustomerId String
  type            OpType                  // TOPUP | CHARGEOFF
  amount          Decimal
  reason          String
  status          OpStatus                // SUCCESS | FAILED
  error           String?
  idempotencyKey  String   @unique        // двойной клик / ретрай
  adminId         String
  createdAt       DateTime @default(now())
}
```

Дедуп уведомлений — через `jobId` в BullMQ. Если нужна гарантия после очистки Redis — добавить таблицу `NotifiedTransaction`.

В Syrve нет метода «все гости организации» → список зарегистрированных через бота храним сами.

## Syrve Cloud API (сверить с документацией в первый час!)

Базовый URL: `https://api-eu.syrve.live`. Все запросы — POST с JSON, `Authorization: Bearer <token>`.

| Что | Эндпоинт (ориентировочно) |
|---|---|
| Токен по apiLogin (живёт ~1 час) | `/api/1/access_token` |
| Организации | `/api/1/organizations` |
| Программы лояльности | `/api/1/loyalty/syrve/program` |
| Найти гостя (phone / cardNumber / id) | `/api/1/loyalty/syrve/customer/info` |
| Создать / обновить гостя | `/api/1/loyalty/syrve/customer/create_or_update` |
| Добавить карту | `/api/1/loyalty/syrve/customer/card/add` |
| Подключить к программе | `/api/1/loyalty/syrve/customer/program/add` |
| Начислить | `/api/1/loyalty/syrve/customer/wallet/topup` |
| Списать | `/api/1/loyalty/syrve/customer/wallet/chargeoff` |
| Транзакции гостя | `/api/1/loyalty/syrve/customer/transactions/by_revision` |

## Подводные камни

1. **Несколько программ лояльности** → `SYRVE_PROGRAM_ID` явно, баланс из кошелька этой программы.
2. **Syrve пускает списание в минус** → проверка баланса до `chargeoff`.
3. **Токен живёт час** → кэш + обновление за 5 минут до истечения и при 401.
4. **Общая демо-база** → свои тестовые телефоны, чужих гостей не трогать.
5. **Телефон в Telegram** → только `request_contact` + проверка `contact.user_id === from.id`.
6. **Повторная регистрация** → сначала `customer/info` по телефону; гость есть — привязать, не дублировать.
7. **Изменения извне** → уведомления на опросе транзакций, не только на своих операциях.
8. **Формат телефона** → везде `+380XXXXXXXXX`.

## Ключевые потоки

**Регистрация (О2):**
`/start` → есть Guest с этим telegramId? → меню.
Нет → кнопка «Надіслати контакт» → проверка `user_id` → имя → `findCustomer` по телефону → нет: `createCustomer` + карта + программа → сохранить Guest → показать карту.

**Начисление / списание (О5):**
DTO-валидация (сумма > 0, макс. 2 знака, причина 3–200) → для списания `getBalance` и проверка → `idempotencyKey` с фронта → вызов Syrve → запись Operation (SUCCESS / FAILED).

**Уведомления (О6):** см. «две очереди» выше.

## Вопросы к Валентину (когда получу ТЗ)

1. Что обязательно за день, а что бонус?
2. Какой `programId` использовать, если программ несколько?
3. Какие тестовые телефоны можно занимать?
4. Нужен деплой или достаточно `docker compose up`?
5. Telegram — обычный бот или Mini App?

## README — структура

1. Что это и что умеет (3–4 строки)
2. Быстрый старт: `cp .env.example .env` → `docker compose up --build`
3. Переменные `.env` с пояснениями
4. Как проверить каждую функцию (по шагам)
5. Архитектура и решения: стек и почему, два процесса, что где хранится
6. Что не сделано и почему
7. Как работал с AI: что делегировал, где агент ошибался, что исправил
