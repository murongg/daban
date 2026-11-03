import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ExecutionSnapshot, executionCapabilities } from '@daban/protocol';
import { expect, test } from 'vitest';
import { startAgent } from './host-server.js';
import { privateClientOptions } from './private-channel.js';

test('the real VM host serves authenticated IPC on Windows pipes and POSIX sockets with a synthetic executor', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-vm-'));
  const dataRoot = path.join(root, 'private');
  const scope = createHash('sha256').update(root).digest('hex');
  const socketPath =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\daban-agent-${scope.slice(0, 24)}`
      : path.join(dataRoot, 'a.sock');
  const snapshot: ExecutionSnapshot = {
    role: 'executor',
    version: 1,
    boot: 'mock-boot',
    nonce: 'mock-nonce',
    capabilities: [...executionCapabilities],
    computer: {
      mode: 'agent',
      sharedLogin: false,
      viewport: { width: 1280, height: 800 },
      environment: {
        platform: 'linux',
        arch: 'x64',
        kernel: 'mock',
        node: 'mock',
        browser: 'mock',
      },
      events: [],
      bots: {},
    },
    status: { available: true, limit: 2, revision: 0, items: [] },
  };
  let host: Awaited<ReturnType<typeof startAgent>> | undefined;
  t.onTestFinished(async () => {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  });
  host = await startAgent({
    dataRoot,
    socketPath,
    scope,
    sdkFile: fileURLToPath(import.meta.url),
    execution: {
      ready: Promise.resolve(snapshot),
      snapshot,
      refresh: async () => snapshot,
      call: async <T>(method: string) => {
        if (method === 'workspace.base') return '/mock-linux/workspace' as T;
        throw new Error(`SYNTHETIC UNEXPECTED METHOD: ${method}`);
      },
    },
  });
  const token = (await readFile(path.join(dataRoot, 'model/control-token'), 'utf8')).trim();
  const tls = await privateClientOptions(path.join(dataRoot, 'model/control-certificate.pem'));
  const value = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = (process.platform === 'win32' ? httpsRequest : httpRequest)(
      {
        ...tls,
        socketPath,
        path: '/api/state',
        headers: { host: '127.0.0.1:8766', 'x-prototype-token': token },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (part: string) => {
          body += part;
        });
        response.on('end', () => {
          try {
            expect(response.statusCode).toBe(200);
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
  expect((value.agent as Record<string, unknown>).execution).toBe('linux-vm');
  expect((value.environment as Record<string, unknown>).platform).toBe('linux');
  expect((value.environment as Record<string, unknown>).arch).toBe('x64');
});
