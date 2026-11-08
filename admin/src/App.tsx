import { useEffect, useState } from 'react';

type Health = Record<string, unknown> & { status?: string };

async function load(path: string): Promise<Health> {
  try {
    const res = await fetch(path);
    return await res.json();
  } catch {
    return { status: 'unreachable' };
  }
}

// Заглушка: показывает, что связка nginx → API → Postgres/Redis/Syrve жива.
// Этап 4: вход, поиск гостя. Этап 5: начисление/списание.
export function App() {
  const [api, setApi] = useState<Health | null>(null);
  const [syrve, setSyrve] = useState<Health | null>(null);

  useEffect(() => {
    void load('/api/health').then(setApi);
    void load('/api/health/syrve').then(setSyrve);
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '40px auto', padding: '0 16px' }}>
      <h1>Syrve Loyalty — адмін-панель</h1>
      <h2>API</h2>
      <pre>{api ? JSON.stringify(api, null, 2) : 'Завантаження…'}</pre>
      <h2>Syrve</h2>
      <pre>{syrve ? JSON.stringify(syrve, null, 2) : 'Завантаження…'}</pre>
    </main>
  );
}
