import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { parseLocaleCommand } from '../shared/locale';
import { LocalePreferences } from './locale';

it('persists the last language and restores it from a synthetic local preference file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-language-'));
  try {
    const file = path.join(directory, 'locale.json');
    const preferences = new LocalePreferences(file);
    await preferences.ready;
    expect(preferences.current).toBe('zh-CN');
    await Promise.all([preferences.change('en'), preferences.change('zh-CN')]);
    const reopened = new LocalePreferences(file);
    await reopened.ready;
    expect(reopened.current).toBe('zh-CN');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, locale: 'zh-CN' });
    await writeFile(file, '{"version":1,"locale":"mock-invalid-locale"}');
    const invalid = new LocalePreferences(file);
    await invalid.ready;
    expect(invalid.current).toBe('zh-CN');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('accepts only the bounded locale command contract', () => {
  expect(parseLocaleCommand({ type: 'set', locale: 'en' })).toEqual({ type: 'set', locale: 'en' });
  for (const value of [null, {}, { type: 'set', locale: '../mock' }, { type: 'get', extra: true }])
    expect(() => parseLocaleCommand(value)).toThrow('INVALID_LOCALE_COMMAND');
});
