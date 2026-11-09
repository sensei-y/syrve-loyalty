// Склонение слова «бонус» по правилам украинского языка (CLDR через Intl):
// 1, 21 → бонус; 2–4, 22 → бонуси; 5–20, 25, 0 → бонусів. Дробные (other) → бонусів.
const plural = new Intl.PluralRules('uk');

export function bonusWord(n: number): string {
  switch (plural.select(Math.abs(n))) {
    case 'one':
      return 'бонус';
    case 'few':
      return 'бонуси';
    default:
      return 'бонусів';
  }
}

// Число для показа: целые без дробной части, иначе 2 знака.
export function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// «1 бонус», «22 бонуси», «−400 бонусів».
export function formatBonuses(n: number): string {
  return `${formatAmount(n)} ${bonusWord(n)}`;
}
