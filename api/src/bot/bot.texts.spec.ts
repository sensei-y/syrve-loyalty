import { historyLine, T } from './bot.texts';

describe('бот: тексти історії (Д1)', () => {
  it('рядок: час за Києвом, знак, склонення, баланс після', () => {
    // 17:46 UTC = 19:46 у Києві (листопад, UTC+2)
    expect(historyLine({ createdAt: '2026-11-09T17:46:59.432Z', sum: 1, balanceAfter: 3 })).toBe(
      '09.11, 19:46 · +1 бонус · баланс 3 бонуси',
    );
    expect(historyLine({ createdAt: '2026-11-09T08:50:58.833Z', sum: -5, balanceAfter: 22 })).toBe(
      '09.11, 10:50 · −5 бонусів · баланс 22 бонуси',
    );
  });

  it('без balanceAfter — без балансу; дата, яку не розібрати, — прочерк', () => {
    expect(historyLine({ createdAt: '', sum: 2, balanceAfter: null })).toBe('— · +2 бонуси');
  });

  it('порожня історія і список', () => {
    expect(T.history([])).toBe('📜 Операцій ще не було.');
    expect(
      T.history([
        { createdAt: '2026-11-09T17:46:59Z', sum: 1, balanceAfter: 4 },
        { createdAt: '2026-11-09T17:46:00Z', sum: 1, balanceAfter: 3 },
      ]),
    ).toBe('📜 Останні операції:\n\n09.11, 19:46 · +1 бонус · баланс 4 бонуси\n09.11, 19:46 · +1 бонус · баланс 3 бонуси');
  });
});
