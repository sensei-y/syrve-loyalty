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

function OperationForm(props: { guestId: string; onDone: () => void; onError: (err: unknown) => void }) {
  const [type, setType] = useState<OpType>('TOPUP');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  // Один ключ на «открытую форму»: двойной клик и повтор после обрыва связи уходят с тем же ключом.
  const [key, setKey] = useState(newIdempotencyKey);
  const [result, setResult] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const op = await api<Operation>(`/guests/${props.guestId}/operations`, {
        method: 'POST',
        body: { idempotencyKey: key, type, amount: Number(amount.replace(',', '.')), reason },
      });
      setResult(op);
      if (op.status !== 'PENDING') setKey(newIdempotencyKey()); // операция завершена — следующая будет новой
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

  return (
    <section className="card">
      <h2>Нарахувати / списати</h2>
      <form className="stack" onSubmit={submit}>
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
        <button disabled={busy}>{busy ? 'Виконується…' : type === 'TOPUP' ? 'Нарахувати' : 'Списати'}</button>
      </form>
      {result && (
        <p className={`status ${result.status.toLowerCase()}`}>
          {STATUS[result.status]}
          {result.error ? `: ${result.error}` : ''}
        </p>
      )}
    </section>
  );
}
