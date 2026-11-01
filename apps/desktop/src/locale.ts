import { useSyncExternalStore } from 'react';
import {
  isLocale,
  type Locale,
  localeStorageKey,
  type MessageKey,
  type Parameters,
  translate,
} from '../locale';
import { clientCache } from './cache';

export { isMessageKey } from '../locale';
export type { MessageKey };
export { localeStorageKey };

let generation = 0;
const listeners = new Set<() => unknown>();
export function getLocale(): Locale {
  try {
    const value = clientCache().getItem(localeStorageKey);
    return isLocale(value) ? value : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}
function publish() {
  document.documentElement.lang = getLocale();
  for (const listener of listeners) listener();
}
function storage(event: StorageEvent) {
  if (event.key === localeStorageKey || event.key === null) publish();
}
function subscribe(listener: () => unknown) {
  if (!listeners.size) {
    document.documentElement.lang = getLocale();
    window.addEventListener('storage', storage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', storage);
  };
}
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, () => 'zh-CN' as const);
}
export function t(key: MessageKey | undefined, values?: Parameters) {
  return translate(getLocale(), key, values);
}
export async function setLocale(locale: Locale) {
  if (!isLocale(locale)) throw new Error('INVALID_LOCALE');
  const ticket = ++generation;
  const bridge = window.daban?.locale;
  if (bridge) {
    const result = await bridge.invoke({ type: 'set', locale });
    if (!result.ok) throw new Error(result.error);
    if (result.value !== locale) throw new Error('INVALID_LOCALE_REPLY');
  }
  if (ticket !== generation) return;
  clientCache().setItem(localeStorageKey, locale);
  publish();
}
export function syncLocale() {
  const bridge = window.daban?.locale;
  if (!bridge) return () => {};
  let live = true;
  // A late native preference read must not overwrite a language selected while it was loading.
  const ticket = generation;
  bridge
    .invoke({ type: 'get' })
    .then((result) => {
      if (!live || ticket !== generation) return;
      if (!result.ok || !isLocale(result.value)) throw new Error('INVALID_LOCALE_REPLY');
      clientCache().setItem(localeStorageKey, result.value);
      publish();
    })
    .catch(() => console.error('Could not restore interface language'));
  return () => {
    live = false;
  };
}
