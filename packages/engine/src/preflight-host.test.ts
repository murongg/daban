import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionSnapshot, LocalComputerStatus } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { LocalComputerClient } from './local-computer.js';
import { privateClientOptions } from './private-channel.js';
import { secureDirectory } from './private-files.js';
import { type HostComposition, startPrototype } from './server.js';

async function fixture(execution?: HostComposition['execution']) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pf-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const sdkFile = path.join(root, 'mock-sdk.mjs');
  await writeFile(sdkFile, 'export class DeepSeekHarness {}', { mode: 0o600 });
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\daban-preflight-${randomBytes(8).toString('hex')}`
      : path.join(root, 's');
  const local = new LocalComputerClient(root);
  const status: LocalComputerStatus = {
    platform: 'darwin',
    available: true,
    shortcut: true,
    permissions: { screen: true, accessibility: true },
    session: {
      id: 'mock-session',
      bot: 'mock-bot',
      revision: 1,
      owner: 'agent',
      model: 'deepseek-flash',
      modelRevision: 1,
    },
  };
  const localStatus = vi
    .spyOn(local, 'status')
    .mockImplementation(async () => structuredClone(status));
  const invoke = vi.spyOn(local, 'invoke').mockImplementation(async () => {
    throw Error('SYNTHETIC-FORBIDDEN-INPUT');
  });
  const app = await startPrototype({
    host: {
      dataRoot: root,
      socketPath: socket,
      scope: 'a'.repeat(64),
      sdkFile,
      localComputer: local,
      ...(execution ? { execution } : { nativeWorkspace: path.join(root, 'work') }),
    },
  });
  const tls =
    process.platform === 'win32'
      ? await privateClientOptions(path.join(root, 'model', 'control-certificate.pem'))
      : {};
  const send = process.platform === 'win32' ? httpsRequest : httpRequest;
  const call = (requirements: unknown, id: string) =>
    new Promise<{
      status: number;
      value: { workspace: string; checks: { state: string; reason: string }[] };
    }>((resolve, reject) => {
      const req = send(
        {
          ...tls,
          socketPath: socket,
          path: '/api/preflight/inspect',
          method: 'POST',
          headers: {
            host: '127.0.0.1:8766',
            'content-type': 'application/json',
            'x-prototype-token': app.token,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ id, bot: 'mock-bot', requirements }));
    });
  expect.assert(app.models);
  await app.models.profiles.register({
    id: 'mock-bot',
    name: 'Synthetic',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  await app.models.settings.save({ apiKey: 'synthetic-private-key' });
  return {
    app,
    status,
    localStatus,
    invoke,
    call,
    close: async () => {
      localStatus.mockRestore();
      invoke.mockRestore();
      await app.close();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

test('native Host binds reports to its data scope and reads trusted local status only when explicitly requested', async () => {
  const f = await fixture();
  try {
    const text = await f.call([{ kind: 'model', vision: false, tools: false }], 'mock-text');
    expect(text.status).toBe(200);
    expect(text.value.workspace).toBe('a'.repeat(64));
    expect(f.localStatus).not.toHaveBeenCalled();
    const query = [{ kind: 'computer', mode: 'local', access: 'control' }];
    expect((await f.call(query, 'mock-local')).value.checks[0].state).toBe('ready');
    f.status.session!.owner = 'human';
    expect((await f.call(query, 'mock-human')).value.checks[0].reason).toBe(
      'CONTROL_HELD_BY_HUMAN',
    );
    f.status.session!.bot = 'mock-other';
    expect((await f.call(query, 'mock-other')).value.checks[0].reason).toBe(
      'LOCAL_SESSION_MISMATCH',
    );
    expect(f.invoke).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('fresh Host facts never probe models or turn a ready report into task permission', async () => {
  const f = await fixture();
  const models = f.app.models!;
  const forbidden = () => {
    throw Error('SYNTHETIC-FORBIDDEN-MODEL-OPERATION');
  };
  const operations = [
    vi.spyOn(models.settings, 'check').mockImplementation(forbidden),
    vi.spyOn(models.settings, 'inspect').mockImplementation(forbidden),
    vi.spyOn(models.settings, 'configure').mockImplementation(forbidden),
    vi.spyOn(models.settings, 'diagnose').mockImplementation(forbidden),
    vi.spyOn(models.settings, 'fallback').mockImplementation(forbidden),
    vi.spyOn(models.settings, 'remove').mockImplementation(forbidden),
    vi.spyOn(models.settings, 'capture').mockImplementation(forbidden),
    vi.spyOn(models.settings, 'resolve').mockImplementation(forbidden),
    vi.spyOn(models, 'start').mockImplementation(forbidden),
  ];
  try {
    const bytes = await readFile(models.settings.file, 'utf8');
    const text = await f.call([{ kind: 'model', vision: false, tools: false }], 'mock-ready');
    expect(text.status).toBe(200);
    expect(text.value.checks[0].state).toBe('ready');
    const local = [{ kind: 'computer', mode: 'local', access: 'control' }];
    expect((await f.call(local, 'mock-current-agent')).value.checks[0].state).toBe('ready');
    const samples = f.localStatus.mock.calls.length;
    f.status.session!.owner = 'human';
    expect((await f.call(local, 'mock-current-human')).value.checks[0].reason).toBe(
      'CONTROL_HELD_BY_HUMAN',
    );
    expect(f.localStatus.mock.calls.length).toBeGreaterThan(samples);
    expect(await readFile(models.settings.file, 'utf8')).toBe(bytes);
    await expect(
      models.startHuman('mock-bot', {
        requestId: 'mock-report-ticket',
        prompt: 'Synthetic request',
        preflight: text.value,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TASK' });
    await models.settings.save({ apiKey: 'synthetic-updated-key' });
    const updated = await readFile(models.settings.file, 'utf8');
    expect((await f.call(local, 'mock-current-model')).value.checks[0].reason).toBe(
      'LOCAL_SESSION_MISMATCH',
    );
    expect(await readFile(models.settings.file, 'utf8')).toBe(updated);
    for (const operation of operations) expect(operation).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(models.jobs.size).toBe(0);
  } finally {
    for (const operation of operations) operation.mockRestore();
    await f.close();
  }
});

test('Linux Host samples the existing execution capability and control owner without invoking tools', async () => {
  const snapshot: ExecutionSnapshot = {
    role: 'executor',
    version: 1,
    boot: 'mock-boot',
    nonce: 'mock-nonce',
    capabilities: ['workspace', 'tools', 'computer', 'processes', 'documents'],
    computer: {
      mode: 'desktop',
      sharedLogin: false,
      viewport: { width: 1280, height: 800 },
      environment: {
        platform: 'linux',
        arch: 'x64',
        kernel: 'synthetic',
        node: 'v26',
        browser: 'synthetic',
      },
      events: [],
      bots: {
        'mock-bot': {
          instance: 'mock-screen',
          owner: 'human',
          epoch: 1,
          running: false,
          error: null,
          count: 0,
          identity: '',
          note: '',
        },
      },
    },
    status: {
      available: true,
      revision: 1,
      limit: 2,
      items: [
        {
          bot: 'mock-bot',
          revision: 1,
          phase: 'connected',
          desired: true,
          reserved: true,
          instance: 'mock-screen',
        },
      ],
    },
  };
  const methods: string[] = [];
  const refresh = vi.fn(async () => structuredClone(snapshot));
  const f = await fixture({
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh,
    async call<T>(method: string): Promise<T> {
      methods.push(method);
      if (method === 'workspace.base') return '/synthetic/guest/workspace' as T;
      throw Error('SYNTHETIC-FORBIDDEN-EXECUTION');
    },
  });
  try {
    const before = [...methods];
    const result = await f.call(
      [{ kind: 'office' }, { kind: 'computer', mode: 'linux', access: 'control' }],
      'mock-linux',
    );
    expect(result.status).toBe(200);
    expect(result.value.checks.map((check) => check.state)).toEqual(['ready', 'missing']);
    expect(result.value.checks[1].reason).toBe('CONTROL_HELD_BY_HUMAN');
    expect(methods).toEqual(before);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(f.localStatus).not.toHaveBeenCalled();
    snapshot.status.available = false;
    const damaged = await f.call(
      [{ kind: 'office' }, { kind: 'computer', mode: 'linux', access: 'observe' }],
      'mock-damaged',
    );
    expect(damaged.value.checks.map((check) => check.state)).toEqual(['ready', 'unknown']);
  } finally {
    await f.close();
  }
});
