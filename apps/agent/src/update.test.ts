import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateClientOptions } from '@daban/engine/local-computer';

test('the real host CLI exits cleanly after an authenticated idle update handoff', {
  timeout: 20000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-update-'));
  const dataRoot = path.join(root, 'private'),
    vmConfig = path.join(root, 'unused.json');
  const scope = createHash('sha256')
    .update(JSON.stringify([path.resolve(dataRoot), path.resolve(vmConfig)]))
    .digest('hex');
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\daban-update-cli-${scope.slice(0, 24)}`
      : path.join(root, 'a.sock');
  const child = spawn(
    process.execPath,
    [
      '--experimental-sqlite',
      fileURLToPath(new URL('./main.js', import.meta.url)),
      '--data',
      dataRoot,
      '--socket',
      socketPath,
      '--vm-config',
      vmConfig,
      '--mode',
      'native',
    ],
    { stdio: 'pipe' },
  );
  let output = '';
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  async function call(endpoint: string, token: string, body?: object) {
    const tls = await privateClientOptions(path.join(dataRoot, 'model/control-certificate.pem'));
    return new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
      const request = (process.platform === 'win32' ? httpsRequest : httpRequest)(
        {
          ...tls,
          socketPath,
          path: endpoint,
          method: body ? 'POST' : 'GET',
          headers: {
            host: '127.0.0.1:8766',
            'x-prototype-token': token,
            'content-type': 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (value: Buffer) => chunks.push(value));
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
      request.setTimeout(1000, () => request.destroy(Error('SYNTHETIC_TIMEOUT')));
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }
  try {
    let token = '',
      ready = false;
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw Error(`Fixture exited early: ${output}`);
      try {
        token = (await readFile(path.join(dataRoot, 'model/control-token'), 'utf8')).trim();
        ready = (await call('/api/state', token)).status === 200;
        if (ready) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, output);
    const response = await call('/api/host/update', token, { scope });
    assert.equal(response.status, 200);
    assert.equal(response.value.pid, child.pid);
    assert.equal(await exit, 0, output);
  } finally {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32')
        await new Promise((resolve) =>
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve(undefined)),
        );
      else child.kill();
    }
    await rm(root, { recursive: true, force: true });
  }
});
