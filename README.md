# Syrve Loyalty

Сервіс лояльності поверх Syrve: Telegram-бот для гостя і веб-панель для адміністратора.

> Стан: каркас проєкту (інфраструктура без бізнес-логіки). Функції додаються поетапно — див. `PLAN.md`.

## Швидкий старт

Потрібні Docker і Docker Compose.

```bash
cp .env.example .env
docker compose up --build
```

| Що | Адреса |
|---|---|
| Адмін-панель | http://localhost:8080 |
| API | http://localhost:3000/api |
| Перевірка API, Postgres, Redis | http://localhost:3000/api/health |
| Перевірка зв'язку з Syrve | http://localhost:3000/api/health/syrve |

За замовчуванням `SYRVE_MODE=mock` — сервіс піднімається без доступу до Syrve.

## Архітектура

Один код, два процеси:

- **api** — HTTP для адмін-панелі;
- **worker** — Telegram-бот і фонові черги (BullMQ).

Падіння бота чи черги не зачіпає адмінку. Робота з Syrve — лише через інтерфейс `SyrveClient` (`api/src/syrve`), реалізація (real / mock) обирається через DI.

```
api/        NestJS: src/main.ts (API), src/worker.ts (бот + черги), prisma/
admin/      React + Vite, nginx.conf
```

## Локальний запуск без Docker

```bash
docker compose up -d postgres redis
cd api && npm install && npx prisma migrate dev
npm run dev:api      # API
npm run dev:worker   # в іншому терміналі
cd ../admin && npm install && npm run dev
```
