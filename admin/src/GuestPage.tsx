import { FormEvent, useState } from 'react';
import { api, ApiError, GuestProfile, newIdempotencyKey, Operation, OpStatus, OpType } from './api';

const STATUS: Record<OpStatus, string> = {
  PENDING: 'Обробляється',
  SUCCESS: 'Виконано',
  FAILED: 'Відхилено',
  UNKNOWN: 'Невідомо — перевірте в кабінеті Syrve',
};
const TYPE: Record<OpType, string> = { TOPUP: 'Нарахування', CHARGEOFF: 'Списання' };

const fmtDate = (iso: string) => new Date(iso).toLocaleString('uk-UA');
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function GuestPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [phone, setPhone] = useState('');
  const [guest, setGuest] = useState<GuestProfile | null>(null);
  const [journal, setJournal] = useState<Operation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 401 посреди работы (сессия истекла) — назад к логину.
  function fail(err: unknown) {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized();
    setError((err as Error).message);
  }

  async function load(path: string) {
    const profile = await api<GuestProfile>(path);
    setGuest(profile);
    setJournal(await api<Operation[]>(`/guests/${profile.syrveCustomerId}/operations`));
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setGuest(null);
    setJournal([]);
    try {
      await load(`/guests?phone=${encodeURIComponent(phone)}`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="row" onSubmit={search}>
        <input
          placeholder="Телефон гостя, напр. 0991234567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
        <button disabled={busy}>{busy ? 'Пошук…' : 'Знайти'}</button>
      </form>
      {error && <p className="error">{error}</p>}

      {guest && (
        <>
          <section className="card">
            <h2>{guest.name || 'Без імені'}</h2>
            <dl>
              <dt>Телефон</dt>
              <dd>{guest.phone}</dd>
              <dt>Картка</dt>
              <dd>{guest.cards.length ? guest.cards.join(', ') : '—'}</dd>
              <dt>Баланс</dt>
              <dd className="balance">
                {guest.balance === null ? 'Баланс недоступний' : `${fmtNum(guest.balance)} бонусів`}
              </dd>
              <dt>Телеграм-бот</dt>
              <dd>{guest.linkedToBot ? 'Привʼязаний' : 'Не привʼязаний'}</dd>
            </dl>
          </section>

          <OperationForm
            key={guest.syrveCustomerId} // другой гость — новая форма: свой ключ, без блокировки предыдущего
            guestId={guest.syrveCustomerId}
            onDone={() => load(`/guests/${guest.syrveCustomerId}`).catch(fail)}
            onError={fail}
          />

          <section>
            <h2>Журнал операцій</h2>
            {journal.length === 0 ? (
              <p className="muted">Операцій ще не було.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Коли</th>
                    <th>Хто</th>
                    <th>Тип</th>
                    <th>Сума</th>
                    <th>Причина</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {journal.map((op) => (
                    <tr key={op.id}>
                      <td>{fmtDate(op.createdAt)}</td>
                      <td>{op.admin}</td>
                      <td>{TYPE[op.type]}</td>
                      <td className="num">{fmtNum(op.amount)}</td>
                      <td>{op.reason}</td>
                      <td className={`status ${op.status.toLowerCase()}`}>
                        {STATUS[op.status]}
                        {op.error && <div className="muted">{op.error}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}

const PENDING_POLLS = 15;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function OperationForm(props: { guestId: string; onDone: () => void; onError: (err: unknown) => void }) {
  const [type, setType] = useState<OpType>('TOPUP');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  // Один ключ на «открытую форму»: двойной клик и повтор после обрыва связи уходят с тем же ключом.
  const [key, setKey] = useState(newIdempotencyKey);
  const [result, setResult] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);

  // UNKNOWN: операция могла примениться. Ключ и поля замораживаем — повтор вернёт ту же операцию,
  // новую можно начать только явной кнопкой после сверки в Syrve.
  const unknown = result?.status === 'UNKNOWN';
  // PENDING после ожидания: повтор с тем же ключом безопасен, но поля менять нельзя (иначе 409).
  const pending = result?.status === 'PENDING';
  const frozen = busy || unknown || pending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (unknown) return;
    setBusy(true);
    const body = { idempotencyKey: key, type, amount: Number(amount.replace(',', '.')), reason };
    const send = () => api<Operation>(`/guests/${props.guestId}/operations`, { method: 'POST', body });
    try {
      // PENDING = тот же ключ ещё выполняется (двойной клик, другая вкладка): ждём итог тем же запросом.
      let op = await send();
      for (let i = 0; op.status === 'PENDING' && i < PENDING_POLLS; i++) {
        await sleep(1000);
        op = await send();
      }
      setResult(op);
      if (op.status === 'SUCCESS' || op.status === 'FAILED') setKey(newIdempotencyKey());
      if (op.status === 'SUCCESS') {
        setAmount('');
        setReason('');
      }
      props.onDone();
    } catch (err) {
      props.onError(err); // ответа нет или ошибка валидации — ключ не меняем, повтор безопасен
    } finally {
      setBusy(false);
    }
  }

  // Явное действие после сверки в кабинете Syrve: новая операция с новым ключом.
  function startNew() {
    setKey(newIdempotencyKey());
    setAmount('');
    setReason('');
    setResult(null);
  }

  return (
    <section className="card">
      <h2>Нарахувати / списати</h2>
      <form className="stack" onSubmit={submit}>
        <fieldset className="stack plain" disabled={frozen}>
          <div className="row">
            <label className="radio">
              <input type="radio" checked={type === 'TOPUP'} onChange={() => setType('TOPUP')} /> Нарахувати
            </label>
            <label className="radio">
              <input type="radio" checked={type === 'CHARGEOFF'} onChange={() => setType('CHARGEOFF')} /> Списати
            </label>
          </div>
          <label>
            Сума
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100" required />
          </label>
          <label>
            Причина
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={3}
              maxLength={200}
              placeholder="Напр. компенсація за затримку замовлення"
              required
            />
          </label>
        </fieldset>
        {!unknown && (
          <button disabled={busy}>
            {busy ? 'Виконується…' : pending ? 'Перевірити статус' : type === 'TOPUP' ? 'Нарахувати' : 'Списати'}
          </button>
        )}
      </form>

      {result && !unknown && (
        <p className={`status ${result.status.toLowerCase()}`}>
          {pending ? 'Операція ще обробляється. Натисніть «Перевірити статус» трохи пізніше.' : STATUS[result.status]}
          {result.error ? `: ${result.error}` : ''}
        </p>
      )}
      {unknown && (
        <div className="warning">
          <p>
            <strong>Результат операції невідомий.</strong> {result?.error} Не повторюйте операцію — спершу перевірте
            баланс і транзакції гостя в кабінеті Syrve.
          </p>
          <button type="button" onClick={startNew}>
            Я перевірив у Syrve — нова операція
          </button>
        </div>
      )}
    </section>
  );
}
