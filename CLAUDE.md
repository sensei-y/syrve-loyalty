# CLAUDE.md

Сервис лояльности поверх Syrve Cloud API: Telegram-бот для гостя + веб-админка. Тестовое задание на один день. Полный план и архитектура — `PLAN.md`.

## Приоритеты

1. Обязательная часть (О1–О6 в PLAN.md) работает end-to-end.
2. Простота важнее «продакшн-архитектуры». Не добавлять слои, паттерны и библиотеки вне стека ниже без моего согласия.
3. Не реализовывать функции, которых нет в текущей задаче. Кажется, что что-то нужно, — спроси.

## Стек (фиксирован)

NestJS + TypeScript, class-validator (DTO), zod (только `.env`), Prisma + PostgreSQL, Redis + BullMQ (`@nestjs/bullmq`), grammY, React + Vite, nginx, Docker Compose.

## Структура

```
api/
  prisma/                 схема и миграции
  src/
    main.ts               точка входа API (HTTP)
    worker.ts             точка входа worker (бот + очереди, без HTTP)
    api.module.ts         Auth, Guests, Loyalty, Health
    worker.module.ts      Bot, Notifications, Guests, Loyalty
    config/               ConfigModule, zod-схема .env
    prisma/               PrismaModule
    syrve/                SyrveClient interface, real, mock, SyrveModule
    guests/               регистрация, поиск, привязка Telegram ↔ Syrve
    loyalty/              баланс, начисление, списание, журнал
    auth/                 вход админа, JWT cookie, guard
    bot/                  grammY: хендлеры, клавиатуры, тексты
    notifications/        processors: poll, notify
    health/
    common/               phone.ts, ошибки, фильтры
admin/                    React + Vite, nginx.conf
docs/api-samples/         реальные ответы Syrve (секреты вырезаны)
```

## Правила

- Вся работа с Syrve — только через `SYRVE_CLIENT` из `SyrveModule`. Нигде больше нет HTTP-вызовов к Syrve.
- Бот и контроллеры тонкие: только ввод/вывод, логика в сервисах.
- Источник правды по балансу и транзакциям — Syrve. Не хранить баланс в нашей БД.
- Списание: всегда проверять баланс до `chargeoff` (Syrve пускает в минус).
- Каждая ручная операция пишется в `Operation`, включая неуспешные.
- Начисление и списание идемпотентны по `idempotencyKey`. Уведомления — по `jobId = txId`.
- Телефон нормализуется в `+380XXXXXXXXX` через `common/phone.ts`.
- Секреты только из `.env` через `ConfigModule`. Никаких секретов в коде, логах и `docs/`.
- Ошибки Syrve логировать с `correlationId`. Пользователю — понятный текст на украинском.
- Тексты для пользователя (бот, админка) — на украинском.
- Миграции только через `prisma migrate`. Не править применённые миграции.

## Процесс

- Перед кодом — короткий план изменения, жди моего «ок».
- Одна задача — один коммит с понятным сообщением.
- После изменения: `docker compose up --build` поднимается и затронутый сценарий работает.
- Не трогай файлы вне текущей задачи.
- Не уверен в формате ответа Syrve — смотри `docs/api-samples/`, не выдумывай поля.

## Тестовая организация и секреты

- Работаем только с выданной тестовой организацией.
- Настройки программ лояльности в кабинете Syrve не менять.
- Репозиторий публичный: `apiLogin`, токены, пароли — только в `.env`. Не вставлять их в код, тесты, `docs/api-samples/`, сообщения коммитов.

## Документы к сдаче

README.md, ARCHITECTURE.md, AI_LOG.md, звіт. Интерфейс и тексты для пользователя — только українською.
