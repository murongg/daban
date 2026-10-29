import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const originalHead = document.head.innerHTML;
beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.head.innerHTML = originalHead;
  document.body.innerHTML = '';
});

it('removes an old diagnostic desktop frame and refuses typing while the replacement screen has not been observed', async () => {
  vi.useFakeTimers();
  const fixture = new DOMParser().parseFromString(
    readFileSync(path.resolve('apps/runtime/src/index.html'), 'utf8'),
    'text/html',
  );
  document.head.innerHTML = fixture.head.innerHTML.replace(
    '__PROTOTYPE_TOKEN__',
    'synthetic-token',
  );
  document.body.innerHTML = fixture.body.innerHTML;
  class SyntheticURL extends URL {
    static createObjectURL() {
      return 'blob:synthetic-frame';
    }
    static revokeObjectURL() {}
  }
  vi.stubGlobal('URL', SyntheticURL);
  const bot = (instance: string) => ({
    instance,
    owner: 'human',
    epoch: 1,
    running: false,
    error: null,
    count: 0,
    identity: '',
    note: '',
    desktop: { display: ':41', steps: 0, lastAction: '', windows: [] },
  });
  const state = {
    mode: 'desktop',
    viewport: { width: 1280, height: 800 },
    environment: { platform: 'linux', arch: 'arm64' },
    bots: { a: bot('mock-native-old'), b: bot('mock-native-b') },
    events: [],
    sharedLogin: false,
  };
  let finish!: (value: Response) => unknown;
  const replacement = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const typed: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/state') return Response.json(state);
    if (url.endsWith('/input')) {
      typed.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    if (url.includes('/frame')) {
      const query = new URLSearchParams(url.split('?')[1]);
      return query.get('instance') === 'mock-native-new'
        ? replacement
        : new Response('SYNTHETIC-OLD-JPEG');
    }
    throw new Error('Unexpected synthetic diagnostic request');
  });
  try {
    await import('../src/app');
    expect(document.querySelector('[data-bot="a"] img')).toHaveAttribute('src');
    state.bots.a = bot('mock-native-new');
    await vi.advanceTimersByTimeAsync(600);
    expect(document.querySelector('[data-bot="a"] img')).not.toHaveAttribute('src');
    const input = document.querySelector<HTMLInputElement>('[data-bot="a"] .typing input')!;
    input.value = 'NEVER-TYPE';
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(typed).toEqual([]);
  } finally {
    finish(new Response('SYNTHETIC-NEW-JPEG'));
  }
});

it('keeps the diagnostic page truthful and stops frame polling when graphics are unavailable', async () => {
  vi.useFakeTimers();
  const source = readFileSync(path.resolve('apps/runtime/src/index.html'), 'utf8');
  const fixture = new DOMParser().parseFromString(source, 'text/html');
  document.head.innerHTML = fixture.head.innerHTML.replace(
    '__PROTOTYPE_TOKEN__',
    'synthetic-token',
  );
  document.body.innerHTML = fixture.body.innerHTML;
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requested.push(url);
    if (url !== '/api/state') throw new Error('Synthetic unavailable computer must not be polled');
    return Response.json({
      mode: 'agent',
      computerError: 'COMPUTER_START_FAILED',
      environment: { platform: 'linux', arch: 'arm64' },
      bots: {},
      events: [],
      sharedLogin: false,
    });
  });
  await import('../src/app');
  expect(document.querySelector('h1')).toHaveTextContent('普通 Agent 已就绪');
  expect(document.querySelector('#connection')).toHaveTextContent('电脑暂不可用');
  expect(document.querySelector('#screens')).not.toBeVisible();
  expect(document.querySelector('#model-settings')).toBeVisible();
  await vi.advanceTimersByTimeAsync(1400);
  expect(requested).not.toContain('/api/bots/a/frame');
  expect(requested).not.toContain('/api/bots/b/frame');
  expect(document.querySelector('#notice')).not.toHaveTextContent('接管');
});
