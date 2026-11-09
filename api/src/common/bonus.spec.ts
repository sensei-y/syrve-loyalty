import { bonusWord, formatBonuses } from './bonus';

describe('bonusWord', () => {
  it.each([
    [1, 'бонус'],
    [2, 'бонуси'],
    [5, 'бонусів'],
    [11, 'бонусів'],
    [21, 'бонус'],
    [22, 'бонуси'],
    [25, 'бонусів'],
    [0, 'бонусів'],
    [-1, 'бонус'],
    [-400, 'бонусів'],
  ])('%d → %s', (n, word) => {
    expect(bonusWord(n)).toBe(word);
  });

  it('formatBonuses: число й слово', () => {
    expect(formatBonuses(1)).toBe('1 бонус');
    expect(formatBonuses(22)).toBe('22 бонуси');
    expect(formatBonuses(12.5)).toBe('12.50 бонусів');
  });
});
