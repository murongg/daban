import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type TLSSocket } from 'node:tls';
import { expect, type TestContext, test } from 'vitest';
import { createQmpCertificates, Qmp } from './qmp.js';

const uuid = '11111111-2222-4333-8444-555555555555';
async function fixture(t: TestContext, identity = uuid) {
  const pems = await createQmpCertificates();
  const commands: string[] = [];
  const sockets = new Set<TLSSocket>();
  const server = createServer(
    {
      key: pems.serverKey,
      cert: pems.serverCert,
      ca: pems.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.write(JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + '\r\n');
      let buffer = '';
      socket.on('data', (bytes: Buffer) => {
        buffer += bytes.toString();
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index < 0) return;
          const request = JSON.parse(buffer.slice(0, index)) as { execute: string; id: number };
          buffer = buffer.slice(index + 1);
          commands.push(request.execute);
          socket.write('{"event":"MOCK_STATUS"}\r\n');
          const result =
            request.execute === 'query-uuid' ? { UUID: identity } : { status: 'running' };
          const reply = JSON.stringify({ return: result, id: request.id }) + '\r\n';
          socket.write(reply.slice(0, 9));
          socket.write(reply.slice(9));
        }
      });
    },
  );
  server.on('tlsClientError', () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('SYNTHETIC_LISTEN_FAILED');
  return {
    port: address.port,
    ca: pems.ca,
    cert: pems.clientCert,
    key: pems.clientKey,
    commands,
    uuid,
  };
}

test('QEMU control certificates have a private CA and distinct non-CA server and client identities', async () => {
  const pems = await createQmpCertificates();
  const ca = new X509Certificate(pems.ca);
  const server = new X509Certificate(pems.serverCert);
  const client = new X509Certificate(pems.clientCert);
  expect(ca.ca).toBe(true);
  expect(server.ca).toBe(false);
  expect(client.ca).toBe(false);
  expect(server.verify(ca.publicKey)).toBe(true);
  expect(client.verify(ca.publicKey)).toBe(true);
  expect(pems.serverKey).not.toBe(pems.clientKey);
});

test('QMP authenticates both TLS peers, checks the guest UUID, handles fragmented replies and closes without stopping the VM', async (t) => {
  const f = await fixture(t);
  const qmp = await Qmp.open(f);
  expect(await qmp.execute('query-status')).toStrictEqual({ status: 'running' });
  await qmp.close();
  expect(f.commands).toStrictEqual(['qmp_capabilities', 'query-uuid', 'query-status']);
});

test('QMP refuses a different guest identity before any power operation', async (t) => {
  const f = await fixture(t, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  await expect(Qmp.open(f)).rejects.toThrow('QEMU_IDENTITY_CHANGED');
  expect(f.commands).toStrictEqual(['qmp_capabilities', 'query-uuid']);
});

test('QMP refuses an untrusted control server before sending commands', async (t) => {
  const f = await fixture(t);
  const other = await createQmpCertificates();
  await expect(
    Qmp.open({ ...f, ca: other.ca, cert: other.clientCert, key: other.clientKey }),
  ).rejects.toThrow('QEMU_CONTROL_UNAVAILABLE');
  expect(f.commands).toStrictEqual([]);
});
