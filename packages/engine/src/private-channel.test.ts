import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:https';
import test from 'node:test';
import { privateClientOptions, privateServer } from './private-channel.js';

// Synthetic PSKs: no user keys, files or desktop are involved.
test('Windows private channels authenticate the server before transmitting a control payload', async () => {
  const key = 'a'.repeat(64);
  let payloads = 0;
  const server = privateServer(
    (_req, res) => {
      payloads++;
      res.end('MOCK OK');
    },
    (identity) => (identity === 'control' ? key : undefined),
    'win32',
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const call = (secret: string) =>
    new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          ...privateClientOptions(secret, 'control', 'win32'),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        },
      );
      req.on('error', reject);
      req.end('SYNTHETIC PRIVATE PAYLOAD');
    });
  try {
    await assert.rejects(call('b'.repeat(64)));
    assert.equal(payloads, 0);
    assert.equal(await call(key), 'MOCK OK');
    assert.equal(payloads, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
