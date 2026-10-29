import assert from 'node:assert/strict';
import test from 'node:test';
import { callBridge } from './bridge.js';

test('private bridge keeps capability in headers and rejects RPC errors without echoing raw payloads', async () => {
  const config = {
    url: 'http://127.0.0.1:12345/mcp/mock-bot',
    capability: 'mock-private-capability',
  };
  const value = await callBridge(
    config,
    'mock.method',
    { value: 'synthetic' },
    new AbortController().signal,
    async (_url, init) => {
      assert.equal(
        new Headers(init.headers).get('authorization'),
        'Bearer mock-private-capability',
      );
      assert.equal(String(init.body).includes('mock-private-capability'), false);
      return Response.json({ result: { accepted: true } });
    },
  );
  assert.deepEqual(value, { accepted: true });
  await assert.rejects(
    callBridge(config, 'mock.method', {}, new AbortController().signal, async () =>
      Response.json({ error: { message: 'mock-private-payload' } }),
    ),
    /BRIDGE_UNAVAILABLE/,
  );
});
