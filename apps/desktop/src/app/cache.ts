export type ClientCache = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
let override: ClientCache | undefined;

// Previews inject a store before mounting; normal clients keep their original browser storage and keys.
export function clientCache(): ClientCache {
  return override ?? localStorage;
}
export function setCache(storage?: ClientCache) {
  override = storage;
}
