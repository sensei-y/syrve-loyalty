import { loadConfig } from './config.schema';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  ADMIN_LOGIN: 'admin',
  ADMIN_PASSWORD: 'test-password',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadConfig: id Syrve', () => {
  it('приймає реальні id Syrve (не RFC 4122)', () => {
    const cfg = loadConfig({
      ...base,
      SYRVE_ORGANIZATION_ID: '67018360-fb28-4d49-b4e0-391d83ec6c57',
      SYRVE_PROGRAM_ID: '0eaa0000-29b3-b8cb-5653-08de79e05361',
      SYRVE_WALLET_ID: '0eaa0000-29b3-b8cb-7be7-08de79e05361',
    });
    expect(cfg.SYRVE_PROGRAM_ID).toBe('0eaa0000-29b3-b8cb-5653-08de79e05361');
    expect(cfg.SYRVE_WALLET_ID).toBe('0eaa0000-29b3-b8cb-7be7-08de79e05361');
  });

  it('порожній рядок → undefined (mock-режим без id)', () => {
    const cfg = loadConfig({ ...base, SYRVE_ORGANIZATION_ID: '', SYRVE_PROGRAM_ID: '', SYRVE_WALLET_ID: '' });
    expect(cfg.SYRVE_ORGANIZATION_ID).toBeUndefined();
    expect(cfg.SYRVE_PROGRAM_ID).toBeUndefined();
    expect(cfg.SYRVE_WALLET_ID).toBeUndefined();
  });

  it('відхиляє id не того формату', () => {
    expect(() => loadConfig({ ...base, SYRVE_PROGRAM_ID: 'not-an-id' })).toThrow('SYRVE_PROGRAM_ID');
  });

  it('real-режим без id → помилка старту', () => {
    expect(() => loadConfig({ ...base, SYRVE_MODE: 'real', SYRVE_API_LOGIN: 'x' })).toThrow('SYRVE_ORGANIZATION_ID');
  });
});

describe('loadConfig: адмін-панель', () => {
  it('без ADMIN_PASSWORD і JWT_SECRET — помилка старту з назвами змінних', () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL, ADMIN_LOGIN: 'admin' })).toThrow(
      /ADMIN_PASSWORD[\s\S]*JWT_SECRET/,
    );
  });

  it('короткий JWT_SECRET відхиляється', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
  });
});
