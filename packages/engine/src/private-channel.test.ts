import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { privateClientOptions, privateServer } from './private-channel.js';
import { secureDirectory } from './private-files.js';

test('Windows private channels authenticate the pinned server before transmitting a control payload', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-private-channel-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  let payloads = 0;
  const listener: import('node:http').RequestListener = (_req, res) => {
    payloads++;
    res.end('MOCK OK');
  };
  const trusted = await privateServer(listener, path.join(root, 'model/trusted.pem'), 'win32');
  const impostor = await privateServer(listener, path.join(root, 'impostor.pem'), 'win32');
  const channels = [trusted, impostor];
  try {
    for (const channel of channels) {
      channel.server.listen(0, '127.0.0.1');
      await once(channel.server, 'listening');
      await channel.publish();
    }
    const options = await privateClientOptions(path.join(root, 'model/trusted.pem'), 'win32');
    const call = (server: typeof trusted.server) =>
      new Promise<string>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: (server.address() as { port: number }).port,
            method: 'POST',
            ...options,
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
    await assert.rejects(call(impostor.server));
    assert.equal(payloads, 0);
    assert.equal(await call(trusted.server), 'MOCK OK');
    assert.equal(payloads, 1);
  } finally {
    for (const { server } of channels) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
