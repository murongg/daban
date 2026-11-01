import type { RuntimeReply } from '@daban/protocol';
import { english } from './locales/en';

export type Locale = 'zh-CN' | 'en';
export type Parameters = Record<string, string | number>;
export type LocaleCommand = { type: 'get' } | { type: 'set'; locale: Locale };
export interface LocaleBridge {
  invoke(command: LocaleCommand): Promise<RuntimeReply<Locale>>;
}
export const isLocale = (value: unknown): value is Locale => value === 'zh-CN' || value === 'en';
// Only application-owned copy belongs in this catalog; authored messages and file bodies stay literal.
export function translate(locale: Locale, source: string | undefined, values: Parameters = {}) {
  const copy =
    source === undefined
      ? ''
      : locale === 'en' && Object.hasOwn(english, source)
        ? english[source]
        : source;
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
