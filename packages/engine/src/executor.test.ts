import { mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { documentLimit } from '@daban/protocol';
import { expect, type TestContext, test } from 'vitest';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-executor-'));
  const service = await startExecutor({ directory: root, port: 0, boot: 'mock-guest-boot' });
  t.onTestFinished(async () => {
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
  expect(client.snapshot?.role).toBe('executor');
  expect(client.snapshot?.version).toBe(1);
  expect(client.snapshot?.boot).toBe('mock-guest-boot');
  expect('model' in client.snapshot!.computer).toBe(false);
  expect((await fetch(`${service.origin}/api/model/settings`)).status).toBe(404);
  expect((await fetch(`${service.origin}/exec`, { method: 'POST', body: '{}' })).status).toBe(403);
  await expect(client.call('model.configure', {})).rejects.toMatchObject({
    code: 'EXECUTION_INVALID_REQUEST',
  });
  await expect(
    client.call('computer.request', { method: 'POST', path: '/api/model/configure', body: {} }),
  ).rejects.toMatchObject({ code: 'EXECUTION_INVALID_ROUTE' });
  await expect(
    client.call('tools.open', {
      id: 'mock-run',
      bot: 'mock-a',
      workdir: '/tmp',
      canonicalRoot: '/tmp',
      limit: 10,
      apiKey: 'SYNTHETIC-PRIVATE',
    }),
  ).rejects.toMatchObject({ code: 'EXECUTION_INVALID_REQUEST' });
});

test('workspace handles stay in the guest and reject moved roots and outside scopes', async (t) => {
  const { client } = await fixture(t);
  const directory = await client.call<{
    root: string;
    path: string;
    canonical: string;
    handleId: string;
  }>('workspace.create', { parts: ['mock-run', 'mock-a'] });
  expect(Object.keys(directory).sort()).toStrictEqual(['canonical', 'handleId', 'path', 'root']);
  await client.call('workspace.write', {
    handleId: directory.handleId,
    name: 'input.txt',
    data: Buffer.from('SYNTHETIC-47').toString('base64'),
  });
  const result = await client.call<{ content: string }>('workspace.read', {
    path: 'mock-run/mock-a/input.txt',
  });
  expect(result.content).toBe('SYNTHETIC-47');
  await expect(client.call('workspace.list', { root: '/tmp' })).rejects.toMatchObject({
    code: 'EXECUTION_WORKSPACE_SCOPE',
  });
  await rename(directory.path, `${directory.path}-moved`);
  await symlink(`${directory.path}-moved`, directory.path);
  await expect(
    client.call('workspace.verify', { handleId: directory.handleId }),
  ).rejects.toMatchObject({
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
  expect(downloaded.size).toBe(documentLimit);
  expect(downloaded.data).toBe(data);
  await expect(
    client.call('workspace.write', {
      handleId: directory.handleId,
      name: 'synthetic-over.bin',
      data: Buffer.alloc(documentLimit + 1, 47).toString('base64'),
    }),
  ).rejects.toMatchObject({ code: 'EXECUTION_INVALID_REQUEST' });
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
  expect(state?.phase).toBe('settled');
  expect(state?.result?.isError).toBe(undefined);
  expect(state?.toolCount).toBe(1);
  expect(await client.call('tools.invoke', request)).toStrictEqual(state);
  await expect(
    client.call('tools.invoke', { ...request, args: { path: 'other.txt', content: 'wrong' } }),
  ).rejects.toMatchObject({ code: 'EXECUTION_OPERATION_CONFLICT' });
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
  expect.assert(opened.tools.some((tool) => tool.name === 'process_start'));
  expect(opened.tools.find((tool) => tool.name === 'shell')!.description).toMatch(/sudo/);
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
  expect(started.id).toBe('mock-process-start');
  await invoke('mock-process-input', 'process_input', {
    id: started.id,
    data: 'SYNTHETIC-INPUT\n',
  });
  let result: { phase: string; stdout: string } = { phase: 'unknown', stdout: '' };
  for (let count = 0; count < 100; count++) {
    result = await invoke(`mock-process-poll-${count}`, 'process_poll', { id: started.id });
    if (result.phase === 'exited') break;
  }
  expect(result.stdout).toBe('SYNTHETIC-INPUT');
  const pending = await invoke('mock-process-background', 'process_start', {
    command: 'sleep 30 & wait',
  });
  await client.call('tools.cancel', { runId: 'mock-process-run' });
  await expect(
    client.call('tools.invoke', {
      runId: 'mock-process-run',
      operationId: 'mock-after-stop',
      name: 'write_file',
      args: { path: 'late.txt', content: 'SYNTHETIC-LATE' },
    }),
  ).rejects.toMatchObject({ code: 'EXECUTION_RUN_CLOSED' });
  const cancelled = await client.call<{ phase: string }>('process.poll', { id: pending.id });
  expect(cancelled.phase).toBe('cancelled');
  await client.call('tools.drain', { runId: 'mock-process-run' });
});

test('a shell operation retried after service replacement keeps its original durable process receipt', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-shell-owner-'));
  const first = await startExecutor({ directory: root, port: 0, boot: 'mock-shell-boot' });
  let second: Awaited<ReturnType<typeof startExecutor>> | undefined;
  t.onTestFinished(async () => {
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
  expect(await readFile(path.join(directory.path, 'marker'), 'utf8')).toBe('x');
});

test('closed runs do not consume active capacity and their ids remain retired after restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-closed-runs-'));
  const first = await startExecutor({ directory: root, port: 0, boot: 'mock-run-boot' });
  let second: Awaited<ReturnType<typeof startExecutor>> | undefined;
  t.onTestFinished(async () => {
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
  await expect(
    client.call('tools.open', { id: 'mock-retired-0', ...fields }),
  ).rejects.toMatchObject({
    code: 'EXECUTION_RUN_CLOSED',
  });
  await first.close();
  second = await startExecutor({ directory: root, port: 0, boot: 'mock-next-run-boot' });
  const restarted = await connect(second.origin);
  await expect(
    restarted.call('tools.open', { id: 'mock-retired-0', ...fields }),
  ).rejects.toMatchObject({
    code: 'EXECUTION_RUN_CLOSED',
  });
  await restarted.call('tools.open', { id: 'mock-new-live', ...fields });
  await restarted.call('tools.drain', { runId: 'mock-new-live' });
});
