import { MockRedis } from './mock-syrve.client';

// Минимальная in-memory подмена команд, которые использует MockSyrveClient.
// Каждый метод меняет состояние до возврата Promise — как одна атомарная команда Redis.
export class FakeRedis implements MockRedis {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly sets = new Map<string, Set<string>>();
  readonly lists = new Map<string, string[]>();

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, mode: 'NX') {
    if (mode === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK' as const;
  }

  async del(...keys: string[]) {
    let count = 0;
    for (const key of keys) {
      const existed = this.strings.delete(key) || this.hashes.delete(key) || this.sets.delete(key) || this.lists.delete(key);
      if (existed) count++;
    }
    return count;
  }

  async hset(key: string, values: Record<string, string | number>) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    this.hashes.set(key, hash);
    let added = 0;
    for (const [field, value] of Object.entries(values)) {
      if (!hash.has(field)) added++;
      hash.set(field, String(value));
    }
    return added;
  }

  async hgetall(key: string) {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hincrbyfloat(key: string, field: string, increment: number) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    this.hashes.set(key, hash);
    const value = Number(hash.get(field) ?? '0') + increment;
    hash.set(field, String(value));
    return String(value);
  }

  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    this.sets.set(key, set);
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) added++;
      set.add(member);
    }
    return added;
  }

  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }

  async incr(key: string) {
    const value = BigInt(this.strings.get(key) ?? '0') + 1n;
    const text = value.toString();
    this.strings.set(key, text);
    return text;
  }

  async rpush(key: string, ...values: string[]) {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list);
    list.push(...values);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }
}
