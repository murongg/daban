import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  disconnected,
  type PeerEvent,
  type RemoteIdentity,
  type RemotePeerPort,
  type RemoteSignal,
} from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { RemoteAccess } from './remote-access.js';
import { remoteProof } from './remote-crypto.js';
import { RemoteGateway } from './remote-gateway.js';
import { RemoteKeys } from './remote-identity.js';
import { RemoteStore } from './remote-store.js';

type Signal = Extract<RemoteSignal, { type: 'signal' }>;
const signals = vi.hoisted(() => new Map<string, (message: Signal) => unknown>());
vi.mock('./remote-signal.js', () => ({
  SignalConnection: class {
    connected = true;
    constructor(options: {
      keys: { identity: RemoteIdentity };
      signal: (message: Signal) => unknown;
    }) {
      signals.set(options.keys.identity.id, options.signal);
    }
    async start() {
      return [];
    }
    send() {}
    close() {}
  },
}));

test('real remote sessions project status/connect and pushes for each accepted schema without granting authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-remote-'));
  const directory = path.join(root, 'host');
  const keys = await RemoteKeys.open(directory, 'Synthetic Host');
  const a = await RemoteKeys.open(path.join(root, 'a'), 'Synthetic A');
  const b = await RemoteKeys.open(path.join(root, 'b'), 'Synthetic B');
  const store = new RemoteStore({
    file: path.join(directory, 'remote.sqlite'),
    host: keys.identity.id,
    workspace: keys.identity.id,
  });
  await store.ready;
  store.pair(a.identity, 'controller');
  store.pair(b.identity, 'controller');
  store.close();
  let receive: (event: Exclude<PeerEvent, { type: 'result' }>) => unknown = () => {};
  const opened: string[] = [];
  const sent: { session: string; message: Record<string, unknown>; channel?: string }[] = [];
  const peer: RemotePeerPort = {
    async open(session) {
      opened.push(session);
    },
    async signal() {},
    async close() {},
    async send(session, data, channel) {
      sent.push({ session, message: JSON.parse(data) as Record<string, unknown>, channel });
    },
    subscribe(listener) {
      receive = listener;
      return () => {};
    },
  };
  const snapshot = {
    ...disconnected('ready'),
    contextInspector: 1,
    preflight: 1,
    fileReview: { available: true },
    delivery: true,
    searchSettings: true,
    approvalRules: { capability: 'approval-rules-v3' as const, available: true, revision: 0 },
  };
  snapshot.model = {
    ...snapshot.model,
    modelAccess: { scope: 'a'.repeat(64), fallback: true, diagnostics: true, cli: false },
    fallbackModel: 'provider:mock-provider:mock-model',
    probeRevision: 0,
  };
  let modelWrites = 0;
  const modelStatus = {
    provider: 'mock-provider',
    model: 'provider:mock-provider:mock-model',
    configured: true,
    revision: 1,
    requestId: 'mock-model-save',
    modelAccess: snapshot.model.modelAccess,
    fallbackModel: snapshot.model.fallbackModel,
    probeRevision: 0,
  };
  const host = new RemoteAccess({
    directory,
    name: 'Synthetic Host',
    platform: 'mock-platform',
    peer,
    dispatch: async (command) => {
      if (command.type === 'model.configure') {
        modelWrites++;
        return modelStatus;
      }
      return snapshot;
    },
  });
  try {
    await host.ready;
    await host.command({ type: 'host', enabled: true, server: 'https://relay.example.test' });
    const open = async (session: string, controller: RemoteKeys) => {
      const sdp = 'SYNTHETIC SDP';
      signals.get(keys.identity.id)!({
        type: 'signal',
        session,
        from: controller.identity,
        payload: {
          type: 'offer',
          sdp,
          signature: controller.sign(
            remoteProof('sdp', [session, controller.identity.id, keys.identity.id, 'offer', sdp]),
          ),
        },
      });
      await vi.waitFor(() => expect(opened).toContain(session));
      receive({ type: 'state', session, state: 'connected' });
    };
    await open('mock-session-a', a);
    await open('mock-session-b', b);
    const message = (session: string, value: unknown) =>
      receive({ type: 'message', session, data: JSON.stringify(value) });
    const read = async (
      session: string,
      id: string,
      method = 'status',
      params: Record<string, unknown> = {},
    ) => {
      const before = sent.length;
      message(session, {
        type: 'request',
        id,
        host: keys.identity.id,
        workspace: keys.identity.id,
        method,
        params,
      });
      await vi.waitFor(() =>
        expect(sent.slice(before).some((item) => item.message.id === id)).toBe(true),
      );
      return sent.slice(before).find((item) => item.message.id === id)!.message.value;
    };
    expect(await read('mock-session-a', 'mock-baseline')).toEqual(disconnected('ready'));
    message('mock-session-a', {
      type: 'snapshot-capabilities',
      host: 'f'.repeat(64),
      workspace: keys.identity.id,
      accept: { contextInspector: 1, preflight: 1 },
    });
    expect(await read('mock-session-a', 'mock-wrong-target')).toEqual(disconnected('ready'));
    message('mock-session-a', {
      type: 'snapshot-capabilities',
      host: keys.identity.id,
      workspace: keys.identity.id,
      accept: { contextInspector: 1, preflight: 1 },
    });
    expect(await read('mock-session-a', 'mock-accepted', 'connect')).toEqual({
      ...disconnected('ready'),
      contextInspector: 1,
      preflight: 1,
    });
    expect(await read('mock-session-b', 'mock-legacy-peer')).toEqual(disconnected('ready'));
    message('mock-session-a', {
      type: 'snapshot-capabilities',
      host: keys.identity.id,
      workspace: keys.identity.id,
      accept: { contextInspector: 1 },
      schema: 2,
    });
    expect(await read('mock-session-a', 'mock-schema-2')).toEqual({
      ...disconnected('ready'),
      contextInspector: 1,
      model: snapshot.model,
    });
    message('mock-session-a', {
      type: 'snapshot-capabilities',
      host: keys.identity.id,
      workspace: keys.identity.id,
      accept: {},
      schema: 3,
    });
    expect(await read('mock-session-a', 'mock-unsupported-schema')).toEqual({
      ...disconnected('ready'),
      contextInspector: 1,
      model: snapshot.model,
    });
    const save = {
      input: {
        model: modelStatus.model,
        apiKey: 'synthetic-key',
        revision: 0,
        requestId: 'mock-model-save',
      },
    };
    expect(await read('mock-session-a', 'mock-save-receipt', 'model.configure', save)).toEqual(
      modelStatus,
    );
    message('mock-session-b', {
      type: 'snapshot-capabilities',
      host: 'f'.repeat(64),
      workspace: keys.identity.id,
      accept: { contextInspector: 1 },
      schema: 2,
    });
    expect(await read('mock-session-b', 'mock-foreign-schema')).toEqual(disconnected('ready'));
    message('mock-session-b', {
      type: 'snapshot-capabilities',
      host: keys.identity.id,
      workspace: keys.identity.id,
      accept: { contextInspector: 1 },
      schema: 2,
    });
    expect(await read('mock-session-b', 'mock-3012-preview')).toEqual({
      ...disconnected('ready'),
      contextInspector: 1,
      model: snapshot.model,
    });
    message('mock-session-a', {
      type: 'snapshot-capabilities',
      host: keys.identity.id,
      workspace: keys.identity.id,
      accept: { contextInspector: 1, preflight: 1 },
      schema: 2,
      formats: { approvalRules: 'approval-rules-v3', delivery: true, searchSettings: true },
    });
    const modern = {
      ...disconnected('ready'),
      contextInspector: 1,
      preflight: 1,
      model: snapshot.model,
      delivery: true,
      searchSettings: true,
      approvalRules: snapshot.approvalRules,
    };
    expect(await read('mock-session-a', 'mock-exact-formats')).toEqual(modern);
    // The Host's local state and a different peer must retain their own independent schema decisions.
    expect(snapshot).toMatchObject({
      contextInspector: 1,
      preflight: 1,
      fileReview: { available: true },
      delivery: true,
      approvalRules: snapshot.approvalRules,
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await vi.waitFor(() => expect(sent.some((item) => item.channel === 'events')).toBe(true));
    for (const event of sent.filter((item) => item.channel === 'events'))
      expect(event.message.value).toEqual(
        event.session === 'mock-session-a'
          ? modern
          : { ...disconnected('ready'), contextInspector: 1, model: snapshot.model },
      );
    receive({ type: 'state', session: 'mock-session-a', state: 'closed' });
    await open('mock-session-reconnected', a);
    expect(await read('mock-session-reconnected', 'mock-empty-after-reconnect')).toEqual(
      disconnected('ready'),
    );
    const {
      modelAccess: _access,
      fallbackModel: _fallback,
      probeRevision: _probe,
      ...legacyStatus
    } = modelStatus;
    expect(
      await read('mock-session-reconnected', 'mock-save-receipt', 'model.configure', save),
    ).toEqual(legacyStatus);
    expect(modelWrites).toBe(1);
    await host.command({ type: 'revoke', device: a.identity.id });
    expect(host.controllers().some((device) => device.id === a.identity.id)).toBe(false);
  } finally {
    await host.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

test('context and current main observations stay fresh while writes deduplicate and reads reauthorize', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-observation-'));
  const keys = await RemoteKeys.open(path.join(root, 'keys'), 'Synthetic Controller');
  const store = new RemoteStore({
    file: path.join(root, 'remote.sqlite'),
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
  });
  await store.ready;
  store.pair(keys.identity, 'controller');
  let revision = 0;
  const gateway = new RemoteGateway(store, async () => ({ revision: ++revision }));
  const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
  try {
    const queries = [
      { method: 'context.inspect', params: { query: { scope } } },
      {
        method: 'context.source',
        params: { query: { scope, revision: 1, ref: { scope, seq: 1 } } },
      },
      { method: 'budget.settings', params: {} },
      { method: 'approval.rules.list', params: { scope: { kind: 'bot', bot: scope.bot } } },
      {
        method: 'approval.rules.receipt',
        params: { scope: { kind: 'bot', bot: scope.bot }, requestId: 'mock-edit' },
      },
      {
        method: 'approval.rules.preview',
        params: {
          scope: { kind: 'bot', bot: scope.bot },
          trigger: 'interactive',
          mode: 'auto',
          selector: { kind: 'url', url: 'https://example.test/synthetic' },
        },
      },
      { method: 'delivery.get', params: { query: { workId: 'mock-work' } } },
      { method: 'delivery.checklist.get', params: { query: { workId: 'mock-work' } } },
      { method: 'projectMemory.status', params: {} },
      {
        method: 'projectMemory.list',
        params: { scope: { projectId: 'mock-project', revision: 1 } },
      },
      {
        method: 'projectMemory.receipt',
        params: { scope: { projectId: 'mock-project', revision: 1 }, requestId: 'mock-memory' },
      },
      { method: 'search.status', params: {} },
      { method: 'search.saved', params: { query: { kind: 'check', requestId: 'mock-search' } } },
      {
        method: 'model.saved',
        params: {
          input: {
            scope: 'a'.repeat(64),
            requestId: 'mock-model-request',
            revision: 2,
            connection: 'mock-provider',
            model: 'provider:mock-provider:mock-model',
          },
        },
      },
      { method: 'budget.read', params: { query: { scope } } },
      { method: 'budget.goal', params: { owner: { bot: scope.bot, chatRevision: 0 } } },
      { method: 'projects.list', params: {} },
      { method: 'projects.status', params: {} },
      { method: 'projects.receipt', params: { requestId: 'mock-project-request' } },
      { method: 'schedule.receipt', params: { id: 'mock-schedule', firing: 'mock-firing' } },
    ];
    for (const { method, params } of queries) {
      const request = {
        type: 'request',
        id: `mock-${method.replaceAll('.', '-')}`,
        host: 'a'.repeat(64),
        workspace: 'mock-workspace',
        method,
        params,
      };
      const first = await gateway.invoke(keys.identity.id, 'mock-session', request);
      const next = await gateway.invoke(keys.identity.id, 'mock-session', request);
      expect(next).not.toEqual(first);
    }
    const selection = {
      type: 'request',
      id: 'mock-project-selection',
      host: 'a'.repeat(64),
      workspace: 'mock-workspace',
      method: 'projects.select',
      params: { bot: scope.bot, scope: { projectId: 'mock-project', revision: 1 } },
    };
    const selected = await gateway.invoke(keys.identity.id, 'mock-session', selection);
    expect(await gateway.invoke(keys.identity.id, 'mock-session', selection)).toEqual(selected);
    store.revoke(keys.identity.id);
    await expect(
      gateway.invoke(keys.identity.id, 'mock-session', {
        type: 'request',
        id: 'mock-revoked',
        host: 'a'.repeat(64),
        workspace: 'mock-workspace',
        method: 'context.inspect',
        params: { query: { scope } },
      }),
    ).rejects.toThrow('REMOTE_UNAUTHORIZED');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  'compatible hints are ordered and real transport failure is not hidden: %s',
  async (transportFailure) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-context-controller-'));
    const directory = path.join(root, 'controller');
    const keys = await RemoteKeys.open(directory, 'Synthetic Controller');
    const host = await RemoteKeys.open(path.join(root, 'host'), 'Synthetic Host');
    const store = new RemoteStore({
      file: path.join(directory, 'remote.sqlite'),
      host: keys.identity.id,
      workspace: keys.identity.id,
    });
    await store.ready;
    store.pair(host.identity, 'host', {
      server: 'https://relay.example.test',
      workspace: host.identity.id,
      platform: 'synthetic',
    });
    store.close();
    let receive: (event: Exclude<PeerEvent, { type: 'result' }>) => unknown = () => {};
    const sent: Record<string, unknown>[] = [];
    let legacyAccepted = false;
    const peer: RemotePeerPort = {
      async open(session) {
        receive({ type: 'state', session, state: 'connected' });
        receive({ type: 'state', session, state: 'connected' });
      },
      async signal() {},
      async close() {},
      async send(session, data) {
        const message = JSON.parse(data) as Record<string, unknown>;
        sent.push(message);
        if (transportFailure && message.schema === 2) throw Error('REMOTE_PEER_FAILED');
        // Frozen legacy parser accepts only the original four fields and ignores the version extension.
        if (
          message.type === 'snapshot-capabilities' &&
          Object.keys(message).every((key) => ['type', 'host', 'workspace', 'accept'].includes(key))
        )
          legacyAccepted = true;
        if (message.type === 'request')
          receive({
            type: 'message',
            session,
            data: JSON.stringify({
              type: 'reply',
              id: message.id,
              host: host.identity.id,
              workspace: host.identity.id,
              ok: true,
              value: {
                ...disconnected('ready'),
                ...(legacyAccepted ? { contextInspector: 1 } : {}),
              },
            }),
          });
      },
      subscribe(listener) {
        receive = listener;
        return () => {};
      },
    };
    const controller = new RemoteAccess({
      directory,
      name: 'Synthetic Controller',
      platform: 'synthetic',
      peer,
      dispatch: async () => {
        throw Error('UNEXPECTED LOCAL DISPATCH');
      },
    });
    try {
      await controller.ready;
      if (transportFailure) {
        await expect(controller.request({ type: 'status' }, host.identity.id)).rejects.toThrow(
          'REMOTE_SESSION_CLOSED',
        );
        expect(sent.some((message) => message.type === 'request')).toBe(false);
        return;
      }
      expect(await controller.request({ type: 'status' }, host.identity.id)).toEqual({
        ...disconnected('ready'),
        contextInspector: 1,
      });
      expect(sent[0]).toEqual({
        type: 'snapshot-capabilities',
        host: host.identity.id,
        workspace: host.identity.id,
        accept: { contextInspector: 1, preflight: 1, fileReview: 1 },
      });
      expect(sent[1]).toEqual({ ...sent[0], schema: 2 });
      expect(sent[2]).toMatchObject({
        ...sent[1],
        formats: { approvalRules: 'approval-rules-v3', delivery: true, searchSettings: true },
      });
      expect(sent[3].type).toBe('request');
      expect(await controller.request({ type: 'status' }, host.identity.id)).toEqual({
        ...disconnected('ready'),
        contextInspector: 1,
      });
      expect(sent.filter((message) => message.type === 'snapshot-capabilities')).toHaveLength(3);
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
