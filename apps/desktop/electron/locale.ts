import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isLocale, type Locale } from '../shared/locale';

export class LocalePreferences {
  readonly ready: Promise<unknown>;
  current: Locale = 'zh-CN';
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {
    this.ready = this.load();
  }
  private async load() {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (value && typeof value === 'object' && 'locale' in value && isLocale(value.locale))
        this.current = value.locale;
    } catch {
      // A missing or damaged appearance preference never blocks Agent startup or resets user data.
    }
  }
  change(locale: Locale) {
    if (!isLocale(locale)) return Promise.reject(new Error('INVALID_LOCALE'));
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        await this.ready;
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, locale }), {
            flag: 'wx',
            mode: 0o600,
          });
          await rename(temporary, this.file);
          this.current = locale;
        } finally {
          await unlink(temporary).catch((error) => {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
              return;
            throw error;
          });
        }
      });
    return this.pending;
  }
}
