import { useEffect, useState } from 'react';
import { api } from './api';
import { GuestPage } from './GuestPage';
import { Login } from './Login';

// Без входа видна только форма логина: все данные идут через /api, закрытый AuthGuard.
export function App() {
  const [admin, setAdmin] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    api<{ login: string }>('/auth/me')
      .then((me) => setAdmin(me.login))
      .catch(() => setAdmin(null));
  }, []);

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAdmin(null);
  }

  if (admin === undefined) return <main className="page muted">Завантаження…</main>;
  if (admin === null) return <Login onLogin={setAdmin} />;

  return (
    <main className="page">
      <header className="header">
        <h1>Програма лояльності</h1>
        <span className="muted">
          {admin} · <button className="link" onClick={logout}>Вийти</button>
        </span>
      </header>
      <GuestPage onUnauthorized={() => setAdmin(null)} />
    </main>
  );
}
