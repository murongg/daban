import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { Fault } from './control.js';

declare module 'playwright-core' {
  interface Mouse {
    move(
      x: number,
      y: number,
      options?: { steps?: number; signal?: AbortSignal },
    ): Promise<undefined>;
    down(options?: {
      button?: 'left' | 'middle' | 'right';
      signal?: AbortSignal;
    }): Promise<undefined>;
    up(options?: {
      button?: 'left' | 'middle' | 'right';
      signal?: AbortSignal;
    }): Promise<undefined>;
    click(
      x: number,
      y: number,
      options?: { button?: 'left' | 'middle' | 'right'; signal?: AbortSignal },
    ): Promise<undefined>;
    wheel(deltaX: number, deltaY: number, options?: { signal?: AbortSignal }): Promise<undefined>;
  }
  interface Keyboard {
    insertText(text: string, options?: { signal?: AbortSignal }): Promise<undefined>;
    press(key: string, options?: { delay?: number; signal?: AbortSignal }): Promise<undefined>;
  }
}

// shortcut: Playwright 1.62.1 omits AbortSignal on raw input; remove this shim when those public APIs forward native cancellation.
export function patchInput(source: string, version: string) {
  const start = source.indexOf('Keyboard2 = class {'),
    end = source.indexOf('Touchscreen2 = class {', start);
  if (version !== '1.62.1' || start < 0 || end < 0)
    throw new Fault('BROWSER_INPUT_ENGINE_UNSUPPORTED', 503);
  let part = source.slice(start, end);
  for (const [before, after] of [
    ['async insertText(text2)', 'async insertText(text2, options = {})'],
    ['async wheel(deltaX, deltaY)', 'async wheel(deltaX, deltaY, options = {})'],
  ]) {
    if (part.split(before).length !== 2) throw new Fault('BROWSER_INPUT_ENGINE_UNSUPPORTED', 503);
    part = part.replace(before, after);
  }
  for (const method of [
    'keyboardInsertText',
    'keyboardPress',
    'mouseMove',
    'mouseDown',
    'mouseUp',
    'mouseClick',
    'mouseWheel',
  ]) {
    const lines = part.split('\n'),
      matches = lines
        .map((line, index) => (line.includes(`this._page._channel.${method}(`) ? index : -1))
        .filter((index) => index >= 0);
    if (matches.length !== 1 || !lines[matches[0]].includes(', kNoTimeout);'))
      throw new Fault('BROWSER_INPUT_ENGINE_UNSUPPORTED', 503);
    lines[matches[0]] = lines[matches[0]].replace(
      ', kNoTimeout);',
      ', { ...kNoTimeout, signal: options.signal });',
    );
    part = lines.join('\n');
  }
  return source.slice(0, start) + part + source.slice(end);
}

let engine: Promise<typeof import('playwright')> | undefined;
export function browserEngine() {
  engine ??= (async () => {
    let patched = false;
    const hooks = registerHooks({
      load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        if (!url.endsWith('/playwright-core/lib/coreBundle.js')) return result;
        const version = JSON.parse(readFileSync(new URL('../package.json', url), 'utf8')).version;
        const source = patchInput(readFileSync(new URL(url), 'utf8'), version);
        patched = true;
        return { ...result, source };
      },
    });
    try {
      const loaded = (await import(
        process.env.PLAYWRIGHT_MODULE || 'playwright'
      )) as typeof import('playwright');
      if (!patched) throw new Fault('BROWSER_INPUT_ENGINE_UNSUPPORTED', 503);
      return loaded;
    } finally {
      hooks.deregister();
    }
  })();
  return engine;
}
