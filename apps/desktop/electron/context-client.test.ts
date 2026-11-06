import { disconnected, type RuntimeSnapshot } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { RuntimeClient } from './runtime';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
test('missing capability sends no query even on a high protocol; requests freeze scope before status yields', async () => {
  let body = '';
  let reply: unknown = { scope, state: 'unavailable', reason: 'legacy' };
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    body = String(options?.body);
    return Response.json(reply);
  });
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:12345',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const status = vi
    .spyOn(client, 'status')
    .mockResolvedValue({ ...disconnected('ready'), protocolVersion: 999 });
  await expect(client.invoke({ type: 'context.inspect', query: { scope } })).rejects.toThrow(
    'CONTEXT_UNSUPPORTED',
  );
  expect(fetcher).not.toHaveBeenCalled();
  let resolve: (state: RuntimeSnapshot) => unknown = () => {};
  status.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const query = { scope: { ...scope } };
  const pending = client.invoke({ type: 'context.inspect', query });
  query.scope.runId = 'mock-mutated';
  resolve({ ...disconnected('ready'), contextInspector: 1 });
  expect(await pending).toEqual(reply);
  expect(JSON.parse(body)).toEqual({ scope });
  status.mockResolvedValue({ ...disconnected('ready'), contextInspector: 1 });
  reply = { scope: { ...scope, bot: 'mock-other' }, state: 'unavailable', reason: 'legacy' };
  await expect(client.invoke({ type: 'context.inspect', query: { scope } })).rejects.toThrow(
    'INVALID_CONTEXT_VIEW',
  );
  reply = { ...scope, seq: 2, offset: 0, total: 0, text: '' };
  await expect(
    client.invoke({
      type: 'context.source',
      query: { scope, revision: 1, ref: { scope, seq: 1 } },
    }),
  ).rejects.toThrow('INVALID_CONTEXT_SOURCE');
});
