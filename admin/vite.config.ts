import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В dev /api проксируется на локальный API — тот же origin, что и за nginx в Docker.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': process.env.VITE_API_URL ?? 'http://localhost:3000' },
  },
});
