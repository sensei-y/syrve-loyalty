import { SyrveClient } from '../syrve/syrve-client.interface';

// Аварийный предел: 10 000 страниц × 50 = 500 000 транзакций одного гостя.
const MAX_BASELINE_PAGES = 10_000;

// Последняя ревизия в истории гостя — базовая точка для уведомлений (всё, что до неё, не шлём).
// «Текущую» ревизию не узнать без обхода истории: ревизию из будущего Syrve просто возвращает (проверено).
// Строго: либо дошли до конца истории, либо ошибка — промежуточную ревизию базой не считаем,
// иначе остаток старой истории ушёл бы гостю как новые операции. 0n — у гостя нет транзакций.
export async function latestRevision(syrve: SyrveClient, customerId: string): Promise<bigint> {
  let revision = 0n;
  for (let page = 0; page < MAX_BASELINE_PAGES; page++) {
    const p = await syrve.transactions(customerId, revision);
    if (!p.hasMore) return p.lastRevision > revision ? p.lastRevision : revision;
    if (p.lastRevision <= revision) {
      throw new Error(`Базова точка ${customerId}: ревізія не зростає (${revision}), хоча є ще сторінки`);
    }
    revision = p.lastRevision;
  }
  throw new Error(`Базова точка ${customerId}: понад ${MAX_BASELINE_PAGES} сторінок історії — не збережено`);
}
