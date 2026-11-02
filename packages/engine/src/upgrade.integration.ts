import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startNativeAgent } from './host-server.js';
import { privateClientOptions } from './private-channel.js';

test('authenticated idle-only handoff fences all later admissions without cancelling an active job', {
  timeout: 15000,
}, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-upgrade-'));
  const root = path.join(temporary, 'private');
  const scope = createHash('sha256').update(root).digest('hex');
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\daban-agent-${scope.slice(0, 24)}`
      : path.join(root, 'a.sock');
  let requested = 0;
  let handedOff: () => unknown = () => {};
  const handoff = new Promise<undefined>((resolve) => {
    handedOff = () => resolve(undefined);
  });
  const options = {
    dataRoot: root,
    nativeWorkspace: path.join(root, 'workspace'),
    socketPath,
    scope,
    sdkFile: fileURLToPath(import.meta.url),
    onUpdate: () => {
      requested++;
      handedOff();
    },
  };
  const app = await startNativeAgent(options);
  const token = (await readFile(path.join(root, 'model/control-token'), 'utf8')).trim();
  const tls = await privateClientOptions(path.join(root, 'model/control-certificate.pem'));
  const call = (value: unknown, auth = token, method = 'POST') =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const request = (process.platform === 'win32' ? httpsRequest : httpRequest)(
        {
          ...tls,
          socketPath,
          path: '/api/host/update',
          method,
          headers: {
            host: '127.0.0.1:8766',
            'x-prototype-token': auth,
            'content-type': 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(value));
    });
  try {
    assert.equal((await call({ scope }, 'synthetic-invalid')).status, 403);
    assert.equal((await call({ scope }, token, 'GET')).status, 400);
    assert.equal((await call({ scope: '0'.repeat(64) })).status, 400);
    app.models.jobs.set('mock-running', { running: true } as Parameters<
      typeof app.models.jobs.set
    >[1]);
    assert.equal((await call({ scope })).status, 409);
    assert.equal(requested, 0);
    assert.equal(app.models.jobs.get('mock-running')?.running, true);
    app.models.jobs.delete('mock-running');
    const accepted = await call({ scope });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.scope, scope);
    assert.equal(accepted.body.pid, process.pid);
    // TLS can deliver the response before the server's finish callback runs on Windows.
    await handoff;
    assert.equal(requested, 1);
    assert.equal(app.models.admit('mock-bot'), false);
    assert.equal((await call({ scope })).status, 503);
    assert.equal(requested, 1);
  } finally {
    app.models.jobs.delete('mock-running');
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
