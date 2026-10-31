import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { documentLimit } from '@daban/protocol';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';

async function fixture(t: { after: (action: () => unknown) => unknown }) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-executor-'));
  const service = await startExecutor({ directory: root, port: 0, boot: 'mock-guest-boot' });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const token = (await readFile(path.join(root, 'token'), 'utf8')).trim();
  const client = new RemoteExecutor({ url: `${service.origin}/exec`, token });
  await client.ready;
  return { root, service, token, client };
}

test('executor authenticates one narrow RPC surface without model or approval endpoints', async (t) => {
  const { service, client } = await fixture(t);
  assert.equal(client.snapshot?.role, 'executor');
  assert.equal(client.snapshot?.version, 1);
  assert.equal(client.snapshot?.boot, 'mock-guest-boot');
  assert.equal('model' in client.snapshot!.computer, false);
  assert.equal((await fetch(`${service.origin}/api/model/settings`)).status, 404);
  assert.equal((await fetch(`${service.origin}/exec`, { method: 'POST', body: '{}' })).status, 403);
  await assert.rejects(client.call('model.configure', {}), { code: 'EXECUTION_INVALID_REQUEST' });
  await assert.rejects(
    client.call('computer.request', { method: 'POST', path: '/api/model/configure', body: {} }),
    { code: 'EXECUTION_INVALID_ROUTE' },
  );
  await assert.rejects(
    client.call('tools.open', {
      id: 'mock-run',
      bot: 'mock-a',
      workdir: '/tmp',
      canonicalRoot: '/tmp',
      limit: 10,
      apiKey: 'SYNTHETIC-PRIVATE',
    }),
    { code: 'EXECUTION_INVALID_REQUEST' },
  );
});

test('workspace handles stay in the guest and reject moved roots and outside scopes', async (t) => {
  const { client } = await fixture(t);
  const directory = await client.call<{
    root: string;
    path: string;
    canonical: string;
    handleId: string;
  }>('workspace.create', { parts: ['mock-run', 'mock-a'] });
  assert.deepEqual(Object.keys(directory).sort(), ['canonical', 'handleId', 'path', 'root']);
  await client.call('workspace.write', {
    handleId: directory.handleId,
    name: 'input.txt',
    data: Buffer.from('SYNTHETIC-47').toString('base64'),
  });
  const result = await client.call<{ content: string }>('workspace.read', {
    path: 'mock-run/mock-a/input.txt',
  });
  assert.equal(result.content, 'SYNTHETIC-47');
  await assert.rejects(client.call('workspace.list', { root: '/tmp' }), {
    code: 'EXECUTION_WORKSPACE_SCOPE',
  });
  await rename(directory.path, `${directory.path}-moved`);
  await symlink(`${directory.path}-moved`, directory.path);
  await assert.rejects(client.call('workspace.verify', { handleId: directory.handleId }), {
    code: 'TASK_DIRECTORY_MOVED',
  });
  await client.call('workspace.close', { handleId: directory.handleId });
});

test('the public document limit survives RPC staging and download while one extra byte is rejected', async (t) => {
  const { client } = await fixture(t);
  const directory = await client.call<{ handleId: string }>('workspace.create', {
    parts: ['mock-size', 'mock-a'],
  });
  const data = Buffer.alloc(documentLimit, 47).toString('base64');
  await client.call('workspace.write', {
    handleId: directory.handleId,
    name: 'synthetic-max.bin',
    data,
  });
  const downloaded = await client.call<{ data: string; size: number }>('workspace.download', {
    path: 'mock-size/mock-a/synthetic-max.bin',
  });
  assert.equal(downloaded.size, documentLimit);
  assert.equal(downloaded.data, data);
  await assert.rejects(
    client.call('workspace.write', {
      handleId: directory.handleId,
      name: 'synthetic-over.bin',
      data: Buffer.alloc(documentLimit + 1, 47).toString('base64'),
    }),
    { code: 'EXECUTION_INVALID_REQUEST' },
  );
});

test('guest tools retain an operation receipt instead of executing a retried write', async (t) => {
  const { client } = await fixture(t);
  const directory = await client.call<{ path: string; canonical: string }>('workspace.create', {
    parts: ['mock-run', 'mock-a'],
  });
  await client.call('tools.open', {
    id: 'mock-run',
    bot: 'mock-a',
    workdir: directory.path,
    canonicalRoot: directory.canonical,
    limit: 10,
  });
  const request = {
    runId: 'mock-run',
    operationId: 'mock-write',
    name: 'write_file',
    args: { path: 'result.txt', content: 'SYNTHETIC-RESULT' },
  };
  await client.call('tools.invoke', request);
  let state: { phase: string; result?: { isError?: boolean }; toolCount: number } | undefined;
  for (let count = 0; count < 50; count++) {
    state = await client.call('tools.poll', { runId: 'mock-run', operationId: 'mock-write' });
    if (state?.phase === 'settled') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state?.phase, 'settled');
  assert.equal(state?.result?.isError, undefined);
  assert.equal(state?.toolCount, 1);
  assert.deepEqual(await client.call('tools.invoke', request), state);
  await assert.rejects(
    client.call('tools.invoke', { ...request, args: { path: 'other.txt', content: 'wrong' } }),
    { code: 'EXECUTION_OPERATION_CONFLICT' },
  );
  await client.call('tools.drain', { runId: 'mock-run' });
});

test('full guest catalog offers persistent process tools and retains process input receipts', async (t) => {
  const { client } = await fixture(t);
  const directory = await client.call<{ path: string; canonical: string }>('workspace.create', {
    parts: ['mock-process-run', 'mock-a'],
  });
  const opened = await client.call<{ tools: { name: string; description: string }[] }>(
    'tools.open',
    {
      id: 'mock-process-run',
      bot: 'mock-a',
      workdir: directory.path,
      canonicalRoot: directory.canonical,
      limit: 20,
    },
  );
  assert.ok(opened.tools.some((tool) => tool.name === 'process_start'));
  assert.match(opened.tools.find((tool) => tool.name === 'shell')!.description, /sudo/);
  const invoke = async (operationId: string, name: string, args: Record<string, unknown>) => {
    await client.call('tools.invoke', { runId: 'mock-process-run', operationId, name, args });
    for (let count = 0; count < 100; count++) {
      const state = await client.call<{
        phase: string;
        result?: { content: { type: string; text?: string }[] };
      }>('tools.poll', { runId: 'mock-process-run', operationId });
      if (state.phase === 'settled') return JSON.parse(state.result!.content[0].text!);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Synthetic operation did not finish');
  };
  const started = await invoke('mock-process-start', 'process_start', {
    command: 'read -r value; printf "%s" "$value"',
  });
  assert.equal(started.id, 'mock-process-start');
  await invoke('mock-process-input', 'process_input', {
    id: started.id,
    data: 'SYNTHETIC-INPUT\n',
  });
  let result: { phase: string; stdout: string } = { phase: 'unknown', stdout: '' };
  for (let count = 0; count < 100; count++) {
    result = await invoke(`mock-process-poll-${count}`, 'process_poll', { id: started.id });
    if (result.phase === 'exited') break;
  }
  assert.equal(result.stdout, 'SYNTHETIC-INPUT');
  const pending = await invoke('mock-process-background', 'process_start', {
    command: 'sleep 30 & wait',
  });
  await client.call('tools.cancel', { runId: 'mock-process-run' });
  await assert.rejects(
    client.call('tools.invoke', {
      runId: 'mock-process-run',
      operationId: 'mock-after-stop',
      name: 'write_file',
      args: { path: 'late.txt', content: 'SYNTHETIC-LATE' },
    }),
    { code: 'EXECUTION_RUN_CLOSED' },
  );
  const cancelled = await client.call<{ phase: string }>('process.poll', { id: pending.id });
  assert.equal(cancelled.phase, 'cancelled');
  await client.call('tools.drain', { runId: 'mock-process-run' });
});

test('a shell operation retried after service replacement keeps its original durable process receipt', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-shell-owner-'));
  const first = await startExecutor({ directory: root, port: 0, boot: 'mock-shell-boot' });
  let second: Awaited<ReturnType<typeof startExecutor>> | undefined;
  t.after(async () => {
    await first.close();
    await second?.close();
    await rm(root, { recursive: true, force: true });
  });
  const connect = async (origin: string) => {
    const client = new RemoteExecutor({
      url: `${origin}/exec`,
      token: (await readFile(path.join(root, 'token'), 'utf8')).trim(),
    });
    await client.ready;
    return client;
  };
  const original = await connect(first.origin);
  const directory = await original.call<{ path: string; canonical: string }>('workspace.create', {
    parts: ['mock-shell-run', 'mock-a'],
  });
  const run = {
    id: 'mock-shell-run',
    bot: 'mock-a',
    workdir: directory.path,
    canonicalRoot: directory.canonical,
    limit: 10,
  };
  const request = {
    runId: run.id,
    operationId: 'mock-shell-operation',
    name: 'shell',
    args: { command: 'printf x >> marker' },
  };
  const invoke = async (client: RemoteExecutor) => {
    await client.call('tools.open', run);
    await client.call('tools.invoke', request);
    for (let count = 0; count < 100; count++) {
      const state = await client.call<{ phase: string }>('tools.poll', {
        runId: run.id,
        operationId: request.operationId,
      });
      if (state.phase === 'settled') return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Synthetic shell operation did not settle');
  };
  await invoke(original);
  await first.close();
  second = await startExecutor({ directory: root, port: 0, boot: 'mock-shell-boot' });
  await invoke(await connect(second.origin));
  assert.equal(await readFile(path.join(directory.path, 'marker'), 'utf8'), 'x');
});

test('closed runs do not consume active capacity and their ids remain retired after restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-closed-runs-'));
  const first = await startExecutor({ directory: root, port: 0, boot: 'mock-run-boot' });
  let second: Awaited<ReturnType<typeof startExecutor>> | undefined;
  t.after(async () => {
    await first.close();
    await second?.close();
    await rm(root, { recursive: true, force: true });
  });
  const connect = async (origin: string) => {
    const client = new RemoteExecutor({
      url: `${origin}/exec`,
      token: (await readFile(path.join(root, 'token'), 'utf8')).trim(),
    });
    await client.ready;
    return client;
  };
  const client = await connect(first.origin);
  const directory = await client.call<{ path: string; canonical: string }>('workspace.create', {
    parts: ['mock-task', 'mock-a'],
  });
  const fields = {
    bot: 'mock-a',
    workdir: directory.path,
    canonicalRoot: directory.canonical,
    limit: 1,
  };
  for (let index = 0; index < 270; index++) {
    const id = `mock-retired-${index}`;
    await client.call('tools.open', { id, ...fields });
    await client.call('tools.drain', { runId: id });
  }
  await assert.rejects(client.call('tools.open', { id: 'mock-retired-0', ...fields }), {
    code: 'EXECUTION_RUN_CLOSED',
  });
  await first.close();
  second = await startExecutor({ directory: root, port: 0, boot: 'mock-next-run-boot' });
  const restarted = await connect(second.origin);
  await assert.rejects(restarted.call('tools.open', { id: 'mock-retired-0', ...fields }), {
    code: 'EXECUTION_RUN_CLOSED',
  });
  await restarted.call('tools.open', { id: 'mock-new-live', ...fields });
  await restarted.call('tools.drain', { runId: 'mock-new-live' });
});
