import { AppConfig } from '../config/config.schema';
import { MOCK_WALLET_ID } from '../syrve/mock-syrve.client';
import { SyrveTransaction } from '../syrve/syrve-client.interface';

// В mock id фиксирован и не зависит от оставшихся в .env real-настроек.
export function programWalletId(cfg: Pick<AppConfig, 'SYRVE_MODE' | 'SYRVE_WALLET_ID'>): string {
  return (cfg.SYRVE_MODE === 'real' ? cfg.SYRVE_WALLET_ID! : MOCK_WALLET_ID).toLowerCase();
}

// Изменение баланса гостя — одно правило для уведомлений (О6) и истории (Д1):
// только наш кошелёк и ненулевая сумма. Служебные записи (SetGuestCategory: sum 0, walletId null)
// и другие программы организации не считаются.
export function isBalanceChange(tx: SyrveTransaction, walletId: string): boolean {
  return tx.walletId !== null && tx.walletId.toLowerCase() === walletId && tx.sum !== 0;
}
