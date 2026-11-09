# Syrve Loyalty

Сервіс лояльності поверх Syrve: Telegram-бот для гостя і веб-панель для адміністратора.

> Стан: готово О1–О5 (підключення до Syrve, реєстрація в боті, картка й баланс, вхід і пошук в адмінці,
> нарахування / списання з журналом). Далі — О6 (сповіщення). План — `PLAN.md`. Повний опис і звіт — наприкінці.

## Швидкий старт

Потрібні Docker і Docker Compose.

```bash
cp .env.example .env
```

Заповніть у `.env` обовʼязкові значення адмін-панелі — без них api не стартує:

- `ADMIN_PASSWORD` — пароль адміністратора (мінімум 8 символів), логін — `ADMIN_LOGIN` (за замовчуванням `admin`);
- `JWT_SECRET` — мінімум 32 символи, наприклад `openssl rand -hex 32`.

```bash
docker compose up --build
```

| Що | Адреса |
|---|---|
| Адмін-панель (вхід — `ADMIN_LOGIN` / `ADMIN_PASSWORD`) | http://localhost:8080 |
| API | http://localhost:3000/api |
| Перевірка API, Postgres, Redis | http://localhost:3000/api/health |
| Перевірка зв'язку з Syrve | http://localhost:3000/api/health/syrve |

За замовчуванням `SYRVE_MODE=mock` — сервіс піднімається без доступу до Syrve.

`COOKIE_SECURE=false` у `.env.example` — для локального `http://localhost:8080`. За HTTPS приберіть рядок
або задайте `true`: тоді cookie сесії отримує прапорець `Secure`.

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

Якщо на машині встановлено локальний PostgreSQL, він може займати `127.0.0.1:5432` — тоді `localhost:5432`
веде не в базу з Docker. Зупиніть локальний PostgreSQL або змініть порт у `docker-compose.yml` і `DATABASE_URL`.
