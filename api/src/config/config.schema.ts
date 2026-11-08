import { z } from 'zod';

// Единственное место, где читается process.env.
// Кривой .env → процесс падает на старте с понятной ошибкой, а не посреди работы.
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),

  SYRVE_MODE: z.enum(['real', 'mock']).default('mock'),
  SYRVE_API_URL: z.string().url().default('https://api-eu.syrve.live'),
  SYRVE_API_LOGIN: z.string().optional(),
  SYRVE_ORGANIZATION_ID: z.string().optional(),
  SYRVE_PROGRAM_ID: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
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
    const missing = (['SYRVE_API_LOGIN', 'SYRVE_ORGANIZATION_ID', 'SYRVE_PROGRAM_ID'] as const)
      .filter((k) => !cfg[k]);
    if (missing.length) {
      throw new Error(`SYRVE_MODE=real потребує: ${missing.join(', ')}`);
    }
  }
  return cfg;
}
