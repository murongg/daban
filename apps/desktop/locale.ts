import type { RuntimeReply } from '@daban/protocol';
import { english, type MessageKey } from './locales/en';
import { chinese } from './locales/zh-CN';

export type { MessageKey };

export type Locale = 'zh-CN' | 'en';
export const localeStorageKey = 'daban.language.v1';
export type Parameters = Record<string, string | number>;
export type LocaleCommand = { type: 'get' } | { type: 'set'; locale: Locale };
export interface LocaleBridge {
  invoke(command: LocaleCommand): Promise<RuntimeReply<Locale>>;
}
export const isLocale = (value: unknown): value is Locale => value === 'zh-CN' || value === 'en';
// Only application-owned copy belongs in this catalog; authored messages and file bodies stay literal.
export const isMessageKey = (value: unknown): value is MessageKey =>
  typeof value === 'string' && Object.hasOwn(english, value);
export function translate(locale: Locale, key: string | undefined, values: Parameters = {}) {
  const copy = isMessageKey(key) ? (locale === 'en' ? english : chinese)[key] : (key ?? '');
  // Inserted names, user text and paths stay literal, even when they contain another placeholder.
  return copy.replace(/\{(\d+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder,
  );
}

export function parseLocaleCommand(value: unknown): LocaleCommand {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const command = value as Record<string, unknown>;
    if (command.type === 'get' && Object.keys(command).length === 1) return { type: 'get' };
    if (command.type === 'set' && Object.keys(command).length === 2 && isLocale(command.locale))
      return { type: 'set', locale: command.locale };
  }
  throw new Error('INVALID_LOCALE_COMMAND');
}
