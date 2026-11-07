import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright';
import { expect, it, vi } from 'vitest';
import { connectDesktop } from './browser-desktop.js';

it('does not redirect private bridge credentials to arbitrary hosts or accept a malformed manifest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-browser-desktop-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'browser-bridge.json');
  const connectOverCDP = vi.fn();
  const engine = { connectOverCDP } as unknown as Pick<BrowserType, 'connectOverCDP'>;
  expect(await connectDesktop(file, 'http://127.0.0.1:1234', engine)).toBeUndefined();
  for (const origin of [
    'https://example.test',
    'http://127.0.0.1:1234/path',
    'http://user@127.0.0.1:1234',
    'http://127.0.0.1:99999',
  ]) {
    await writeFile(file, JSON.stringify({ origin, token: 'a'.repeat(64) }), { mode: 0o600 });
    await expect(connectDesktop(file, 'http://127.0.0.1:1234', engine)).rejects.toThrow(
      'HOST_BROWSER_DESKTOP_UNAVAILABLE',
    );
  }
  expect(connectOverCDP).not.toHaveBeenCalled();
});

it('authenticates configuration and control, and disconnects without asking Electron to close the application', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-browser-desktop-'));
  const calls: { url: string; auth?: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({
      url: req.url!,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MOCK_SERVER_FAILED');
  const origin = `http://127.0.0.1:${address.port}`;
  const file = path.join(root, 'browser-bridge.json');
  await writeFile(file, JSON.stringify({ origin, token: 'b'.repeat(64) }), { mode: 0o600 });
  const context = {} as BrowserContext;
  const close = vi.fn(async () => {});
  const connectOverCDP = vi.fn(async () => ({ contexts: () => [context], close }));
  const connection = await connectDesktop(file, 'http://127.0.0.1:1234', {
    connectOverCDP,
  } as unknown as Pick<BrowserType, 'connectOverCDP'>);
  expect(connection?.context).toBe(context);
  expect(connectOverCDP).toHaveBeenCalledWith(
    `${origin.replace('http:', 'ws:')}/cdp`,
    expect.objectContaining({ headers: { authorization: `Bearer ${'b'.repeat(64)}` } }),
  );
  await connection!.control('mock-bot', 'mock-instance', 4, 'human');
  expect(calls).toEqual([
    {
      url: '/configure',
      auth: `Bearer ${'b'.repeat(64)}`,
      body: { proxy: 'http://127.0.0.1:1234' },
    },
    {
      url: '/control',
      auth: `Bearer ${'b'.repeat(64)}`,
      body: { bot: 'mock-bot', instance: 'mock-instance', epoch: 4, owner: 'human' },
    },
  ]);
  await connection!.close();
  expect(close).toHaveBeenCalledOnce();
});
