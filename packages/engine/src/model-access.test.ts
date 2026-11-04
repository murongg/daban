import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { ModelSettings } from './settings.js';

const completion = () =>
  Response.json({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
  });
const input = {
  model: 'provider:mock-provider:mock-model',
  apiKey: 'synthetic-candidate-key',
  revision: 1,
  requestId: 'mock-configure',
  connection: {
    id: 'mock-provider',
    name: 'Synthetic provider',
    baseURL: 'https://models.example.test/v1',
    models: [
      {
        id: 'mock-model',
        name: 'Synthetic model',
        vision: false,
        contextWindow: 64000,
        maxTokens: 4096,
      },
    ],
  },
};

function deferred() {
  let resolve: () => unknown = () => undefined;
  const promise = new Promise<undefined>((done) => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
}

test('model access: concurrent identical configuration performs one directory and one generation probe', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-claim-'));
  const entered = deferred();
  const gate = deferred();
  const calls: string[] = [];
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/models')) return new Response(null, { status: 404 });
    entered.resolve();
    await gate.promise;
    return completion();
  });
  let pending: Promise<unknown> | undefined;
  try {
    await settings.save({ apiKey: 'synthetic-previous-key' });
    const previous = await settings.resolve();
    pending = Promise.all([settings.configure(input), settings.configure(structuredClone(input))]);
    await entered.promise;
    expect((await settings.resolve()).binding).toBe(previous.binding);
    gate.resolve();
    const results = await pending;
    expect(results).toEqual([await settings.status(), await settings.status()]);
    expect(calls.filter((url) => url.endsWith('/models'))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith('/chat/completions'))).toHaveLength(1);
  } finally {
    gate.resolve();
    await pending?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: pending claim rejects changed identity and competing configuration before dispatch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-busy-'));
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () => {
    calls++;
    entered.resolve();
    await gate.promise;
    return Response.json({ data: [{ id: 'mock-model' }] });
  });
  let pending: Promise<unknown> | undefined;
  try {
    await settings.save({ apiKey: 'synthetic-previous-key' });
    pending = settings.configure(input);
    await entered.promise;
    const changed = settings.configure({ ...input, apiKey: 'synthetic-other-key' });
    const competing = settings.configure({ ...input, requestId: 'mock-competing' });
    const legacy = settings.save({ apiKey: 'synthetic-legacy-write' });
    const decisions = Promise.all([
      expect(changed).rejects.toMatchObject({ code: 'MODEL_SETTINGS_ID_REUSED' }),
      expect(competing).rejects.toMatchObject({ code: 'MODEL_SETTINGS_BUSY' }),
      expect(legacy).rejects.toMatchObject({ code: 'MODEL_SETTINGS_BUSY' }),
    ]);
    await nextTurn();
    gate.resolve();
    await decisions;
    await pending;
    expect(calls).toBe(1);
  } finally {
    gate.resolve();
    await pending?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: lost generation response remains unknown across same-ID retries and restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-unknown-'));
  let calls = 0;
  const fetcher: typeof fetch = async (url) => {
    calls++;
    if (String(url).endsWith('/models')) return new Response(null, { status: 404 });
    throw new Error('synthetic response lost after dispatch');
  };
  const file = path.join(root, 'credentials.json');
  const settings = new ModelSettings(file, fetcher);
  try {
    await settings.save({ apiKey: 'synthetic-previous-key' });
    const previous = await settings.resolve();
    await expect(settings.configure(input)).rejects.toMatchObject({
      code: 'MODEL_API_UNAVAILABLE',
    });
    await expect(settings.configure(input)).rejects.toMatchObject({
      code: 'MODEL_OPERATION_UNKNOWN',
    });
    const restarted = new ModelSettings(file, fetcher);
    await expect(restarted.configure(input)).rejects.toMatchObject({
      code: 'MODEL_OPERATION_UNKNOWN',
    });
    expect(calls).toBe(2);
    expect((await restarted.resolve()).binding).toBe(previous.binding);
    expect(JSON.stringify(await restarted.status(true))).not.toContain('synthetic-previous-key');
    expect(JSON.stringify(await restarted.status(true))).not.toContain(input.apiKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: failed operations retain every consumed identity at the current revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-failed-'));
  let calls = 0;
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () => {
    calls++;
    return new Response(null, { status: 401 });
  });
  try {
    await settings.save({ apiKey: 'synthetic-previous-key' });
    for (const requestId of [input.requestId, 'mock-second-failure', input.requestId])
      await expect(settings.configure({ ...input, requestId })).rejects.toMatchObject({
        code: 'MODEL_API_UNAUTHORIZED',
      });
    expect(calls).toBe(2);
    expect((await settings.status()).revision).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: first configuration durably claims before any request without activating candidate credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-first-claim-'));
  const entered = deferred();
  const gate = deferred();
  const file = path.join(root, 'credentials.json');
  const settings = new ModelSettings(file, async () => {
    entered.resolve();
    await gate.promise;
    return Response.json({ data: [{ id: 'mock-model' }] });
  });
  let pending: Promise<unknown> | undefined;
  try {
    pending = settings.configure({ ...input, revision: 0 });
    await entered.promise;
    const snapshot = await readFile(file, 'utf8').catch(() => '');
    expect(snapshot).toContain(input.requestId);
    expect(snapshot).not.toContain(input.apiKey);
    expect((await settings.status()).configured).toBe(false);
    const recovery = path.join(root, 'recovered.json');
    await writeFile(recovery, snapshot, { mode: 0o600 });
    let replayed = 0;
    const restarted = new ModelSettings(recovery, async () => {
      replayed++;
      return completion();
    });
    await expect(restarted.configure({ ...input, revision: 0 })).rejects.toMatchObject({
      code: 'MODEL_OPERATION_UNKNOWN',
    });
    expect(replayed).toBe(0);
  } finally {
    gate.resolve();
    await pending?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: a failed durable claim never contacts the provider', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-claim-write-'));
  const blocker = path.join(root, 'blocker');
  await writeFile(blocker, 'synthetic non-directory');
  let calls = 0;
  const settings = new ModelSettings(path.join(blocker, 'credentials.json'), async () => {
    calls++;
    return completion();
  });
  try {
    await expect(settings.configure({ ...input, revision: 0 })).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: saved queries bind the original Host, target and revision without dispatching', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-saved-'));
  let calls = 0;
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () => {
    calls++;
    return Response.json({ data: [{ id: 'mock-model' }] });
  });
  try {
    await settings.save({ apiKey: 'synthetic-previous-key' });
    const scope = (await settings.status(true)).modelAccess!.scope;
    await settings.configure(input);
    const query = {
      scope,
      requestId: input.requestId,
      revision: input.revision,
      connection: input.connection.id,
      model: input.model,
    };
    expect(await settings.saved(query)).toMatchObject({
      phase: 'committed',
      committedRevision: 2,
      current: { revision: 2 },
    });
    for (const wrong of [
      { ...query, scope: 'mock-wrong-host' },
      { ...query, connection: 'mock-wrong-target' },
      { ...query, model: 'deepseek-flash' },
      { ...query, revision: 0 },
    ])
      await expect(settings.saved(wrong)).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(JSON.stringify(await settings.saved(query))).not.toContain(input.apiKey);
    expect(JSON.stringify(await settings.saved(query))).not.toContain('fingerprint');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: a single configured fallback is opt-in, replayable and cannot equal the default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-fallback-setting-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-model' }] }),
  );
  try {
    await settings.save({ apiKey: 'synthetic-previous-key' });
    await settings.configure(input);
    const status = await settings.status(true);
    expect(status.fallbackModel).toBeUndefined();
    const request = {
      scope: status.modelAccess!.scope,
      requestId: 'mock-enable-fallback',
      revision: 2,
      model: 'deepseek-v4-pro',
    };
    const saved = await settings.fallback(request);
    expect(saved).toMatchObject({ revision: 3, fallbackModel: 'deepseek-v4-pro' });
    expect(await settings.fallback(request)).toEqual(saved);
    await expect(
      settings.fallback({
        ...request,
        requestId: 'mock-identical-primary',
        revision: 3,
        model: input.model,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_FALLBACK_INVALID' });
    await expect(
      settings.fallback({
        ...request,
        requestId: 'mock-missing-fallback',
        revision: 3,
        model: 'provider:mock-missing:mock-model',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(
      await settings.fallback({
        ...request,
        revision: 3,
        requestId: 'mock-disable-fallback',
        model: null,
      }),
    ).not.toHaveProperty('fallbackModel');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: diagnosis has an independent claimed revision and list success never implies inference success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-diagnose-'));
  let failed = false;
  let calls = 0;
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url) => {
    calls++;
    return String(url).endsWith('/models')
      ? Response.json({ data: [{ id: 'mock-model' }] })
      : failed
        ? new Response(null, { status: 401 })
        : completion();
  });
  try {
    await settings.save({ apiKey: 'synthetic-previous-key' });
    await settings.configure(input);
    const scope = (await settings.status(true)).modelAccess!.scope;
    const request = {
      scope,
      requestId: 'mock-list-diagnosis',
      revision: 2,
      probeRevision: 0,
      connection: input.connection,
      model: 'mock-model',
      kind: 'list',
    };
    const list = await settings.diagnose({
      ...request,
      connection: { id: input.connection.id, baseURL: input.connection.baseURL },
    });
    expect(list).toMatchObject({
      phase: 'settled',
      diagnostic: { kind: 'list', model: input.model },
    });
    failed = true;
    const inference = {
      ...request,
      requestId: 'mock-inference-diagnosis',
      probeRevision: 1,
      connection: { id: input.connection.id, baseURL: input.connection.baseURL },
      kind: 'inference',
    };
    expect(await settings.diagnose(inference)).toMatchObject({
      phase: 'settled',
      error: 'MODEL_API_UNAUTHORIZED',
    });
    expect(await settings.diagnose(inference)).toMatchObject({
      phase: 'settled',
      error: 'MODEL_API_UNAUTHORIZED',
    });
    expect(calls).toBe(3);
    expect((await settings.status()).revision).toBe(2);
    expect((await settings.status(true)).probeRevision).toBe(2);
    await expect(
      settings.diagnose({ ...inference, requestId: 'mock-stale-diagnosis' }),
    ).rejects.toMatchObject({ code: 'MODEL_PROBE_CONFLICT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: explicit disconnect clears the last key and keeps monotonic revision and its receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-disconnect-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  try {
    await settings.save({ apiKey: 'synthetic-disconnect-key' });
    const scope = (await settings.status(true)).modelAccess!.scope;
    const request = {
      scope,
      requestId: 'mock-disconnect',
      revision: 1,
      connection: 'deepseek-official',
      disconnect: true,
    };
    const removed = await settings.remove(request);
    expect(removed).toMatchObject({
      phase: 'committed',
      current: { configured: false, revision: 2, connections: [] },
    });
    expect(await readFile(settings.file, 'utf8')).not.toContain('synthetic-disconnect-key');
    expect(await settings.remove(request)).toEqual(removed);
    await expect(settings.resolve()).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    await settings.save({ apiKey: 'synthetic-reconfigured-key' });
    expect((await settings.status()).revision).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: ModelRuns exposes Bot and captured-route references to the credential owner', async () => {
  const { ModelRuns } = await import('./model.js');
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-references-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-model' }] }),
  );
  const models = new ModelRuns({
    settings,
    dir: path.join(root, 'models'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  });
  try {
    const primary = { ...input, revision: 0, requestId: 'mock-ref-primary' };
    await settings.configure(primary);
    await settings.configure({
      ...primary,
      revision: 1,
      requestId: 'mock-ref-secondary',
      model: 'provider:mock-secondary:mock-model',
      connection: {
        ...input.connection,
        id: 'mock-secondary',
        baseURL: 'https://secondary.example.test/v1',
      },
    });
    await settings.configure({ model: input.model, revision: 2, requestId: 'mock-ref-default' });
    await models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic Bot',
      instructions: '',
      memory: '',
      color: 'mint',
      model: 'provider:mock-secondary:mock-model',
    });
    const status = await settings.status(true);
    const result = await settings.remove({
      scope: status.modelAccess!.scope,
      requestId: 'mock-ref-remove',
      revision: 3,
      connection: 'mock-secondary',
    });
    expect(result).toMatchObject({
      phase: 'failed',
      error: 'MODEL_CONNECTION_REFERENCED',
      references: ['bot'],
      current: { revision: 3 },
    });
    expect((await settings.resolve('provider:mock-secondary:mock-model')).provider).toBe(
      'mock-secondary',
    );
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: a received HTTP failure is settled while a lost diagnostic response remains unknown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-diagnostic-outcome-'));
  let lost = false;
  let calls = 0;
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'mock-model' }] });
    calls++;
    if (lost) throw new Error('Synthetic response lost');
    return new Response(null, { status: 503 });
  });
  try {
    await settings.save({ apiKey: 'synthetic-previous-key' });
    await settings.configure(input);
    const scope = (await settings.status(true)).modelAccess!.scope;
    const request = {
      scope,
      requestId: 'mock-http-failure',
      revision: 2,
      probeRevision: 0,
      connection: { id: input.connection.id, baseURL: input.connection.baseURL },
      model: 'mock-model',
      kind: 'inference',
    };
    expect(await settings.diagnose(request)).toMatchObject({
      phase: 'settled',
      error: 'MODEL_API_UNAVAILABLE',
    });
    lost = true;
    const unknown = { ...request, requestId: 'mock-lost-diagnostic', probeRevision: 1 };
    expect(await settings.diagnose(unknown)).toMatchObject({
      phase: 'unknown',
      error: 'MODEL_OPERATION_UNKNOWN',
    });
    expect(await settings.diagnose(unknown)).toMatchObject({ phase: 'unknown' });
    expect(calls).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: provider edits cannot remove a model still bound by another owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-edit-reference-'));
  let calls = 0;
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () => {
    calls++;
    return Response.json({ data: [{ id: 'mock-model' }, { id: 'mock-replacement' }] });
  });
  try {
    await settings.configure({ ...input, revision: 0 });
    settings.registerReferences(async (connection) =>
      connection.models.some((model) => model.id === 'mock-model') ? ['bot'] : [],
    );
    await expect(
      settings.configure({
        ...input,
        revision: 1,
        requestId: 'mock-remove-bound-model',
        model: 'provider:mock-provider:mock-replacement',
        connection: {
          ...input.connection,
          models: [{ ...input.connection.models[0], id: 'mock-replacement' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CONNECTION_REFERENCED' });
    expect(calls).toBe(1);
    expect((await settings.status()).model).toBe(input.model);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const pendingWrite of [false, true])
  test(`model access: a ${pendingWrite ? 'pending' : 'committed'} Bot binding admitted during a paid probe prevents model removal without replay`, async () => {
    const { ModelRuns } = await import('./model.js');
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-binding-race-'));
    const entered = deferred();
    const probeGate = deferred();
    const bindingEntered = deferred();
    const bindingGate = deferred();
    const calls: string[] = [];
    let validating = false;
    const file = path.join(root, 'credentials.json');
    const fetcher: typeof fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/models')) return new Response(null, { status: 404 });
      if (validating) {
        entered.resolve();
        await probeGate.promise;
      }
      return completion();
    };
    const settings = new ModelSettings(file, fetcher);
    const models = new ModelRuns({
      settings,
      dir: path.join(root, 'models'),
      workspace: path.join(root, 'workspace'),
      origin: 'http://127.0.0.1:12345',
    });
    const kept = { ...input.connection.models[0], id: 'mock-kept' };
    const update = {
      ...input,
      model: 'provider:mock-provider:mock-kept',
      requestId: 'mock-remove-during-probe',
      connection: { ...input.connection, models: [kept] },
    };
    let pending: Promise<unknown> | undefined;
    let binding: Promise<unknown> | undefined;
    try {
      await settings.configure({
        ...update,
        revision: 0,
        requestId: 'mock-seed-binding-race',
        connection: { ...input.connection, models: [...input.connection.models, kept] },
      });
      const scope = (await settings.status(true)).modelAccess!.scope;
      const paidBefore = calls.filter((url) => url.endsWith('/chat/completions')).length;
      validating = true;
      pending = settings.configure(update).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      if (pendingWrite)
        models.profiles.modelGuard = (reference, write) =>
          settings.withModel(reference, async () => {
            bindingEntered.resolve();
            await bindingGate.promise;
            return write();
          });
      binding = models.profiles.register({
        id: 'mock-racing-bot',
        name: 'Synthetic racing Bot',
        instructions: '',
        memory: '',
        color: 'mint',
        model: input.model,
      });
      if (pendingWrite) await bindingEntered.promise;
      else await binding;
      probeGate.resolve();
      expect(await pending).toMatchObject({ error: { code: 'MODEL_CONNECTION_REFERENCED' } });
      expect(
        await settings.saved({
          scope,
          requestId: update.requestId,
          revision: 1,
          connection: input.connection.id,
          model: update.model,
        }),
      ).toMatchObject({
        phase: 'failed',
        error: 'MODEL_CONNECTION_REFERENCED',
        current: { revision: 1 },
      });
      await expect(settings.configure(update)).rejects.toMatchObject({
        code: 'MODEL_CONNECTION_REFERENCED',
      });
      const restarted = new ModelSettings(file, fetcher);
      await expect(restarted.configure(update)).rejects.toMatchObject({
        code: 'MODEL_CONNECTION_REFERENCED',
      });
      expect(calls.filter((url) => url.endsWith('/chat/completions'))).toHaveLength(paidBefore + 1);
      expect((await restarted.resolve(input.model)).model).toBe(input.model);
      bindingGate.resolve();
      await binding;
      expect((await models.profiles.get('mock-racing-bot'))?.model).toBe(input.model);
    } finally {
      probeGate.resolve();
      bindingGate.resolve();
      await pending?.catch(() => undefined);
      await binding?.catch(() => undefined);
      await models.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test('model access: legacy key saves cannot make the selected default equal its fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-legacy-fallback-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  try {
    await settings.save({ apiKey: 'synthetic-legacy-fallback-key' });
    await settings.fallback({
      scope: (await settings.status(true)).modelAccess!.scope,
      requestId: 'mock-legacy-fallback',
      revision: 1,
      model: 'deepseek-v4-pro',
    });
    await expect(
      settings.save({ apiKey: 'synthetic-legacy-fallback-key', model: 'deepseek-v4-pro' }),
    ).rejects.toMatchObject({ code: 'MODEL_FALLBACK_INVALID' });
    expect(await settings.status()).toMatchObject({
      configured: true,
      model: 'deepseek-flash',
      revision: 2,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model access: imported unresolved model references remain authored metadata until credentials are configured', async () => {
  const { ModelRuns } = await import('./model.js');
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-unresolved-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-model' }] }),
  );
  const models = new ModelRuns({
    settings,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  });
  try {
    const profile = await models.profiles.register({
      id: 'mock-import',
      name: 'Synthetic imported Bot',
      instructions: '',
      memory: '',
      color: 'mint',
      model: 'provider:mock-imported:mock-model',
    });
    expect(profile.model).toBe('provider:mock-imported:mock-model');
    expect((await settings.status()).configured).toBe(false);
    await expect(settings.resolve(profile.model)).rejects.toMatchObject({
      code: 'MODEL_NOT_CONFIGURED',
    });
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
