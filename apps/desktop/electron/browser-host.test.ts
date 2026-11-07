import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ session: { fromPath: vi.fn() }, WebContentsView: vi.fn() }));

import { BrowserHost } from './browser-host';

it('publishes a private, authenticated loopback bridge and refuses web origins and invalid proxy configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-embedded-browser-'));
  const host = new BrowserHost(root);
  try {
    await host.start();
    const endpoint = JSON.parse(await readFile(path.join(root, 'browser-bridge.json'), 'utf8')) as {
      origin: string;
      token: string;
    };
    expect(endpoint.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(endpoint.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await fetch(`${endpoint.origin}/configure`, { method: 'POST' })).status).toBe(403);
    const headers = {
      authorization: `Bearer ${endpoint.token}`,
      'content-type': 'application/json',
    };
    expect(
      (
        await fetch(`${endpoint.origin}/configure`, {
          method: 'POST',
          headers: { ...headers, origin: 'https://example.test' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${endpoint.origin}/configure`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ proxy: 'http://example.test:80' }),
        })
      ).status,
    ).toBe(400);
    await expect(
      host.present('mock-mount', 'mock-bot', 1, 'mock-instance', 'mock-renderer', {} as never, {
        x: 0,
        y: 0,
        width: 500,
        height: 400,
      }),
    ).rejects.toThrow('BROWSER_TARGET_UNAVAILABLE');
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
