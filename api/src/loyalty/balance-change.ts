import { AppConfig } from '../config/config.schema';
import { MOCK_WALLET_ID } from '../syrve/mock-syrve.client';
import { SyrveTransaction } from '../syrve/syrve-client.interface';

// Кошелёк нашей программы (в mock-режиме без SYRVE_WALLET_ID — кошелёк mock), в нижнем регистре.
export function programWalletId(cfg: Pick<AppConfig, 'SYRVE_WALLET_ID'>): string {
  return (cfg.SYRVE_WALLET_ID ?? MOCK_WALLET_ID).toLowerCase();
}

// Изменение баланса гостя — одно правило для уведомлений (О6) и истории (Д1):
// только наш кошелёк и ненулевая сумма. Служебные записи (SetGuestCategory: sum 0, walletId null)
// и другие программы организации не считаются.
export function isBalanceChange(tx: SyrveTransaction, walletId: string): boolean {
  return tx.walletId !== null && tx.walletId.toLowerCase() === walletId && tx.sum !== 0;
}
