import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { EnvironmentClient } from './environment-client';

it('uses the authenticated scoped host endpoint and validates Linux progress', async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({
      required: true,
      target: 'linux',
      phase: 'downloading',
      downloaded: 2,
      total: 10,
    }),
  );
  const client = new EnvironmentClient(
    {
      dataRoot: path.resolve('synthetic-data'),
      socketPath: path.resolve('synthetic.sock'),
      scope: 'a'.repeat(64),
    },
    { fetcher, token: async () => 'synthetic-token' },
  );
  expect((await client.invoke('start')).downloaded).toBe(2);
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({
    scope: 'a'.repeat(64),
    action: 'start',
  });
  expect(fetcher.mock.calls[0][1].headers).toHaveProperty('x-prototype-token', 'synthetic-token');
  await client.invoke('start', { mode: 'tcg' });
  expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toMatchObject({
    action: 'start',
    mode: 'tcg',
  });
  await client.invoke('enable', { confirmed: true });
  expect(JSON.parse(fetcher.mock.calls[2][1].body as string)).toMatchObject({
    action: 'enable',
    confirmed: true,
  });
  fetcher.mockImplementation(async () =>
    Response.json({ required: true, target: 'agent', phase: 'downloading' }),
  );
  await expect(client.invoke('status')).rejects.toThrow('SETUP_STORE');
});
