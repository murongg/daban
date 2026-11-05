import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { documentLimit, isReviewCapture, type ProjectResources, workspaceReviewCapability } from '@daban/protocol';
import { expect, type TestContext, test, vi } from 'vitest';
import { Fault } from './control.js';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';
import { browserEngine } from './playwright-input.js';

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

test.for(['parent', 'child'] as const)(
  'a %s legacy workspace cannot overlap managed project resources',
  async (relation, t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-overlap-'));
    const shared = relation === 'parent' ? root : path.join(root, 'projects', 'legacy');
    await mkdir(shared, { recursive: true, mode: 0o700 });
    await writeFile(path.join(shared, 'legacy.txt'), 'SYNTHETIC LEGACY');
    const service = await startExecutor({
      directory: root,
      workspace: shared,
      port: 0,
      boot: 'mock-boot',
    });
    t.onTestFinished(async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    });
    const client = new RemoteExecutor({
      url: `${service.origin}/exec`,
      token: (await readFile(path.join(root, 'token'), 'utf8')).trim(),
    });
    await client.ready;
    expect(client.snapshot?.capabilities).not.toContain('project-scope-v1');
    expect(await client.call('workspace.read', { path: 'legacy.txt' })).toMatchObject({
      content: 'SYNTHETIC LEGACY',
    });
    const resources: ProjectResources = {
      project: {
        id: 'mock-project',
        name: 'SYNTHETIC',
        revision: 1,
        status: 'active',
        grants: [],
        environment: { files: 'project', browser: 'private' },
      },
      files: 'mock-files',
      sharedProfile: 'mock-shared-profile',
      profiles: {},
    };
    await expect(
      client.call('projects.sync', resources as unknown as Record<string, unknown>),
    ).rejects.toMatchObject({ code: 'PROJECT_WORKSPACE_OVERLAP' });
  },
);

test('an unavailable project mirror fences project execution without disabling legacy files and receipts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-mirror-'));
  await mkdir(path.join(root, 'projects'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'projects/resources.json'), 'SYNTHETIC INVALID MIRROR', {
    mode: 0o600,
  });
  const service = await startExecutor({ directory: root, port: 0, boot: 'mock-boot' });
  t.onTestFinished(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const client = new RemoteExecutor({
    url: `${service.origin}/exec`,
    token: (await readFile(path.join(root, 'token'), 'utf8')).trim(),
  });
  await client.ready;
  expect(client.snapshot?.capabilities).not.toContain('project-scope-v1');
  expect(client.snapshot?.capabilities).toContain('task-run-v1');
  expect(await client.call('workspace.list', {})).toStrictEqual([]);
  const task = await client.call<{ path: string; canonical: string }>('workspace.create', {
    parts: ['synthetic-large-budget', 'mock-bot'],
  });
  await client.call('tools.open', {
    id: 'synthetic-large-budget',
    bot: 'mock-bot',
    workdir: task.path,
    canonicalRoot: task.canonical,
    limit: 1001,
  });
  await client.call('tools.drain', { runId: 'synthetic-large-budget' });
  await expect(
    client.call('projects.bind', {
      bot: 'mock-bot',
      scope: { projectId: 'mock-project', revision: 1 },
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_STORE_UNAVAILABLE' });
});

test('a locked replacement browser profile keeps the prior project resource binding', async (t) => {
  const { client } = await fixture(t);
  const resources: ProjectResources = {
    project: {
      id: 'mock-project',
      name: 'SYNTHETIC',
      revision: 1,
      status: 'active',
      grants: [{ bot: 'mock-bot', content: 'read', browser: false }],
      environment: { files: 'project', browser: 'private' },
    },
    files: 'mock-files',
    sharedProfile: 'mock-shared-profile',
    profiles: { 'mock-bot': 'mock-private-profile' },
  };
  await client.call('projects.sync', resources as unknown as Record<string, unknown>);
  const { chromium } = await browserEngine();
  const launch = vi
    .spyOn(chromium, 'launchPersistentContext')
    .mockRejectedValue(new Fault('BROWSER_PROFILE_LOCKED'));
  await expect(
    client.call('projects.sync', {
      ...resources,
      project: {
        ...resources.project,
        revision: 2,
        environment: { files: 'project', browser: 'project' },
        grants: [{ bot: 'mock-bot', content: 'read', browser: true }],
      },
    }),
  ).rejects.toMatchObject({ code: 'BROWSER_PROFILE_LOCKED' });
  expect(launch).toHaveBeenCalledTimes(1);
  expect(
    await client.call('workspace.list', {
      project: { scope: { projectId: 'mock-project', revision: 1 }, resourceId: resources.files },
    }),
  ).toStrictEqual([]);
});

test('project execution binds resource IDs, separates shared roots and rejects stale handles without exposing private staging', async (t) => {
  const { root, client } = await fixture(t);
  const resources = (id: string): ProjectResources => ({
    project: {
      id,
      name: 'SYNTHETIC',
      revision: 1,
      status: 'active',
      grants: [{ bot: 'mock-reader', content: 'read', browser: false }],
      environment: { files: 'project', browser: 'private' },
    },
    files: `${id}-files`,
    sharedProfile: `${id}-browser`,
    profiles: { 'mock-reader': `${id}-private` },
  });
  const alpha = resources('mock-alpha'),
    beta = resources('mock-beta');
  await client.call('projects.sync', alpha as unknown as Record<string, unknown>);
  await client.call('projects.sync', beta as unknown as Record<string, unknown>);
  for (const [resources, content] of [
    [alpha, 'SYNTHETIC ALPHA'],
    [beta, 'SYNTHETIC BETA'],
  ] as const) {
    await writeFile(path.join(root, 'projects', resources.files, 'files', 'same.txt'), content);
    expect(
      await client.call('workspace.read', {
        project: {
          scope: { projectId: resources.project.id, revision: 1 },
          resourceId: resources.files,
        },
        path: 'same.txt',
      }),
    ).toMatchObject({ content });
    const downloaded = await client.call<{ data: string }>('workspace.download', {
      project: {
        scope: { projectId: resources.project.id, revision: 1 },
        resourceId: resources.files,
      },
      path: 'same.txt',
    });
    expect(Buffer.from(downloaded.data, 'base64').toString()).toBe(content);
  }

  expect(
    await client.call('projects.bind', {
      bot: 'mock-reader',
      scope: { projectId: alpha.project.id, revision: 1 },
    }),
  ).toMatchObject({ bot: 'mock-reader' });
  const project = {
    scope: { projectId: alpha.project.id, revision: 1 },
    resourceId: alpha.files,
    bot: 'mock-reader',
    runId: 'mock-run',
  };
  const directory = await client.call<{ path: string; canonical: string; handleId: string }>(
    'workspace.create',
    { project, parts: ['model-runs', 'mock-run', 'mock-reader'] },
  );
  await client.call('workspace.write', {
    handleId: directory.handleId,
    name: 'mock.txt',
    data: Buffer.from('SYNTHETIC PRIVATE').toString('base64'),
  });
  const read = await client.call<{ content: string }>('workspace.read', {
    project,
    path: 'mock.txt',
  });
  expect(read.content).toBe('SYNTHETIC PRIVATE');
  expect(await client.call('workspace.list', {})).toStrictEqual([]);
  expect(
    await client.call('workspace.list', {
      project: { scope: project.scope, resourceId: alpha.files },
    }),
  ).toMatchObject([{ path: 'same.txt' }]);
  await expect(
    client.call('workspace.read', {
      project: { ...project, resourceId: beta.files },
      path: 'mock.txt',
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_ACCESS_DENIED' });
  await expect(
    client.call('workspace.read', { project, root, path: 'mock.txt' }),
  ).rejects.toMatchObject({ code: 'EXECUTION_WORKSPACE_SCOPE' });
  await client.call('projects.sync', {
    ...alpha,
    project: { ...alpha.project, revision: 2, grants: [] },
  });
  await expect(
    client.call('projects.bind', { bot: 'mock-reader', scope: project.scope }),
  ).rejects.toMatchObject({ code: 'PROJECT_SCOPE_STALE' });
  await expect(
    client.call('workspace.write', {
      handleId: directory.handleId,
      name: 'late.txt',
      data: Buffer.from('NEVER').toString('base64'),
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_SCOPE_STALE' });
  await client.call('workspace.close', { handleId: directory.handleId });
});

test('read members can stage private task outputs while only write members publish shared content', async (t) => {
  const { client } = await fixture(t);
  const resources: ProjectResources = {
    project: {
      id: 'mock-project',
      name: 'SYNTHETIC',
      revision: 1,
      status: 'active',
      grants: [
        { bot: 'mock-reader', content: 'read', browser: false },
        { bot: 'mock-writer', content: 'write', browser: false },
      ],
      environment: { files: 'project', browser: 'private' },
    },
    files: 'mock-files',
    sharedProfile: 'mock-shared-profile',
    profiles: { 'mock-reader': 'mock-reader-profile', 'mock-writer': 'mock-writer-profile' },
  };
  await client.call('projects.sync', resources as unknown as Record<string, unknown>);
  for (const bot of ['mock-reader', 'mock-writer']) {
    const project = {
      scope: { projectId: 'mock-project', revision: 1 },
      resourceId: resources.files,
      bot,
      runId: `mock-run-${bot}`,
    };
    const directory = await client.call<{ path: string; canonical: string }>('workspace.create', {
      project,
      parts: ['model-runs', project.runId, bot],
    });
    await client.call('tools.open', {
      id: project.runId,
      bot,
      project: project.scope,
      workdir: directory.path,
      canonicalRoot: directory.canonical,
      limit: 20,
    });
    await client.call('tools.write', {
      runId: project.runId,
      path: 'private.txt',
      content: 'SYNTHETIC PRIVATE',
      createOnly: true,
    });
    const publish = client.call('tools.write', {
      runId: project.runId,
      path: '/shared/result.txt',
      content: 'SYNTHETIC PUBLISHED',
      createOnly: true,
    });
    if (bot === 'mock-reader')
      await expect(publish).rejects.toMatchObject({ code: 'PROJECT_ACCESS_DENIED' });
    else await publish;
  }
  const project = {
    scope: { projectId: 'mock-project', revision: 1 },
    resourceId: resources.files,
  };
  expect(await client.call('workspace.read', { project, path: 'result.txt' })).toMatchObject({
    content: 'SYNTHETIC PUBLISHED',
  });
  expect((await client.call<unknown[]>('workspace.list', { project })).length).toBe(1);
});

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

test.skipIf(process.platform !== 'linux')(
  'executor captures only owned workspace scope under its boot and nonce fence',
  async (t) => {
    const { client, service, token } = await fixture(t);
    expect(client.snapshot?.capabilities).toContain(workspaceReviewCapability);
    const directory = await client.call<{ path: string; canonical: string; handleId: string }>(
      'workspace.create',
      { parts: ['mock-review-run', 'mock-bot'] },
    );
    await client.call('workspace.write', {
      handleId: directory.handleId,
      name: 'input.txt',
      data: Buffer.from('synthetic').toString('base64'),
    });
    const result = await client.call('workspace.review.capture', {
      root: directory.canonical,
      canonical: directory.canonical,
    });
    expect(isReviewCapture(result)).toBe(true);
    expect(result).toMatchObject({ files: [{ path: 'input.txt', state: 'present' }] });
    await expect(client.call('workspace.review.capture', { root: '/tmp' })).rejects.toMatchObject({
      code: 'EXECUTION_WORKSPACE_SCOPE',
    });
    const response = await fetch(`${service.origin}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-daban-execution-token': token },
      body: JSON.stringify({
        role: 'executor',
        version: 1,
        id: 'mock-old-review',
        boot: client.snapshot?.boot,
        nonce: 'mock-old-nonce',
        method: 'workspace.review.capture',
        params: {},
      }),
    });
    expect(await response.json()).toMatchObject({ ok: false, error: 'EXECUTION_GUEST_RESTARTED' });
    await client.call('workspace.close', { handleId: directory.handleId });
  },
);

test('capture transport failures are fresh read failures and oversized envelopes are rejected', async () => {
  const snapshot = {
    role: 'executor',
    version: 1,
    boot: 'mock-boot',
    nonce: 'mock-nonce',
    capabilities: [
      'workspace',
      'tools',
      'computer',
      'processes',
      'documents',
      workspaceReviewCapability,
    ],
    computer: {
      mode: 'agent',
      sharedLogin: false,
      viewport: { width: 1280, height: 800 },
      environment: { platform: 'linux', arch: 'arm64', kernel: 'mock', node: 'mock', browser: '' },
      events: [],
      bots: {},
    },
    status: { available: true, revision: 0, limit: 2, items: [] },
  };
  for (const failure of ['disconnected', 'oversized']) {
    let captures = 0;
    const client = new RemoteExecutor({
      url: 'http://127.0.0.1:12345/exec',
      token: 'synthetic-token',
      fetcher: async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        if (request.method === 'workspace.review.capture') {
          captures++;
          if (failure === 'disconnected') throw new Error('SYNTHETIC DISCONNECTION');
          return Response.json({
            role: 'executor',
            version: 1,
            id: request.id,
            boot: 'mock-boot',
            ok: true,
            value: 'x'.repeat(8 * 1024 * 1024),
          });
        }
        return Response.json({
          role: 'executor',
          version: 1,
          id: request.id,
          boot: 'mock-boot',
          ok: true,
          value: snapshot,
        });
      },
    });
    await client.ready;
    await expect(client.call('workspace.review.capture', {})).rejects.toMatchObject({
      code: failure === 'disconnected' ? 'EXECUTION_UNAVAILABLE' : 'EXECUTION_INVALID_RESPONSE',
    });
    expect(captures).toBe(1);
  }
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
