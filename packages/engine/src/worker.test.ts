import type { BrowserContext, Page } from 'playwright';
import { expect, test, vi } from 'vitest';
import { Browser } from './runtime.js';

test('restarting during an in-flight stop leaves only the new worker loop alive', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let release!: () => unknown;
  let entered!: () => unknown;
  let clicks = 0;
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const ready = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const page = {
    locator: () => ({
      click: async () => {
        clicks++;
        if (clicks === 1) {
          entered();
          await gate;
        }
      },
    }),
  };
  const browser = new Browser(
    { close: async () => {} } as unknown as BrowserContext,
    new Map<string, Page>([
      ['a', page as unknown as Page],
      ['b', page as unknown as Page],
    ]),
    100,
  );
  await browser.startWorker('a');
  vi.advanceTimersByTime(0);
  await ready;
  const stopping = browser.stopWorker('a');
  await browser.startWorker('a');
  vi.advanceTimersByTime(0);
  release();
  await stopping;
  await new Promise(setImmediate);
  expect(clicks).toBe(2);
  vi.advanceTimersByTime(100);
  await new Promise(setImmediate);
  expect(clicks, 'the retired loop must not schedule another click').toBe(3);
  await browser.close();
});

test('a failure from the retired worker cannot stop its replacement', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let release!: () => unknown;
  let entered!: () => unknown;
  let clicks = 0;
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const ready = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const page = {
    locator: () => ({
      click: async () => {
        if (++clicks === 1) {
          entered();
          await gate;
          throw new Error('synthetic retired operation failed');
        }
      },
    }),
  };
  const browser = new Browser(
    { close: async () => {} } as unknown as BrowserContext,
    new Map<string, Page>([
      ['a', page as unknown as Page],
      ['b', page as unknown as Page],
    ]),
    100,
  );
  await browser.startWorker('a');
  vi.advanceTimersByTime(0);
  await ready;
  const stopping = browser.stopWorker('a');
  await browser.startWorker('a');
  vi.advanceTimersByTime(0);
  release();
  await stopping;
  await new Promise(setImmediate);
  expect(browser.workers.get('a')?.running).toBe(true);
  expect(browser.workers.get('a')?.error).toBe(null);
  await browser.close();
});

test('the same fenced scheduler can execute a native desktop action', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const calls: string[] = [];
  const page = {
    locator: () => ({ click: async () => expect.unreachable('browser action must not run') }),
  };
  const browser = new Browser(
    { close: async () => {} } as unknown as BrowserContext,
    new Map<string, Page>([
      ['a', page as unknown as Page],
      ['b', page as unknown as Page],
    ]),
    100,
    async (id) => {
      calls.push(id);
    },
  );
  await browser.startWorker('a');
  vi.advanceTimersByTime(0);
  await new Promise(setImmediate);
  expect(calls).toStrictEqual(['a']);
  await browser.close();
});

test('general pages never enter fixture scraping or the deterministic demo worker', async () => {
  const page = {
    url: () => 'https://public.example.test/mock',
    evaluate: async () => expect.unreachable('a general page must not be scraped as a fixture'),
    locator: () => ({
      click: async () => expect.unreachable('a demo worker must not click a general page'),
    }),
  };
  const browser = new Browser(
    {
      cookies: async () => [],
      browser: () => ({ version: () => 'synthetic-browser' }),
      close: async () => {},
    } as unknown as BrowserContext,
    new Map([
      ['a', page as unknown as Page],
      ['b', page as unknown as Page],
    ]),
    100,
  );
  browser.origin = 'http://127.0.0.1:18766';
  try {
    const snapshot = await browser.snapshot();
    expect(snapshot.bots.a.count).toBe(0);
    expect(snapshot.bots.a.identity).toBe('');
    expect(snapshot.bots.a.note).toBe('');
    await expect(browser.startWorker('a')).rejects.toMatchObject({ code: 'DEMO_PAGE_REQUIRED' });
    expect(browser.workers.get('a')?.running).toBe(false);
  } finally {
    await browser.close();
  }
});

test('an old browser frame completion cannot evict the selected tab frame', async () => {
  let first!: (value: Buffer) => unknown, second!: (value: Buffer) => unknown;
  const oldFrame = new Promise<Buffer>((resolve) => {
    first = resolve;
  });
  const newFrame = new Promise<Buffer>((resolve) => {
    second = resolve;
  });
  const oldPage = { screenshot: () => oldFrame },
    newPage = { screenshot: () => newFrame };
  const browser = new Browser(
    { close: async () => {} } as unknown as BrowserContext,
    new Map([
      ['a', oldPage as unknown as Page],
      ['b', oldPage as unknown as Page],
    ]),
    100,
  );
  try {
    const previous = browser.frame('a');
    browser.frames.delete('a');
    browser.pages.set('a', newPage as unknown as Page);
    const selected = browser.frame('a');
    const cached = browser.frames.get('a');
    first(Buffer.from('SYNTHETIC-OLD-FRAME'));
    await previous;
    expect(browser.frames.get('a'), 'only the promise that owns the cache slot may evict it').toBe(
      cached,
    );
    second(Buffer.from('SYNTHETIC-SELECTED-FRAME'));
    expect((await selected).toString()).toBe('SYNTHETIC-SELECTED-FRAME');
  } finally {
    first(Buffer.alloc(0));
    second(Buffer.alloc(0));
    await browser.close();
  }
});
