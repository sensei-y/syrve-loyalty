import { FormEvent, useState } from 'react';
import { api } from './api';

export function Login({ onLogin }: { onLogin: (login: string) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api<{ login: string }>('/auth/login', { method: 'POST', body: { login, password } });
      onLogin(me.login);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <h1>Вхід в адмін-панель</h1>
      <form className="stack" onSubmit={submit}>
        <label>
          Логін
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? 'Вхід…' : 'Увійти'}</button>
      </form>
    </main>
  );
}
