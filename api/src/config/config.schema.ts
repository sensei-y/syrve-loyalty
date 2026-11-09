import { z } from 'zod';

// id Syrve не соответствуют RFC 4122 (биты версии/варианта произвольные), поэтому не z.string().uuid().
const SYRVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Пустое значение из .env (`SYRVE_PROGRAM_ID=`) = не задано; mock-режим работает без id.
const syrveId = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().regex(SYRVE_ID_RE, 'очікується id формату xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx').optional(),
);

// Единственное место, где читается process.env.
// Кривой .env → процесс падает на старте с понятной ошибкой, а не посреди работы.
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),

  SYRVE_MODE: z.enum(['real', 'mock']).default('mock'),
  SYRVE_API_URL: z.url().default('https://api-eu.syrve.live'),
  SYRVE_API_LOGIN: z.string().optional(),
  SYRVE_ORGANIZATION_ID: syrveId,
  SYRVE_PROGRAM_ID: syrveId,
  SYRVE_WALLET_ID: syrveId,

  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // Админ панели создаётся/обновляется из .env при старте api; пароль хранится как scrypt-хэш.
  ADMIN_LOGIN: z.string().trim().min(3, 'мінімум 3 символи'),
  ADMIN_PASSWORD: z.string().min(8, 'мінімум 8 символів'),
  // Подпись JWT в cookie сессии админа.
  JWT_SECRET: z.string().min(32, 'мінімум 32 символи (згенеруйте: openssl rand -hex 32)'),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Невалідний .env:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.SYRVE_MODE === 'real') {
    const missing = (['SYRVE_API_LOGIN', 'SYRVE_ORGANIZATION_ID', 'SYRVE_PROGRAM_ID', 'SYRVE_WALLET_ID'] as const)
      .filter((k) => !cfg[k]);
    if (missing.length) {
      throw new Error(`SYRVE_MODE=real потребує: ${missing.join(', ')}`);
    }
  }
  return cfg;
}
