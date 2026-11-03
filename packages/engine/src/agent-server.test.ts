import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type BotBundle,
  botBundleText,
  type ExecutionSnapshot,
  executionCapabilities,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { startAgent } from './host-server.js';
import { LocalComputerClient } from './local-computer.js';

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
      arch: 'arm64',
      kernel: 'mock-kernel',
      node: 'v24',
      browser: 'mock-browser',
    },
    events: [],
    bots: {},
  },
  status: { available: true, limit: 2, revision: 0, items: [] },
};
function call(socket: string, route: string, token?: string, body?: unknown) {
  return new Promise<{ status: number; value: unknown }>((resolve, reject) => {
    const r = request(
      {
        socketPath: socket,
        path: route,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          host: '127.0.0.1:8766',
          ...(token ? { 'x-prototype-token': token } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (data) => chunks.push(data));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            value: response.headers['content-type']?.startsWith('image/jpeg')
              ? Buffer.concat(chunks)
              : JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function mockSdk(root: string) {
  const file = path.join(root, 'mock-sdk.js');
  await writeFile(file, 'export class DeepSeekHarness {}', { mode: 0o600 });
  return file;
}
test('model discovery runs through authenticated host IPC without forwarding a key to the guest or saving settings', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-host-model-inspect-')));
  const methods: string[] = [];
  const headers: unknown[] = [];
  const vendor = createServer((req, res) => {
    headers.push(req.headers.authorization);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'mock-alpha', context_length: 64000 }] }));
  });
  await new Promise<unknown>((resolve) => vendor.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = vendor.address();
  expect.assert(address && typeof address === 'object');
  const app = await startAgent({
    dataRoot: root,
    socketPath: path.join(root, 'agent.sock'),
    scope: 'a'.repeat(64),
    sdkFile: await mockSdk(root),
    execution: {
      ready: Promise.resolve(snapshot),
      snapshot,
      refresh: async () => snapshot,
      async call(method: string) {
        methods.push(method);
        if (method === 'workspace.base') return '/mock-guest/workspace';
        if (method === 'computer.snapshot') return snapshot;
        throw Error('Unexpected synthetic method');
      },
    },
  });
  try {
    const input = {
      kind: 'list',
      revision: 0,
      connection: { id: 'mock-provider', baseURL: `http://127.0.0.1:${address.port}/v1` },
      apiKey: 'synthetic-provider-key',
    };
    expect((await call(app.socketPath, '/api/model/inspect', 'wrong-token', input)).status).toBe(
      403,
    );
    const result = await call(app.socketPath, '/api/model/inspect', app.token, input);
    expect(result.status).toBe(200);
    expect(result.value).toStrictEqual({
      kind: 'list',
      revision: 0,
      models: [{ id: 'mock-alpha', name: 'mock-alpha', contextWindow: 64000, source: 'provider' }],
    });
    expect(headers).toStrictEqual(['Bearer synthetic-provider-key']);
    expect(methods.includes('computer.request')).toBe(false);
    await expect(access(path.join(root, 'model/credentials.json'))).rejects.toThrowError();
    const inserted = await call(app.socketPath, '/api/bots/a/insert', app.token, {
      id: 'mock-insert',
      text: 'Synthetic inserted message.',
      runId: 'mock-missing-run',
      chatRevision: 0,
    });
    expect(inserted.status).toBe(409);
    expect(inserted.value).toStrictEqual({ error: 'TASK_INSERT_STALE' });
    expect(
      (
        await call(app.socketPath, '/api/bots/a/insert', app.token, {
          id: 'invalid id',
          text: 'Synthetic inserted message.',
          runId: 'mock-missing-run',
          chatRevision: 0,
        })
      ).status,
    ).toBe(400);
  } finally {
    await app.close();
    await new Promise<unknown>((resolve, reject) =>
      vendor.close((error) => (error ? reject(error) : resolve(undefined))),
    );
    await rm(root, { recursive: true, force: true });
  }
});
test('host agent listens only on private Unix IPC and composes authoritative state with guest computer data', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-host-agent-'))),
    socket = path.join(root, 'agent.sock'),
    guestRoot = `/guest-only/mock-workspace-${path.basename(root)}`;
  const methods: string[] = [];
  const execution = {
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh: async () => snapshot,
    call: async (method: string) => {
      methods.push(method);
      if (method === 'computer.snapshot') return snapshot;
      if (method === 'workspace.base') return guestRoot;
      if (method === 'computer.status') return snapshot.status;
      throw Error(`Unexpected synthetic ${method}`);
    },
  };
  const agent = await startAgent({
    dataRoot: root,
    socketPath: socket,
    scope: 'a'.repeat(64),
    execution,
    sdkFile: await mockSdk(root),
  });
  try {
    const identity = await call(socket, '/agent/identity');
    expect(identity.status).toBe(200);
    expect((identity.value as { role: string }).role).toBe('agent');
    const rejected = await call(socket, '/api/state', 'mock-guest-execution-token');
    expect(rejected.status).toBe(403);
    const response = await call(socket, '/api/state', agent.token);
    expect(response.status).toBe(200);
    const state = response.value as {
      profiles: unknown[];
      interactions: unknown[];
      computers: unknown;
      agent: { location: string };
    };
    expect(state.profiles).toStrictEqual([]);
    expect(state.interactions).toStrictEqual([]);
    expect(state.computers).toStrictEqual(snapshot.status);
    expect(state.agent.location).toBe('host');
    expect.assert(methods.includes('workspace.base'));
    await expect(access(guestRoot)).rejects.toThrowError();
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('host production composition refuses missing guest configuration instead of local execution fallback', async () => {
  await expect(
    startAgent({
      dataRoot: '/mock/root',
      socketPath: '/mock/root/agent.sock',
      scope: 'a'.repeat(64),
      sdkFile: '/mock/sdk.js',
    } as Parameters<typeof startAgent>[0]),
  ).rejects.toThrowError(/AGENT_REMOTE_REQUIRED/);
});

test('guest service restarts keep a claimed host fence while actual new boots complete it', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-host-recovery-')));
  let current = structuredClone(snapshot);
  const execution = {
    ready: Promise.resolve(current),
    snapshot: current,
    refresh: async () => current,
    call: async (method: string) => {
      if (method === 'workspace.base') return '/mock-guest/workspace';
      throw new Error('Unexpected mock method');
    },
  };
  const app = await startAgent({
    dataRoot: root,
    socketPath: path.join(root, 'agent.sock'),
    scope: 'b'.repeat(64),
    execution,
    sdkFile: await mockSdk(root),
  });
  try {
    const previous = app.recovery!;
    const review = previous.review();
    const prepared = await previous.prepare({
      id: 'mock-reboot',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    await previous.claim(prepared.id, prepared.revision);
    current = { ...current, nonce: 'mock-new-service' };
    expect((await call(app.socketPath, '/api/state', app.token)).status).toBe(200);
    expect(app.recovery).toBe(previous);
    expect(app.recovery!.receipt('mock-reboot').phase).toBe('claimed');
    current = { ...current, boot: 'mock-new-boot', nonce: 'mock-new-boot-service' };
    await app.refreshExecution();
    expect((await call(app.socketPath, '/api/state', app.token)).status).toBe(200);
    expect(app.recovery).not.toBe(previous);
    expect(app.recovery!.receipt('mock-reboot').phase).toBe('complete');
    expect(app.recovery!.admit()).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('authenticated host power operations run outside the generic recovery mutation lease', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-host-power-')));
  const execution = {
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh: async () => snapshot,
    call: async (method: string) => {
      if (method === 'workspace.base') return '/mock-guest/workspace';
      throw new Error('Unexpected mock method');
    },
  };
  let app: Awaited<ReturnType<typeof startAgent>>;
  const reboot = {
    status: () => ({ available: true as const, revision: 0, busy: false, vm: 'running' as const }),
    async invoke(command: import('@daban/protocol').RuntimeCommand) {
      if (command.type !== 'recovery.restart') throw new Error('Wrong mock command');
      const prepared = await app.recovery!.prepare(command.request);
      return app.recovery!.claim(prepared.id, prepared.revision);
    },
  };
  app = await startAgent({
    dataRoot: root,
    socketPath: path.join(root, 'agent.sock'),
    scope: 'c'.repeat(64),
    execution,
    sdkFile: await mockSdk(root),
    reboot,
  });
  try {
    const review = app.recovery!.review();
    const response = await call(app.socketPath, '/api/host/recovery', app.token, {
      type: 'recovery.restart',
      request: {
        id: 'mock-host-power',
        revision: review.revision,
        review: review.digest,
        confirmation: 'restart-all-apps',
      },
    });
    expect(response.status).toBe(200);
    expect((response.value as { phase: string }).phase).toBe('claimed');
    const state = await call(app.socketPath, '/api/state', app.token);
    expect((state.value as { reboot: { vm: string } }).reboot.vm).toBe('running');
    expect(
      (
        await call(app.socketPath, '/api/host/recovery', app.token, {
          type: 'task.start',
          bot: 'mock-bot',
        })
      ).status,
    ).toBe(400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('host state and recovery remain readable while Linux execution is stopped', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-host-offline-')));
  let offline = false;
  const execution = {
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh: async () => {
      if (offline) throw new Error('MOCK_GUEST_STOPPED');
      return snapshot;
    },
    call: async (method: string) => {
      if (method === 'workspace.base') return '/mock-guest/workspace';
      throw new Error('Unexpected mock method');
    },
  };
  const app = await startAgent({
    dataRoot: root,
    socketPath: path.join(root, 'agent.sock'),
    scope: 'd'.repeat(64),
    execution,
    sdkFile: await mockSdk(root),
  });
  try {
    offline = true;
    const result = await call(app.socketPath, '/api/state', app.token);
    expect(result.status).toBe(200);
    expect((result.value as { computers: { available: boolean } }).computers.available).toBe(false);
    expect((result.value as { interactions: unknown[] }).interactions).toStrictEqual([]);
    expect((await call(app.socketPath, '/api/recovery', app.token)).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('missing SDK and unsafe existing socket files are refused without modifying them', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-host-refusal-')));
  const execution = {
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh: async () => snapshot,
    call: async () => '/mock-guest/workspace',
  };
  const socketPath = path.join(root, 'agent.sock');
  try {
    await expect(
      startAgent({
        dataRoot: root,
        socketPath,
        scope: 'e'.repeat(64),
        execution,
        sdkFile: path.join(root, 'missing-sdk.js'),
      }),
    ).rejects.toThrowError(/AGENT_SDK_UNAVAILABLE/);
    await writeFile(socketPath, 'mock existing host file', { mode: 0o600 });
    await expect(
      startAgent({
        dataRoot: root,
        socketPath,
        scope: 'e'.repeat(64),
        execution,
        sdkFile: await mockSdk(root),
      }),
    ).rejects.toThrowError(/AGENT_UNSAFE_SOCKET/);
    expect(await readFile(socketPath, 'utf8')).toBe('mock existing host file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('private Unix identity retains requested absolute paths across macOS temporary aliases', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-alias-'));
  const socketPath = path.join(root, 'agent.sock');
  const execution = {
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh: async () => snapshot,
    call: async () => '/mock-guest/workspace',
  };
  const app = await startAgent({
    dataRoot: root,
    socketPath,
    scope: 'f'.repeat(64),
    execution,
    sdkFile: await mockSdk(root),
  });
  try {
    const identity = await call(socketPath, '/agent/identity');
    expect((identity.value as { dataRoot: string }).dataRoot).toBe(path.resolve(root));
    expect((identity.value as { socketPath: string }).socketPath).toBe(path.resolve(socketPath));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('only native routes reach the guest and connect holds a host admission/lifecycle fence', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-host-forward-')));
  const forwarded: Record<string, unknown>[] = [];
  let enter!: () => unknown;
  let release!: () => unknown;
  const entered = new Promise<unknown>((resolve) => {
    enter = () => resolve(undefined);
  });
  const held = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const image = Buffer.from('mock jpeg bytes');
  const execution = {
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh: async () => snapshot,
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'workspace.base') return '/mock-guest/workspace';
      if (method !== 'computer.request') throw new Error('Unexpected mock method');
      forwarded.push(params);
      if (params.path === '/api/computers/action') {
        enter();
        await held;
        return { ok: true };
      }
      return { mimeType: 'image/jpeg', data: image.toString('base64') };
    },
  };
  const app = await startAgent({
    dataRoot: root,
    socketPath: path.join(root, 'agent.sock'),
    scope: 'a'.repeat(64),
    execution,
    sdkFile: await mockSdk(root),
  });
  try {
    const profile = await app.models.profiles.register({
      id: 'mock-bot',
      name: 'Mock Bot',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const frame = await call(
      app.socketPath,
      '/api/bots/mock-bot/frame?instance=mock-instance&epoch=0',
      app.token,
    );
    expect(frame.status).toBe(200);
    expect(frame.value).toStrictEqual(image);
    expect((await call(app.socketPath, '/api/model/private', app.token)).status).toBe(404);
    expect(forwarded.length).toBe(1);
    const connect = call(app.socketPath, '/api/computers/action', app.token, {
      id: 'mock-connect',
      bot: profile.id,
      action: 'connect',
      revision: 0,
    });
    await entered;
    await expect(
      app.models.start(profile.id, { requestId: 'mock-start', prompt: 'Mock task' }),
    ).rejects.toMatchObject({ code: 'COMPUTER_CHANGING' });
    await expect(
      app.lifecycle!.operate({
        id: 'mock-archive',
        bot: profile.id,
        action: 'archive',
        revision: profile.revision,
      }),
    ).rejects.toMatchObject({ code: 'BOT_COMPUTER_CONNECTED' });
    release();
    expect((await connect).status).toBe(200);
  } finally {
    release();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('host portable imports revalidate original documents through the guest document port', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-host-bundle-docs-')));
  let extracts = 0;
  const execution = {
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh: async () => snapshot,
    async call(method: string) {
      if (method === 'workspace.base') return '/mock-guest/workspace';
      if (method === 'documents.extract') {
        extracts++;
        return 'SYNTHETIC GUEST DOCUMENT';
      }
      throw new Error('Unexpected synthetic guest operation');
    },
  };
  const app = await startAgent({
    dataRoot: root,
    socketPath: path.join(root, 'agent.sock'),
    scope: 'b'.repeat(64),
    execution,
    sdkFile: await mockSdk(root),
  });
  try {
    const bundle: BotBundle = {
      format: 'daban.bot',
      version: 1,
      profile: { name: 'Mock portable Bot', instructions: '', color: 'mint' },
      preferences: '',
      skills: [],
      knowledge: [
        {
          path: 'mock/document.md',
          content: 'SYNTHETIC EDITED DOCUMENT',
          original: {
            name: 'mock.pdf',
            data: Buffer.from('SYNTHETIC ORIGINAL').toString('base64'),
          },
        },
      ],
    };
    const text = botBundleText(bundle);
    const header = {
      id: 'mock-guest-document-bundle',
      sha256: createHash('sha256').update(text).digest('hex'),
      size: Buffer.byteLength(text),
    };
    await app.models.bundles.begin(header);
    await app.models.bundles.submit(header.id, bundle);
    await app.models.bundles.settled;
    expect((await app.models.bundles.status(header.id)).state).toBe('complete');
    expect(extracts).toBe(1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('offline cold start serves host recovery from a cached root without guest calls and reconnects only explicitly', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-host-cold-offline-')));
  let online = false;
  let calls = 0;
  let workspaceRoot = '/mock-guest/workspace';
  const execution = {
    ready: Promise.resolve(snapshot),
    snapshot,
    refresh: async () => {
      if (!online) throw new Error('EXECUTION_UNAVAILABLE');
      return snapshot;
    },
    async call(method: string) {
      calls++;
      if (!online) throw new Error('EXECUTION_UNAVAILABLE');
      if (method === 'workspace.base') return workspaceRoot;
      throw new Error('Unexpected mock method');
    },
  };
  const app = await startAgent({
    dataRoot: root,
    socketPath: path.join(root, 'agent.sock'),
    scope: 'c'.repeat(64),
    execution,
    sdkFile: await mockSdk(root),
    offlineWorkspaceRoot: workspaceRoot,
  });
  try {
    expect(calls).toBe(0);
    expect((await call(app.socketPath, '/api/recovery', app.token)).status).toBe(200);
    const state = await call(app.socketPath, '/api/state', app.token);
    expect(state.status).toBe(200);
    expect((state.value as { computers: { available: boolean } }).computers.available).toBe(false);
    online = true;
    await app.refreshExecution();
    expect((await call(app.socketPath, '/api/state', app.token)).status).toBe(200);
    workspaceRoot = '/mock-guest/moved-workspace';
    await expect(app.refreshExecution()).rejects.toThrowError(/WORKSPACE_CHANGED/);
    expect(app.models.admit('mock-bot')).toBe(false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a host with a VM also blocks archiving a Bot that still owns the native desktop', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-native-archive-')));
  const localComputer = new LocalComputerClient(root);
  localComputer.status = async () => ({
    platform: 'darwin',
    available: true,
    shortcut: true,
    permissions: { screen: true, accessibility: true },
    session: {
      id: 'mock-session',
      bot: 'mock-bot',
      revision: 1,
      owner: 'human',
      model: 'mock-model',
      modelRevision: 1,
    },
  });
  const app = await startAgent({
    dataRoot: root,
    socketPath: path.join(root, 'a.sock'),
    scope: 'a'.repeat(64),
    sdkFile: await mockSdk(root),
    localComputer,
    execution: {
      ready: Promise.resolve(snapshot),
      snapshot,
      refresh: async () => snapshot,
      call: async (method) => {
        if (method === 'workspace.base') return '/mock-guest/workspace';
        if (method === 'computer.snapshot') return snapshot;
        throw new Error('Unexpected synthetic method');
      },
    },
  });
  try {
    const profile = await app.models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic native Bot',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    await expect(
      app.lifecycle!.operate({
        id: 'mock-archive',
        bot: profile.id,
        action: 'archive',
        revision: profile.revision,
      }),
    ).rejects.toMatchObject({ code: 'BOT_COMPUTER_CONNECTED' });
    const retained = await app.models.profiles.get(profile.id);
    expect.assert(retained);
    expect(retained.archived).not.toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
