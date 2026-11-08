import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isFolderStatus, managedProtocol } from '@daban/protocol';
import { expect, test } from 'vitest';
import { windowsPrivatePipe } from './private-channel.js';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

test('folder API authenticates connections and refuses unknown Bots, authority fields and malformed routes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-folders-api-'));
  const project = path.join(root, 'mock-project');
  await mkdir(project);
  const socketPath =
    process.platform === 'win32'
      ? path.win32.join('\\\\.\\pipe', `daban-agent-${randomUUID()}`)
      : path.join(root, 'mock.sock');
  expect(process.platform !== 'win32' || windowsPrivatePipe(socketPath)).toBe(true);
  const dataRoot = path.join(root, 'private');
  if (process.platform === 'win32') await secureDirectory(dataRoot);
  const app = await startPrototype({
    host: {
      dataRoot,
      nativeWorkspace: path.join(dataRoot, 'workspace'),
      socketPath,
      scope: 'a'.repeat(64),
      sdkFile: '/mock/sdk.ts',
    },
    port: 0,
  });
  t.onTestFinished(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.models!.profiles.register({
    id: 'mock-a',
    name: 'MOCK A',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  const certificate =
    process.platform === 'win32'
      ? await readFile(path.join(dataRoot, 'model/control-certificate.pem'), 'utf8')
      : undefined;
  const call = async (action: string, input: object, token = app.token, method = 'POST') => {
    return new Promise<{ status: number; value: unknown }>((resolve, reject) => {
      const options = {
        socketPath,
        path: `/api/folders/${action}`,
        method,
        headers: {
          host: '127.0.0.1:8766',
          'x-prototype-token': token,
          'content-type': 'application/json',
          'x-daban-client-protocol': String(managedProtocol),
        },
      };
      const request = (
        process.platform === 'win32'
          ? httpsRequest({ ...options, ca: certificate, servername: 'localhost' })
          : httpRequest(options)
      ).on('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      });
      request.on('error', reject);
      request.end(method === 'POST' ? JSON.stringify(input) : undefined);
    });
  };
  expect((await call('connect', { bot: 'mock-a', path: project }, 'mock-denied')).status).toBe(403);
  expect((await call('connect', { bot: 'mock-unknown', path: project })).status).toBe(404);
  expect((await call('connect', { bot: 'mock-a', path: project, all: true })).status).toBe(400);
  expect((await call('status?extra=1', { bot: 'mock-a' })).status).toBe(400);
  expect((await call('status', {}, app.token, 'GET')).status).toBe(405);
  expect((await call('connect', { bot: 'mock-a', path: project })).status).toBe(200);
  const status = await call('status', { bot: 'mock-a' });
  expect.assert(isFolderStatus(status.value));
  expect(status.value.folders).toHaveLength(1);
  expect(app.models!.jobs.size).toBe(0);
  expect((await call('disconnect', { bot: 'mock-a', id: status.value.folders[0].id })).status).toBe(
    200,
  );
  expect((await call('status', { bot: 'mock-a' })).value).toMatchObject({ folders: [] });
});
