import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:https';
import type { RemoteInvitation } from '@daban/protocol';
import { generate } from 'selfsigned';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { PairingHost, redeemPairing } from './pairing.js';

let offer: RemoteInvitation;
let privateKey: string;
beforeAll(async () => {
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  const id = createHash('sha256').update(key).digest('hex');
  const pems = await generate([{ name: 'commonName', value: id }], {
    algorithm: 'sha256',
    keyType: 'ec',
    curve: 'P-256',
  });
  privateKey = pems.private;
  offer = {
    version: 2,
    host: { id, publicKey: key.toString('base64url'), name: 'Synthetic pairing computer' },
    server: 'https://127.0.0.1:45678',
    certificate: pems.cert,
    code: 'synthetic-high-entropy-invitation-secret',
    expiresAt: Date.now() + 300000,
  };
});
afterEach(() => vi.restoreAllMocks());
it('bounds the total handshake time when an untrusted discovered service trickles response bytes', async () => {
  const server = createServer(
    { key: privateKey, cert: offer.certificate },
    (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
      const timer = setInterval(() => response.write(' '), 30);
      response.once('close', () => clearInterval(timer));
    },
  );
  await new Promise<undefined>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = server.address();
  expect.assert(address && typeof address !== 'string');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = redeemPairing(
      { ...offer, server: `https://127.0.0.1:${address.port}` },
      '123456',
    ).then(
      () => 'UNEXPECTED_SUCCESS',
      (error: Error) => error.message,
    );
    const timeout = new Promise<string>((resolve) => {
      deadline = setTimeout(() => {
        server.closeAllConnections();
        resolve('UNBOUNDED_HANDSHAKE');
      }, 3500);
    });
    expect(await Promise.race([result, timeout])).toBe('REMOTE_CODE_UNREACHABLE');
  } finally {
    clearTimeout(deadline);
    server.closeAllConnections();
    await new Promise<undefined>((resolve) => server.close(() => resolve(undefined)));
  }
});
function fixture() {
  const host = new PairingHost(offer);
  const code = host.activate({ ...offer, expiresAt: Date.now() + 300000 });
  const messages: string[] = [];
  const exchange = async (route: 'start' | 'finish', value: unknown) => {
    messages.push(JSON.stringify(value));
    const response = route === 'start' ? host.begin() : host.finish(value);
    messages.push(JSON.stringify(response));
    return response;
  };
  return { host, code, exchange, messages };
}
it('authenticates a six-digit code without sending the code or plaintext invitation', async () => {
  const f = fixture();
  expect(f.code.code).toMatch(/^\d{6}$/);
  expect(await redeemPairing(offer, f.code.code, f.exchange)).toMatchObject({
    host: offer.host,
    certificate: offer.certificate,
    code: offer.code,
  });
  expect(f.messages.join('')).not.toContain(JSON.stringify(f.code.code));
  expect(f.messages.join('')).not.toContain(offer.code);
});
it('rejects a different code without providing an invitation', async () => {
  const f = fixture();
  const wrong = f.code.code === '000000' ? '111111' : '000000';
  await expect(redeemPairing(offer, wrong, f.exchange)).rejects.toThrow('REMOTE_CODE_INVALID');
  expect(f.messages.join('')).not.toContain(offer.code);
});
it('bounds guesses across device identities for the lifetime of a code', () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) f.host.begin();
  expect(() => f.host.begin()).toThrow('REMOTE_CODE_ATTEMPTS');
});
it('expires codes and invalidates outstanding challenges on refresh or stop', () => {
  const f = fixture();
  const pending = f.host.begin();
  f.host.activate({ ...offer, expiresAt: Date.now() + 300000 });
  expect(() =>
    f.host.finish({ id: pending.id, A: '0'.repeat(768), proof: '0'.repeat(128) }),
  ).toThrow('REMOTE_CODE_EXPIRED');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
  expect(f.host.state()).toBeUndefined();
  expect(() => f.host.begin()).toThrow('REMOTE_CODE_EXPIRED');
  f.host.stop();
  expect(f.host.state()).toBeUndefined();
});
it('binds authentication to the advertised identity and TLS certificate', async () => {
  const f = fixture();
  const changed = { ...offer, host: { ...offer.host, id: 'b'.repeat(64) } };
  await expect(redeemPairing(changed, f.code.code, f.exchange)).rejects.toThrow();
});
it('rejects a tampered encrypted invitation and consumes each finish challenge once', async () => {
  const f = fixture();
  let used: unknown;
  const exchange = async (route: 'start' | 'finish', value: unknown) => {
    if (route === 'start') return f.host.begin();
    used = value;
    const result = f.host.finish(value);
    return { ...result, data: (result.data.startsWith('00') ? 'ff' : '00') + result.data.slice(2) };
  };
  await expect(redeemPairing(offer, f.code.code, exchange)).rejects.toThrow();
  expect(() => f.host.finish(used)).toThrow('REMOTE_CODE_EXPIRED');
});
