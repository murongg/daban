import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  type BotBundle,
  botBundleText,
  type ExecutionSnapshot,
  executionCapabilities,
} from '@daban/protocol';
import { startAgent } from './host-server.js';

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
  assert.ok(address && typeof address === 'object');
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
    assert.equal(
      (await call(app.socketPath, '/api/model/inspect', 'wrong-token', input)).status,
      403,
    );
    const result = await call(app.socketPath, '/api/model/inspect', app.token, input);
    assert.equal(result.status, 200);
    assert.deepEqual(result.value, {
      kind: 'list',
      revision: 0,
      models: [{ id: 'mock-alpha', name: 'mock-alpha', contextWindow: 64000, source: 'provider' }],
    });
    assert.deepEqual(headers, ['Bearer synthetic-provider-key']);
    assert.equal(methods.includes('computer.request'), false);
    await assert.rejects(access(path.join(root, 'model/credentials.json')));
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
    assert.equal(identity.status, 200);
    assert.equal((identity.value as { role: string }).role, 'agent');
    const rejected = await call(socket, '/api/state', 'mock-guest-execution-token');
    assert.equal(rejected.status, 403);
    const response = await call(socket, '/api/state', agent.token);
    assert.equal(response.status, 200);
    const state = response.value as {
      profiles: unknown[];
      interactions: unknown[];
      computers: unknown;
      agent: { location: string };
    };
    assert.deepEqual(state.profiles, []);
    assert.deepEqual(state.interactions, []);
    assert.deepEqual(state.computers, snapshot.status);
    assert.equal(state.agent.location, 'host');
    assert.ok(methods.includes('workspace.base'));
    await assert.rejects(access(guestRoot));
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('host production composition refuses missing guest configuration instead of local execution fallback', async () => {
  await assert.rejects(
    startAgent({
      dataRoot: '/mock/root',
      socketPath: '/mock/root/agent.sock',
      scope: 'a'.repeat(64),
      sdkFile: '/mock/sdk.js',
    } as Parameters<typeof startAgent>[0]),
    /AGENT_REMOTE_REQUIRED/,
  );
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
    assert.equal((await call(app.socketPath, '/api/state', app.token)).status, 200);
    assert.equal(app.recovery, previous);
    assert.equal(app.recovery!.receipt('mock-reboot').phase, 'claimed');
    current = { ...current, boot: 'mock-new-boot', nonce: 'mock-new-boot-service' };
    await app.refreshExecution();
    assert.equal((await call(app.socketPath, '/api/state', app.token)).status, 200);
    assert.notEqual(app.recovery, previous);
    assert.equal(app.recovery!.receipt('mock-reboot').phase, 'complete');
    assert.equal(app.recovery!.admit(), true);
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
    assert.equal(response.status, 200);
    assert.equal((response.value as { phase: string }).phase, 'claimed');
    const state = await call(app.socketPath, '/api/state', app.token);
    assert.equal((state.value as { reboot: { vm: string } }).reboot.vm, 'running');
    assert.equal(
      (
        await call(app.socketPath, '/api/host/recovery', app.token, {
          type: 'task.start',
          bot: 'mock-bot',
        })
      ).status,
      400,
    );
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
    assert.equal(result.status, 200);
    assert.equal(
      (result.value as { computers: { available: boolean } }).computers.available,
      false,
    );
    assert.deepEqual((result.value as { interactions: unknown[] }).interactions, []);
    assert.equal((await call(app.socketPath, '/api/recovery', app.token)).status, 200);
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
    await assert.rejects(
      startAgent({
        dataRoot: root,
        socketPath,
        scope: 'e'.repeat(64),
        execution,
        sdkFile: path.join(root, 'missing-sdk.js'),
      }),
      /AGENT_SDK_UNAVAILABLE/,
    );
    await writeFile(socketPath, 'mock existing host file', { mode: 0o600 });
    await assert.rejects(
      startAgent({
        dataRoot: root,
        socketPath,
        scope: 'e'.repeat(64),
        execution,
        sdkFile: await mockSdk(root),
      }),
      /AGENT_UNSAFE_SOCKET/,
    );
    assert.equal(await readFile(socketPath, 'utf8'), 'mock existing host file');
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
    assert.equal((identity.value as { dataRoot: string }).dataRoot, path.resolve(root));
    assert.equal((identity.value as { socketPath: string }).socketPath, path.resolve(socketPath));
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
    assert.equal(frame.status, 200);
    assert.deepEqual(frame.value, image);
    assert.equal((await call(app.socketPath, '/api/model/private', app.token)).status, 404);
    assert.equal(forwarded.length, 1);
    const connect = call(app.socketPath, '/api/computers/action', app.token, {
      id: 'mock-connect',
      bot: profile.id,
      action: 'connect',
      revision: 0,
    });
    await entered;
    await assert.rejects(
      app.models.start(profile.id, { requestId: 'mock-start', prompt: 'Mock task' }),
      { code: 'COMPUTER_CHANGING' },
    );
    await assert.rejects(
      app.lifecycle!.operate({
        id: 'mock-archive',
        bot: profile.id,
        action: 'archive',
        revision: profile.revision,
      }),
      { code: 'BOT_COMPUTER_CONNECTED' },
    );
    release();
    assert.equal((await connect).status, 200);
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
    assert.equal((await app.models.bundles.status(header.id)).state, 'complete');
    assert.equal(extracts, 1);
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
    assert.equal(calls, 0);
    assert.equal((await call(app.socketPath, '/api/recovery', app.token)).status, 200);
    const state = await call(app.socketPath, '/api/state', app.token);
    assert.equal(state.status, 200);
    assert.equal((state.value as { computers: { available: boolean } }).computers.available, false);
    online = true;
    await app.refreshExecution();
    assert.equal((await call(app.socketPath, '/api/state', app.token)).status, 200);
    workspaceRoot = '/mock-guest/moved-workspace';
    await assert.rejects(app.refreshExecution(), /WORKSPACE_CHANGED/);
    assert.equal(app.models.admit('mock-bot'), false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
