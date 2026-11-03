import { expect, test } from 'vitest';
import { publicAddress, resolvePublic } from './network.js';

test('shared public resolution refuses every private/mixed/rebound answer and retains public IPv4/IPv6 classification', async () => {
  expect(publicAddress('8.8.8.8')).toBe(true);
  expect(publicAddress('2606:4700:4700::1111')).toBe(true);
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
    expect(publicAddress(address)).toBe(false);
  const signal = new AbortController().signal;
  expect(
    await resolvePublic('mcp.example.test', signal, async () => [
      { address: '8.8.8.8', family: 4 },
    ]),
  ).toStrictEqual([{ address: '8.8.8.8', family: 4 }]);
  await expect(
    resolvePublic('mcp.example.test', signal, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
  ).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
  await expect(resolvePublic('127.0.0.1', signal)).rejects.toMatchObject({
    code: 'NETWORK_BLOCKED',
  });
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    resolvePublic('mcp.example.test', cancelled.signal, async () => [
      { address: '8.8.8.8', family: 4 },
    ]),
  ).rejects.toThrowError();
});
