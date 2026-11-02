import { isLocale, localeStorageKey } from '../shared/locale';
import { type ClientCache, clientCache, setCache } from '../src/app/cache';

export function previewStorage(storage: ClientCache, scene: string): ClientCache {
  const prefix = `daban.preview:${scene}:`;
  return {
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: (key) => storage.removeItem(prefix + key),
  };
}
export async function startPreview(
  storage: ClientCache,
  scene: string,
  load: () => Promise<unknown>,
  language?: string | null,
) {
  // The App and its persistence modules must load after this boundary, including their initial reads.
  setCache(previewStorage(storage, scene));
  if (isLocale(language)) clientCache().setItem(localeStorageKey, language);
  const locale = clientCache().getItem(localeStorageKey);
  document.documentElement.lang = isLocale(locale) ? locale : 'zh-CN';
  await load();
}
