export type ClientCache = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
let override: ClientCache | undefined;

// Previews inject a store before mounting; normal clients keep their original browser storage and keys.
export function clientCache(): ClientCache {
  return override ?? localStorage;
}
export function setCache(storage?: ClientCache) {
  override = storage;
}

export function cacheForHost(host: string | null): ClientCache {
  const storage = clientCache();
  if (host === null) return storage;
  if (!/^[a-f0-9]{64}$/.test(host)) throw Error('REMOTE_INVALID_HOST');
  const prefix = `daban.host.${host}.`;
  // Capture the backing store and namespace; late work must never follow the active selection.
  return {
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: (key) => storage.removeItem(prefix + key),
  };
}
