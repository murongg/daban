import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolRun } from '@daban/engine/local-computer';
import {
  LocalComputerClient,
  localComputerPaths,
  privateClientOptions,
} from '@daban/engine/local-computer';
import { expect, it } from 'vitest';
import { LocalComputer } from './local-computer';
import { localServer } from './local-server';

it('keeps host RPC private, forbids RPC consent, and binds returned images to the current Bot and model', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mock-local-rpc-'));
  const root = join(temporary, 'private');
  const computer = new LocalComputer(
    {
      supported: true,
      platform: 'darwin',
      permissions: () => ({ screen: true, accessibility: true }),
      capture: async () => ({
        image: 'data:image/jpeg;base64,AA==',
        width: 800,
        height: 600,
        context: 'mock-window',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }),
      context: async () => 'mock-window',
      input: async () => {},
      openApp: async () => {},
      release: async () => {},
      hide: async () => {},
    },
    true,
  );
  const close = await localServer(root, computer);
  let closed = false;
  try {
    const paths = localComputerPaths(root);
    if (process.platform !== 'win32') expect((await stat(paths.socket)).mode & 0o777).toBe(0o600);
    if (process.platform !== 'win32') expect((await stat(paths.token)).mode & 0o777).toBe(0o600);
    const token = await readFile(paths.token, 'utf8');
    const tls = await privateClientOptions(paths.certificate);
    const response = await new Promise<string>((resolve, reject) => {
      const send = process.platform === 'win32' ? httpsRequest : httpRequest;
      const call = send(
        {
          ...tls,
          socketPath: paths.socket,
          path: '/',
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        },
      );
      call.on('error', reject);
      call.end(JSON.stringify({ method: 'connect', bot: 'mock-bot' }));
    });
    expect(JSON.parse(response)).toEqual({ ok: false, error: 'LOCAL_INVALID_REQUEST' });
    await computer.connect({
      type: 'local.connect',
      id: 'mock-consent',
      bot: 'mock-bot',
      model: 'provider:mock-provider:mock-vision',
      modelRevision: 1,
    });
    const client = new LocalComputerClient(root);
    client.modelRevision = async () => 1;
    const run: AgentToolRun = {
      id: 'mock-run',
      bot: 'mock-bot',
      model: 'provider:mock-provider:mock-vision',
      vision: true,
      abort: new AbortController(),
      toolCount: 0,
      limit: 10,
      trace: [],
      seen: {},
      workdir: '/mock-guest/task',
      canonicalRoot: '/mock-guest/task',
    };
    expect(await client.prepare(run)).toBe(true);
    const first = await client.invoke(run, 'screenshot', { surface: 'desktop' });
    expect(first.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: 'AA==' });
    client.modelRevision = async () => 2;
    expect(
      (
        await client.invoke(run, 'act', {
          surface: 'desktop',
          actions: [{ type: 'click', x: 10, y: 10 }],
        })
      ).isError,
    ).toBe(true);
    expect(computer.status().session).toBeUndefined();
    await computer.connect({
      type: 'local.connect',
      id: 'mock-next-consent',
      bot: 'mock-bot',
      model: 'provider:mock-provider:mock-vision',
      modelRevision: 2,
    });
    await client.status();
    await close();
    closed = true;
    expect((await client.status()).available).toBe(false);
    await expect(client.prepare({ ...run, id: 'mock-after-disconnect' })).rejects.toThrow(
      'LOCAL_CLIENT_UNAVAILABLE',
    );
  } finally {
    if (!closed) await close();
    await rm(temporary, { recursive: true, force: true });
  }
});
