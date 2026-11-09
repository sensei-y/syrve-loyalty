import { formatBonuses } from '../common/bonus';

// «Нараховано 10 бонусів. Баланс: 15 бонусів» / «Списано 1 бонус. Баланс: 2 бонуси».
// balanceAfter = null (Syrve не прислал) — без баланса.
export function notificationText(sum: number, balanceAfter: number | null): string {
  const action = sum > 0 ? 'Нараховано' : 'Списано';
  const balance = balanceAfter === null ? '' : ` Баланс: ${formatBonuses(balanceAfter)}`;
  return `${action} ${formatBonuses(Math.abs(sum))}.${balance}`;
}
