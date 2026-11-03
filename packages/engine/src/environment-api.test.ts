import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SetupStatus } from '@daban/protocol';
import { startNativeAgent } from './host-server.js';
import { privateClientOptions } from './private-channel.js';

test('optional environment setup is host-authenticated and blocks app replacement only while busy', {
  timeout: 20000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-environment-api-'));
  const scope = createHash('sha256').update(root).digest('hex');
  const socketPath =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\daban-agent-${scope.slice(0, 24)}`
      : path.join(root, 's');
  let busy = false,
    started = 0,
    updated: () => unknown = () => {};
  const handoff = new Promise<unknown>((resolve) => {
    updated = () => resolve(undefined);
  });
  let state: SetupStatus = { required: true, target: 'linux', phase: 'available' };
  const app = await startNativeAgent({
    dataRoot: root,
    socketPath,
    scope,
    nativeWorkspace: path.join(root, 'workspace'),
    sdkFile: fileURLToPath(import.meta.url),
    onUpdate: updated,
    environment: {
      get busy() {
        return busy;
      },
      status: async () => state,
      start: async () => {
        started++;
        busy = true;
        state = {
          required: true,
          target: 'linux',
          phase: 'downloading',
          downloaded: 37,
          total: 100,
          progress: 37,
        };
        return state;
      },
      cancel: async () => {
        busy = false;
        state = { required: true, target: 'linux', phase: 'cancelled' };
        return state;
      },
    },
  });
  const token = (await readFile(path.join(root, 'model/control-token'), 'utf8')).trim();
  const tls = await privateClientOptions(path.join(root, 'model/control-certificate.pem'));
  const call = (route: string, body: object, auth = token) =>
    new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
      const request = (process.platform === 'win32' ? https : http)(
        {
          ...tls,
          socketPath,
          path: route,
          method: 'POST',
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
                value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
  try {
    assert.equal(started, 0);
    assert.equal(
      (await call('/api/host/environment', { scope, action: 'start' }, 'synthetic-invalid')).status,
      403,
    );
    assert.equal(
      (await call('/api/host/environment', { scope: 'b'.repeat(64), action: 'start' })).status,
      400,
    );
    assert.equal(
      (
        await call('/api/host/environment', {
          scope,
          action: 'start',
          url: 'https://example.test/untrusted',
        })
      ).status,
      400,
    );
    assert.equal(
      (await call('/api/host/environment', { scope, action: 'status' })).value.phase,
      'available',
    );
    assert.equal(started, 0);
    assert.equal(
      (await call('/api/host/environment', { scope, action: 'start' })).value.phase,
      'downloading',
    );
    assert.equal(started, 1);
    assert.equal((await call('/api/host/update', { scope })).status, 409);
    assert.equal(
      (await call('/api/host/environment', { scope, action: 'cancel' })).value.phase,
      'cancelled',
    );
    assert.equal((await call('/api/host/update', { scope })).status, 200);
    await handoff;
    assert.equal((await call('/api/host/environment', { scope, action: 'start' })).status, 503);
    assert.equal(started, 1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
