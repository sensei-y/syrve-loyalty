# Syrve Cloud API — результати розвідки (09.11.2026)

Перевірено вручну в Postman на тестовій організації. Ключ і токен тут не зберігаються.

## Загальне

- Базовий URL: `https://api-eu.syrve.live`. Усі методи — `POST` з JSON-тілом.
- Токен: `POST /api/1/access_token` з `{ "apiLogin": "..." }` → `{ "token": "..." }`, живе 1 годину. Далі заголовок `Authorization: Bearer <token>`.
- У кожному запиті лояльності потрібен `organizationId`.

## Ідентифікатори тестової організації

| Що | Значення |
|---|---|
| Організація «Демо В.С.» | `67018360-fb28-4d49-b4e0-391d83ec6c57` |
| Програма «Бонусная программа в зале и в доставке» | `0eaa0000-29b3-b8cb-5653-08de79e05361` |
| Гаманець цієї програми | `0eaa0000-29b3-b8cb-7be7-08de79e05361` |

В організації 4 активні програми (3 бонусні + сертифікати), тому програма й гаманець задаються явно в `.env`. `programId` ≠ `walletId`.

## Методи і реальна поведінка

| Метод | Тіло | Відповідь | Нюанс |
|---|---|---|---|
| `/api/1/organizations` | `{}` | `{ organizations: [{ id, name, code }] }` | одна організація |
| `/api/1/loyalty/syrve/program` | `{ organizationId }` | `{ Programs: [{ id, name, walletId, programType, isActive, ... }] }` | ключ `Programs` з великої літери |
| `/api/1/loyalty/syrve/customer/info` | `{ organizationId, type: "phone", phone }` / `type: "id", id` / `type: "cardNumber", cardNumber` | повний профіль гостя (нижче) | **гостя не знайдено → HTTP 400**, `errorCode` залежить від типу пошуку (див. нижче) |
| `/api/1/loyalty/syrve/customer/create_or_update` | `{ organizationId, phone, name }` | `{ id }` | **upsert за телефоном**: повторний виклик повертає той самий `id`. Може перезаписати ім'я — тому спочатку `customer/info` |
| `/api/1/loyalty/syrve/customer/program/add` | `{ organizationId, customerId, programId }` | `{ userWalletId, walletId }` | **повтор безпечний**: для гостя, що вже в програмі, — 200, той самий `walletId`, баланс не змінюється |
| `/api/1/loyalty/syrve/customer/card/add` | `{ organizationId, customerId, cardTrack, cardNumber }` | `{}` | `cardTrack` = `cardNumber` (так заведені картки в організації) |
| `/api/1/loyalty/syrve/customer/wallet/topup` | `{ organizationId, customerId, walletId, sum, comment }` | `{}` | |
| `/api/1/loyalty/syrve/customer/wallet/chargeoff` | `{ organizationId, customerId, walletId, sum, comment }` | `{}` | **пускає в мінус**: списання 500 при балансі 0 → баланс −500, відповідь 200 |
| `/api/1/loyalty/syrve/customer/transactions/by_revision` | `{ organizationId, customerId, revision, pageSize }` | `{ transactions: [...], lastRevision, pageSize }` | див. «Транзакції» |

### «Гостя не знайдено»

```json
{
  "code": "Transport_WrongCustomerNumber",
  "errorCode": "Validation_IncorrectPhone",
  "message": "There is no user with phone +380990000001",
  "httpStatusCode": 400
}
```

Для кожного типу пошуку — свій код (перевірено 09.11 на живому API):

| Тип пошуку | `code` | `errorCode` |
|---|---|---|
| `phone` | `Transport_WrongCustomerNumber` | `Validation_IncorrectPhone` |
| `cardNumber` | `Transport_WrongCardNumber` | `Card_CanNotFindByNumber` |
| `id` | `Transport_WrongCustomerId` | `Customer_CustomerNotFound` |

`findCustomer` повертає `null` лише для коду «не знайдено» **свого** типу пошуку, решту помилок — прокидає.

### Профіль гостя (`customer/info`, скорочено)

```json
{
  "id": "0eaa0000-...-3ed2",
  "name": "Тест",
  "phone": "+380990000001",
  "cards": [{ "id": "...", "track": "100001", "number": "100001", "validToDate": null }],
  "categories": [{ "id": "...", "name": "Кэшбек 1%", "isDefaultForNewGuests": true }],
  "walletBalances": [
    { "id": "0ba20000-...-7994", "name": "Бонусная программа в зале", "type": 1, "balance": 0.0 },
    { "id": "0eaa0000-...-5361", "name": "Бонусная программа в зале и в доставке", "type": 1, "balance": -400.0 },
    { "id": "0eaa0000-...-82c1", "name": "Бонусная программа доставка", "type": 1, "balance": 0.0 }
  ],
  "whenRegistered": "2026-11-09T09:48:37.274"
}
```

- У гостя одразу **кілька гаманців**. Баланс брати строго за `SYRVE_WALLET_ID`, не перший у списку.
- Новому гостю автоматично призначається категорія «Кэшбек 1%».

### Транзакції (`transactions/by_revision`)

```json
{
  "transactions": [
    { "id": "...-3ed3", "type": 21, "typeName": "SetGuestCategory", "sum": 0.0, "walletId": null,
      "balanceAfter": null, "comment": "Кэшбек 1%", "revision": 5207794689, "whenCreated": "2026-11-09T08:48:37.285Z" },
    { "id": "...-9332", "type": 40, "typeName": "WithdrawWalletFromApi", "sum": -500.0,
      "walletId": "0eaa0000-...-5361", "programId": "0eaa0000-...-5361",
      "balanceBefore": 0.0, "balanceAfter": -500.0, "comment": "тест списання понад баланс",
      "revision": 5207802399, "whenCreated": "2026-11-09T08:50:58.833Z" }
  ],
  "lastRevision": 5207802399,
  "pageSize": 50
}
```

- Є службові записи (`SetGuestCategory`, `sum: 0`, `walletId: null`). Для сповіщень (О6) брати лише `walletId === SYRVE_WALLET_ID && sum !== 0`.
- `balanceAfter` є в записі — готове значення для «баланс M».
- `sum` зі знаком: `+` нарахування, `−` списання.
- `revision` — велике число (>2^32), у БД зберігати як `BigInt`. Наступний запит — з `revision = lastRevision`.

Поведінка `by_revision` (перевірено 09.11 на живому API, гість із 7 транзакціями):

| Запит | Відповідь |
|---|---|
| `revision = R` | лише транзакції з `revision > R` (межа **не** включається) |
| нових транзакцій немає | `transactions: []`, `lastRevision` = запитаний `R` |
| `pageSize = 3`, у гостя 7 | 3 записи, `lastRevision` = ревізія останнього з них; далі — з цим значенням |
| `revision` «з майбутнього» | порожньо, `lastRevision` = запитане число — поточну ревізію без обходу історії не дізнатись |

- Повна сторінка (`n = pageSize`) — можуть бути ще; неповна — кінець.
- У відповіді є ще `lastTransactionId`.
- Типи наших операцій: `RefillWalletFromApi` (+), `WithdrawWalletFromApi` (−). Top up з кабінету Syrve приходить як
  `RefillWallet` (перевірено 09.11 у живій перевірці О6) — фільтр за гаманцем і сумою, а не за типом, бере обидва.
- `revision` розбираємо з тексту числа одразу в `BigInt` (JSON.parse з `context.source`), у запит — `JSON.rawJSON`: після 2^53 `Number` втратив би точність.

## Формати помилок

Перевірено на живому API 09.11.2026. Є два формати, клієнт читає обидва:
`errorCode ?? error ?? code`, `message ?? errorDescription`, `correlationId`, якщо є.

**Загальний** (токен, організації, програми):

```json
{ "correlationId": "e5bd1cb5-...", "errorDescription": "Passed organizationId doesn't belong to your api login included organization list." }
```

| Запит | HTTP | `error` |
|---|---|---|
| `access_token` з невірним `apiLogin` | 401 | немає |
| `loyalty/syrve/program`, чужий `organizationId` | 400 | немає |
| `loyalty/syrve/program`, `organizationId` не GUID | 400 | немає |
| `organizations` з чужим id в `organizationIds` | 403 | `ORGANIZATION_DENIED` |

- `error` є не завжди → `errorCode` може бути `null`. Розрізняти ситуації за HTTP-статусом і шляхом, а не лише за кодом.
- **`access_token` повторює `apiLogin` у тексті**: `"Login <apiLogin> is not authorized."`. Тому клієнт відкидає текст помилки токена й залишає лише статус і `correlationId`.

**Лояльність, «гостя не знайдено»** — свій формат, без `correlationId` (див. вище):
`{ code, errorCode, message, httpStatusCode }`.

## Кабінет Syrve Loyalty і дані організації

- В організації вже є **чужі гості** (з 2025 року та від 07.11.2026, картки 10-значні,
  реальні номери чужих гостей тут не наводимо). Не чіпати їх і не використовувати їхні телефони для тестів.
  З таблиці `Guest` беремо лише **список** гостей бота (Д2) — у Syrve немає методу «всі гості».
  **Пошук** гостя в панелі (О4) — через Syrve (`customer/info` за телефоном) по всіх гостях організації:
  гість міг зареєструватися на касі. Операції й журнал привʼязані до `syrveCustomerId`.
- **Номер картки:** 10 цифр, випадковий. Перед `card/add` перевірити, що номер вільний
  (`customer/info` з `type: "cardNumber"`); зайнятий — згенерувати інший.
- **Маски карток:** є маска `123=TEST=NNNNN`, але «Allow customer check-in ONLY if loyalty cards
  have specified masks» вимкнено — довільний номер приймається (перевірено через API).
- **Ручна зміна балансу для перевірки О6:** Гості → Chain/Store «Демо В.С.» → Update →
  відкрити гостя → вкладка Balance → у потрібного гаманця Top up / Write off з коментарем.
- Списки в кабінеті не завантажуються самі: вибрати «Демо В.С.» у Chain/Store і натиснути Update.