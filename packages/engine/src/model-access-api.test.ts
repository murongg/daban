import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isModelSaved, isModelStatus, managedProtocol } from '@daban/protocol';
import { expect, test } from 'vitest';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

function deferred() {
  let resolve: () => unknown = () => undefined;
  const promise = new Promise<undefined>((done) => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
}
test('model HTTP owns credentials, exact receipts and an accepted probe after its client disconnects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-http-'));
  // Match Host startup: Windows control tokens require an ACL-validated root.
  await secureDirectory(root);
  const entered = deferred();
  const gate = deferred();
  let directoryCalls = 0;
  let inferenceCalls = 0;
  const provider = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe('Bearer synthetic-http-model-key');
    if (request.url === '/v1/models') {
      directoryCalls++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'mock-primary' }, { id: 'mock-backup' }] }));
    } else {
      inferenceCalls++;
      entered.resolve();
      await gate.promise;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
        }),
      );
    }
  });
  await new Promise<undefined>((resolve) =>
    provider.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = provider.address();
  expect.assert(address && typeof address !== 'string');
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const headers = {
    'x-prototype-token': app.token,
    'x-daban-client-protocol': String(managedProtocol),
    'content-type': 'application/json',
  };
  const call = async (
    action: string,
    value: unknown,
    options: { token?: string; signal?: AbortSignal } = {},
  ) => {
    const response = await fetch(`${app.url}/api/model/${action}`, {
      method: 'POST',
      headers: { ...headers, ...(options.token ? { 'x-prototype-token': options.token } : {}) },
      body: JSON.stringify(value),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { status: response.status, value: (await response.json()) as unknown };
  };
  const status = async () => {
    const value: unknown = await (
      await fetch(`${app.url}/api/model/settings?catalog=1`, { headers })
    ).json();
    expect.assert(isModelStatus(value));
    return value;
  };
  let pending: Promise<unknown> | undefined;
  try {
    await app.models!.ready;
    const scope = (await status()).modelAccess!.scope;
    expect(directoryCalls + inferenceCalls).toBe(0);
    const input = {
      requestId: 'mock-http-configure',
      revision: 0,
      model: 'provider:mock-http:mock-primary',
      apiKey: 'synthetic-http-model-key',
      connection: {
        id: 'mock-http',
        name: 'Synthetic HTTP provider',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        models: ['mock-primary', 'mock-backup'].map((id) => ({
          id,
          name: id,
          vision: false,
          contextWindow: 64000,
          maxTokens: 2048,
          capabilities: { toolCall: true },
        })),
      },
    };
    const [first, duplicate] = await Promise.all([
      call('configure', input),
      call('configure', input),
    ]);
    expect(first.status).toBe(200);
    expect(duplicate).toEqual(first);
    expect(directoryCalls).toBe(1);
    const identity = {
      scope,
      requestId: input.requestId,
      revision: 0,
      connection: 'mock-http',
      model: input.model,
    };
    expect((await call('saved', identity)).value).toMatchObject({
      phase: 'committed',
      committedRevision: 1,
    });
    expect((await call('saved?extra=1', identity)).status).toBe(400);
    expect((await call('saved', identity, { token: 'synthetic-denied-token' })).status).toBe(403);
    expect((await call('saved', { ...identity, scope: 'mock-other-host' })).status).toBe(403);
    expect((await call('saved', { ...identity, apiKey: input.apiKey })).status).toBe(400);
    const probe = {
      scope,
      requestId: 'mock-http-inference',
      revision: 1,
      probeRevision: 0,
      connection: { id: 'mock-http', baseURL: input.connection.baseURL },
      model: 'mock-primary',
      kind: 'inference',
    };
    const abort = new AbortController();
    pending = call('diagnose', probe, { signal: abort.signal }).catch(() => undefined);
    await entered.promise;
    abort.abort();
    await pending;
    gate.resolve();
    const probeIdentity = { ...identity, revision: 1, requestId: probe.requestId };
    await expect
      .poll(async () => {
        const result = await call('saved', probeIdentity);
        return isModelSaved(result.value) ? result.value.phase : 'invalid';
      })
      .toBe('settled');
    expect((await call('diagnose', probe)).value).toMatchObject({
      phase: 'settled',
      diagnostic: { kind: 'inference' },
    });
    expect(inferenceCalls).toBe(1);
    expect(
      (
        await call('fallback', {
          scope,
          requestId: 'mock-http-fallback',
          revision: 1,
          model: 'provider:mock-http:mock-backup',
        })
      ).value,
    ).toMatchObject({ revision: 2, fallbackModel: 'provider:mock-http:mock-backup' });
    expect(
      (
        await call('remove', {
          scope,
          requestId: 'mock-http-in-use',
          revision: 2,
          connection: 'mock-http',
          disconnect: true,
        })
      ).value,
    ).toMatchObject({ phase: 'failed', references: ['fallback'] });
    await call('fallback', { scope, requestId: 'mock-http-disable', revision: 2, model: null });
    expect(
      (
        await call('remove', {
          scope,
          requestId: 'mock-http-disconnect',
          revision: 3,
          connection: 'mock-http',
          disconnect: true,
        })
      ).value,
    ).toMatchObject({ phase: 'committed', current: { configured: false, revision: 4 } });
    expect(await readFile(app.models!.settings.file, 'utf8')).not.toContain(input.apiKey);
    expect(JSON.stringify(await status())).not.toContain(input.apiKey);
    expect(directoryCalls).toBe(1);
    expect(inferenceCalls).toBe(1);
  } finally {
    gate.resolve();
    await pending?.catch(() => undefined);
    await app.close();
    provider.closeAllConnections();
    await new Promise<undefined>((resolve) => provider.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
});
