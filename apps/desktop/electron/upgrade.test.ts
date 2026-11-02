import { expect, it, vi } from 'vitest';
import { prepareAgentUpdate } from './upgrade';

const config = {
  dataRoot: '/synthetic/private',
  socketPath: '/synthetic/a.sock',
  scope: 'a'.repeat(64),
};
it('authenticates the scoped handoff and waits until the acknowledged host process has exited', async () => {
  const alive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  const pause = vi.fn(async () => {});
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('x-prototype-token')).toBe('synthetic-token');
    expect(JSON.parse(String(init?.body))).toEqual({ scope: config.scope });
    return Response.json({ scope: config.scope, pid: 424242 });
  });
  await prepareAgentUpdate(config, { token: async () => 'synthetic-token', fetcher, alive, pause });
  expect(alive).toHaveBeenCalledWith(424242);
  expect(pause).toHaveBeenCalledOnce();
});
it('busy, unsupported and mismatched services never become permission to kill a process', async () => {
  for (const response of [
    Response.json({ error: 'busy' }, { status: 409 }),
    Response.json({ error: 'old' }, { status: 404 }),
    Response.json({ scope: 'b'.repeat(64), pid: 424242 }),
    Response.json({ scope: config.scope, pid: -1 }),
  ]) {
    const alive = vi.fn();
    await expect(
      prepareAgentUpdate(config, {
        token: async () => 'synthetic-token',
        fetcher: async () => response,
        alive,
        pause: async () => {},
      }),
    ).rejects.toThrow();
    expect(alive).not.toHaveBeenCalled();
  }
});
