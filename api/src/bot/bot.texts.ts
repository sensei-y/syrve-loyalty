import { formatBonuses } from '../common/bonus';

// Строка истории для бота (Д1). Комментарий операции гостю не показываем:
// у ручных операций там «причина — логин админа».
export interface HistoryItem {
  createdAt: string;
  sum: number;
  balanceAfter: number | null;
}

// Все тексты бота — на украинском (правило проекта).
export const T = {
  welcome:
    'Вітаємо в програмі лояльності! 👋\n\nЩоб отримати картку, надішліть свій номер телефону кнопкою нижче.',
  sendContactButton: '📱 Надіслати контакт',
  myCardButton: '💳 Моя картка',
  historyButton: '📜 Історія',
  notOwnContact: 'Надішліть, будь ласка, власний контакт — кнопкою «Надіслати контакт» нижче.',
  invalidPhone: 'Наразі підтримуються лише українські номери (+380). Спробуйте інший номер.',
  askName: 'Як до вас звертатися? Напишіть імʼя або оберіть варіант нижче.',
  invalidName: 'Імʼя має містити від 2 до 50 символів. Спробуйте ще раз.',
  notRegistered: 'Ви ще не зареєстровані. Натисніть /start, щоб отримати картку.',
  unknown: 'Не зовсім зрозумів. Натисніть «Моя картка» або «Історія».',
  unavailable: 'Сервіс тимчасово недоступний. Спробуйте, будь ласка, трохи пізніше.',
  registered: (name: string) => `Готово, ${name}! Ваша картка лояльності 👇`,
  // balance = null — у гостя нет кошелька программы: не показываем ложный ноль.
  card: (cardNumber: string, balance: number | null) =>
    `💳 Картка: ${cardNumber}\n` +
    (balance === null ? '💰 Баланс недоступний' : `💰 Баланс: ${formatBonuses(balance)}`) +
    '\n\nПокажіть QR-код касиру.',
  history: (items: HistoryItem[]) =>
    items.length === 0
      ? '📜 Операцій ще не було.'
      : `📜 Останні операції:\n\n${items.map(historyLine).join('\n')}`,
};

// «09.11, 19:46 · +1 бонус · баланс 3 бонуси» — время по Киеву.
export function historyLine(item: HistoryItem): string {
  const sign = item.sum > 0 ? '+' : '−';
  const balance = item.balanceAfter === null ? '' : ` · баланс ${formatBonuses(item.balanceAfter)}`;
  return `${kyivTime(item.createdAt)} · ${sign}${formatBonuses(Math.abs(item.sum))}${balance}`;
}

function kyivTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
