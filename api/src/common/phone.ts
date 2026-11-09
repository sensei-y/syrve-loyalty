// Единый формат телефона во всём сервисе и в запросах к Syrve: +380XXXXXXXXX.
// null — номер не украинский или некорректный.
// Принимает: +380 99 123 45 67, 380991234567 (так шлёт Telegram), 0991234567, (099) 123-45-67.
export function normalizePhone(input: string): string | null {
  if (!/^[\d\s()+-]+$/.test(input.trim())) return null;
  const digits = input.replace(/\D/g, '');

  let national: string;
  if (digits.length === 12 && digits.startsWith('380')) national = digits.slice(3);
  else if (digits.length === 10 && digits.startsWith('0')) national = digits.slice(1);
  else if (digits.length === 9) national = digits;
  else return null;

  return /^[1-9]\d{8}$/.test(national) ? `+380${national}` : null;
}
