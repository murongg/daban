import { type AppCommand, appDirectoryProtocol, disconnected } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { RuntimeClient } from './client.js';

const command: AppCommand = {
  type: 'app.oauth.connect',
  input: {
    app: 'linear',
    bot: 'mock-bot',
    connection: 'mock-linear',
    revision: 0,
    name: 'Synthetic account',
    requestId: 'mock-start',
  },
};
function fixture(probe: () => Response, write: () => Response) {
  const requests: { method: string; route: string; body?: BodyInit | null }[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:8766',
    agent: true,
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url, init) => {
      requests.push({
        method: init?.method ?? 'GET',
        route: new URL(url).pathname,
        body: init?.body,
      });
      return init?.method === 'POST' ? write() : probe();
    },
  });
  vi.spyOn(client, 'status').mockResolvedValue({
    ...disconnected('ready'),
    appConnections: { catalog: true, oauthLoopback: true },
  });
  return { client, requests };
}
test.each(['NOT_FOUND', 'UNAUTHORIZED', 'RUNTIME_UNAVAILABLE'])(
  'only a missing static protocol is an upgrade refusal, without sending a start: %s',
  async (error) => {
    const f = fixture(
      () => Response.json({ error }, { status: error === 'NOT_FOUND' ? 404 : 503 }),
      () => {
        throw Error('SYNTHETIC_WRITE_FORBIDDEN');
      },
    );
    await expect(f.client.appInteractive(command, 'b'.repeat(64))).rejects.toThrow(
      error === 'NOT_FOUND' ? 'OAUTH_UPGRADE_REQUIRED' : error,
    );
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].method).toBe('GET');
  },
);
test.each(['UNAUTHORIZED', 'RUNTIME_UNAVAILABLE', 'LOST_REPLY'])(
  'never retries a start or falls back to the legacy route after %s',
  async (error) => {
    const f = fixture(
      () => Response.json({ protocol: appDirectoryProtocol }),
      () => {
        if (error === 'LOST_REPLY') throw Error(error);
        return Response.json({ error }, { status: 403 });
      },
    );
    await expect(f.client.appInteractive(command, 'b'.repeat(64))).rejects.toThrow(error);
    expect(f.requests.map((request) => request.method)).toEqual(['GET', 'POST']);
    expect(f.requests.every((request) => request.route === '/api/mcp/apps')).toBe(true);
  },
);
test('freezes provider and target input before the asynchronous capability read', async () => {
  let release!: () => unknown;
  const barrier = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const input = structuredClone(command);
  const f = fixture(
    () => Response.json({ protocol: appDirectoryProtocol }),
    () => Response.json({}),
  );
  const original = await f.client.status();
  vi.spyOn(f.client, 'status').mockImplementation(async () => {
    await barrier;
    return original;
  });
  const attempt = f.client.appInteractive(input, 'b'.repeat(64)).catch((error) => error);
  if (input.type !== 'app.oauth.connect') throw Error('SYNTHETIC_INPUT');
  input.input.app = 'miro';
  input.input.connection = 'mock-replaced';
  release();
  await attempt;
  expect(JSON.parse(String(f.requests.find((request) => request.method === 'POST')?.body))).toEqual(
    command,
  );
});
