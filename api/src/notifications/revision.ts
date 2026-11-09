import { SyrveClient } from '../syrve/syrve-client.interface';

// Без лимита по истории гостя «текущую» ревизию не узнать: запрос с ревизией из будущего
// Syrve просто возвращает обратно (проверено). Поэтому — пройти страницы до конца.
const MAX_BASELINE_PAGES = 200; // 10 000 транзакций — с запасом для гостя

// Последняя ревизия в истории гостя — базовая точка для уведомлений (всё, что до неё, не шлём).
// 0n — у гостя нет ни одной транзакции.
export async function latestRevision(syrve: SyrveClient, customerId: string): Promise<bigint> {
  let revision = 0n;
  for (let page = 0; page < MAX_BASELINE_PAGES; page++) {
    const p = await syrve.transactions(customerId, revision);
    if (p.lastRevision <= revision) break;
    revision = p.lastRevision;
    if (!p.hasMore) break;
  }
  return revision;
}
