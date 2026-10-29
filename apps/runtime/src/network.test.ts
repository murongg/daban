import assert from 'node:assert/strict';
import test from 'node:test';
import { publicAddress, resolvePublic } from './network.js';

test('shared public resolution refuses every private/mixed/rebound answer and retains public IPv4/IPv6 classification', async () => {
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '198.18.0.1',
    '::1',
    '::ffff:8.8.8.8',
    '2001:db8::1',
    '2002:808:808::1',
  ])
    assert.equal(publicAddress(address), false);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await resolvePublic('mcp.example.test', signal, async () => [
      { address: '8.8.8.8', family: 4 },
    ]),
    [{ address: '8.8.8.8', family: 4 }],
  );
  await assert.rejects(
    resolvePublic('mcp.example.test', signal, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    { code: 'NETWORK_BLOCKED' },
  );
  await assert.rejects(resolvePublic('127.0.0.1', signal), { code: 'NETWORK_BLOCKED' });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    resolvePublic('mcp.example.test', cancelled.signal, async () => [
      { address: '8.8.8.8', family: 4 },
    ]),
  );
});
