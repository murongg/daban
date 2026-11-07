import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isExecutionParams } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { type AgentToolRun, AgentTools, agentToolList } from './agent-tools.js';
import { Commands } from './commands.js';
import type { ComputerFacade, ToolResult } from './computer-tools.js';
import { Control } from './control.js';
import { Interactions } from './interactions.js';
import { NativeWorkspace } from './native-workspace.js';
import { WorkspaceFiles } from './workspace.js';

test('host negotiates model capabilities before sending new execution fields to older Linux guests', async () => {
  const calls: Record<string, unknown>[] = [];
  const execution = {
    snapshot: { capabilities: [] as string[] },
    async call(_method: string, params: Record<string, unknown>) {
      calls.push(params);
      return { tools: [] };
    },
  };
  const tools = new AgentTools(undefined, new WorkspaceFiles('/mock-unused'), { execution });
  const run: AgentToolRun = {
    id: 'mock-legacy-run',
    bot: 'mock-bot',
    abort: new AbortController(),
    model: 'deepseek-flash',
    vision: true,
    workdir: '/mock/task',
    canonicalRoot: '/mock/task',
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
  };
  await tools.open(run);
  expect('vision' in calls[0], 'legacy exact validators must receive only known fields').toBe(
    false,
  );
  expect(calls[0].model).toBe('deepseek-flash');
  const custom = { ...run, id: 'mock-custom-run', model: 'provider:mock-provider:mock-chat' };
  await expect(tools.open(custom)).rejects.toMatchObject({ code: 'EXECUTION_UPGRADE_REQUIRED' });
  expect(calls.length).toBe(1);
  execution.snapshot.capabilities.push('model-capabilities-v1');
  await tools.open(custom);
  expect(calls[1].vision).toBe(true);
});

test('host sends only the authorized task prompt to guests advertising browser task support', async () => {
  const calls: Record<string, unknown>[] = [];
  const execution = {
    snapshot: { capabilities: ['browser-task-v1'] },
    call: async (_method: string, params: Record<string, unknown>) => {
      calls.push(params);
      return { tools: [] };
    },
  };
  const tools = new AgentTools(undefined, new WorkspaceFiles('/mock-unused'), { execution });
  const run: AgentToolRun = {
    id: 'mock-browser-task',
    bot: 'mock-a',
    workdir: '/mock/task',
    canonicalRoot: '/mock/task',
    abort: new AbortController(),
    limit: 10,
    toolCount: 0,
    seen: {},
    trace: [],
    task: {
      requestId: 'mock-request',
      prompt: 'Operate the synthetic form',
      memory: 'SYNTHETIC PRIVATE MEMORY',
    },
  };
  await tools.open(run);
  expect(calls[0].prompt).toBe('Operate the synthetic form');
  expect(JSON.stringify(calls[0])).not.toContain('SYNTHETIC PRIVATE MEMORY');
});

test('model RPC identities retain Host deduplication and become stable bounded Guest wire IDs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-remote-wire-'));
  const hostIds: (string | undefined)[] = [];
  const guestIds: unknown[] = [];
  let reviews = 0;
  const commands = new Commands({
    file: path.join(root, 'commands.sqlite'),
    interactions: new Interactions(path.join(root, 'interactions')),
    review: async () => {
      reviews++;
      return 'allow';
    },
  });
  const tools = new AgentTools(undefined, new WorkspaceFiles('/mock-unused-host'), {
    execution: {
      async call(method, params) {
        expect(isExecutionParams(method as Parameters<typeof isExecutionParams>[0], params)).toBe(
          true,
        );
        if (method === 'tools.open')
          return { tools: [{ name: 'shell', description: 'Mock VM command', inputSchema: {} }] };
        if (method === 'tools.invoke') {
          guestIds.push(params.wireId);
          return {
            phase: 'settled',
            result: { content: [{ type: 'text', text: 'MOCK GUEST RESULT' }] },
          };
        }
        return { ok: true };
      },
    },
  });
  tools.executeRemote = (run, name, args, wireId, dispatch) => {
    hostIds.push(wireId);
    return commands.invoke(run, name, args, wireId, dispatch);
  };
  const run: AgentToolRun = {
    id: 'mock-wire-run',
    bot: 'mock-bot',
    sessionId: 'mock-host-session',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: '/mock-guest/task',
    canonicalRoot: '/mock-guest/task',
    task: { requestId: 'mock-wire-request', prompt: 'Run the synthetic inspection command.' },
  };
  const numberId = JSON.stringify(['number', 1]);
  const stringId = JSON.stringify(['string', '1']);
  try {
    for (const wireId of [numberId, stringId, numberId]) {
      const result = await tools.invoke(run, 'shell', { command: 'echo mock' }, wireId);
      expect(result.isError).toBe(undefined);
    }
    expect(hostIds).toStrictEqual([numberId, stringId, numberId]);
    expect(guestIds).toStrictEqual(
      [numberId, stringId].map((value) => createHash('sha256').update(value).digest('hex')),
    );
    expect(guestIds[0]).not.toBe(guestIds[1]);
    expect(reviews).toBe(2);
    await tools.drain(run);
  } finally {
    await commands.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('remote tools send only execution context and preserve host budgets and wait state', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let polls = 0;
  const execution = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === 'tools.open')
        return { tools: [{ name: 'shell', description: 'Mock VM shell', inputSchema: {} }] };
      if (method === 'tools.invoke') return { phase: 'running', waitingForComputer: true };
      if (method === 'tools.poll') {
        polls++;
        return {
          phase: 'settled',
          waitingForComputer: false,
          result: { content: [{ type: 'text', text: 'mock guest output' }] },
        };
      }
      return { ok: true };
    },
  };
  const tools = new AgentTools(undefined, new WorkspaceFiles('/mock-never-use-host'), {
    execution,
  });
  tools.executeRemote = (_run, _name, _args, _wireId, dispatch) => dispatch();
  const waits: boolean[] = [];
  const run = {
    id: 'mock-remote-run',
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 1,
    seen: {},
    trace: [],
    workdir: '/mock-guest/task',
    canonicalRoot: '/mock-guest/task',
    privateDir: '/mock-host/private',
    token: 'synthetic-private-capability',
    onComputerWait() {
      waits.push(!!run.waitingForComputer);
    },
    waitingForComputer: false,
  };
  await tools.open(run);
  const result = await tools.invoke(run, 'shell', { command: 'mock command' });
  expect(result.content[0].type).toBe('text');
  expect(polls).toBe(1);
  expect(waits).toStrictEqual([true, false]);
  expect(calls[0].params).toStrictEqual({
    id: run.id,
    bot: run.bot,
    workdir: run.workdir,
    canonicalRoot: run.canonicalRoot,
    limit: 1,
  });
  expect.assert(!JSON.stringify(calls).includes(run.token));
  expect.assert(!JSON.stringify(calls).includes(run.privateDir));
  expect((await tools.invoke(run, 'shell', { command: 'too many' })).isError).toBe(true);
  expect(calls.filter((call) => call.method === 'tools.invoke').length).toBe(1);
  await tools.drain(run);
  expect(calls.at(-1)?.method).toBe('tools.drain');
});

test('raw remote execution requires a host gate and rechecks refused network authority before dispatch', async () => {
  const calls: string[] = [];
  const tools = new AgentTools(undefined, new WorkspaceFiles('/mock-host-unused'), {
    execution: {
      async call(method) {
        calls.push(method);
        if (method === 'tools.open') return { tools: [] };
        return { phase: 'settled', result: { content: [{ type: 'text', text: 'mock' }] } };
      },
    },
  });
  const run = {
    id: 'mock-gated-run',
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: '/mock-guest/task',
    canonicalRoot: '/mock-guest/task',
  };
  expect((await tools.invoke(run, 'shell', { command: 'mock command' })).isError).toBe(true);
  expect(calls.filter((method) => method === 'tools.invoke').length).toBe(0);
  let denied = false;
  tools.authorizeComputer = async () => {
    if (denied) throw new Error('MOCK_REFUSED_WEB');
  };
  tools.executeRemote = async (_run, _name, _args, _wireId, dispatch) => {
    denied = true;
    return dispatch();
  };
  expect((await tools.invoke(run, 'process_start', { command: 'mock server' })).isError).toBe(true);
  expect(calls.filter((method) => method === 'tools.invoke').length).toBe(0);
});

test('remote dispatch failures and rejected host computer authority never use local execution', async () => {
  const calls: string[] = [];
  const tools = new AgentTools(undefined, new WorkspaceFiles('/mock-private-host-directory'), {
    execution: {
      async call(method) {
        calls.push(method);
        if (method === 'tools.open')
          return { tools: [{ name: 'screenshot', description: 'mock', inputSchema: {} }] };
        throw new Error('MOCK_OFFLINE');
      },
    },
  });
  const run = {
    id: 'mock-offline-run',
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: '/mock-guest/task',
    canonicalRoot: '/mock-guest/task',
  };
  await tools.open(run);
  tools.authorizeComputer = async () => {
    throw new Error('MOCK_HOST_AUTHORITY_REJECTED');
  };
  expect((await tools.invoke(run, 'screenshot', { surface: 'desktop' })).isError).toBe(true);
  expect(calls.filter((method) => method === 'tools.invoke').length).toBe(0);
  const result = await tools.invoke(run, 'read_file', {
    path: '/mock-private-host-directory/secret',
  });
  expect(result).toStrictEqual({
    isError: true,
    content: [{ type: 'text', text: 'EXECUTOR_TOOL_FAILED' }],
  });
  expect(calls.filter((method) => method === 'tools.invoke').length).toBe(1);
});

test('remote text exports use guest create-only writes and cancellation retires the guest run', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const tools = new AgentTools(undefined, new WorkspaceFiles('/mock-host-unused'), {
    execution: {
      async call(method, params) {
        calls.push({ method, params });
        return method === 'tools.open'
          ? { tools: [] }
          : { path: '/mock-guest/task/mock.txt', bytes: 4 };
      },
    },
  });
  const run = {
    id: 'mock-export-run',
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: '/mock-guest/task',
    canonicalRoot: '/mock-guest/task',
  };
  await tools.writeText(run, 'mock.txt', 'mock', true);
  expect(calls[1]).toStrictEqual({
    method: 'tools.write',
    params: { runId: run.id, path: 'mock.txt', content: 'mock', createOnly: true },
  });
  expect(run.toolCount).toBe(0);
  run.abort.abort();
  await tools.cancel(run);
  expect(calls.at(-1)).toStrictEqual({ method: 'tools.cancel', params: { runId: run.id } });
});

function payload(result: ToolResult) {
  expect.assert(!result.isError, JSON.stringify(result));
  const part = result.content[0];
  expect(part.type).toBe('text');
  return JSON.parse(part.type === 'text' ? part.text : '') as Record<string, unknown>;
}
test('registration of a lease alone does not advertise a detached computer capability', () => {
  const forbidden = async (): Promise<never> => {
    throw new Error('detached computer must stay unused');
  };
  const facade = Object.assign(
    {
      control: new Control(['mock-detached']),
      frame: forbidden,
      screens: { input: forbidden, openApp: forbidden },
      browser: { frame: forbidden, input: forbidden },
    },
    { available: () => false },
  );
  const tools = new AgentTools(facade, new WorkspaceFiles('/synthetic/no-io'));
  expect(tools.hasComputer('mock-detached', 'deepseek-flash')).toBe(false);
  expect.assert(
    !tools.list('mock-detached', 'deepseek-flash').some((tool) => tool.name === 'screenshot'),
  );
});
test('a text-only model cannot use computer tools even when its Bot has a screen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-computer-'));
  try {
    let observed = 0;
    const frame = async () => {
      observed++;
      return Buffer.from('synthetic');
    };
    const tools = new AgentTools(
      {
        control: new Control(['a']),
        frame,
        screens: { input: frame, openApp: frame },
        browser: { frame, input: frame },
      },
      new WorkspaceFiles(root),
    );
    const run = {
      bot: 'a',
      model: 'deepseek-v4-pro' as const,
      abort: new AbortController(),
      toolCount: 0,
      limit: 10,
      seen: {},
      trace: [],
      workdir: root,
      canonicalRoot: await realpath(root),
    };
    const result = await tools.invoke(run, 'screenshot', { surface: 'desktop' });
    expect(result.isError).toBe(true);
    expect.assert(JSON.stringify(result).includes('MODEL_COMPUTER_UNSUPPORTED'));
    expect(observed).toBe(0);
    payload(await tools.invoke(run, 'list_files', {}));
    expect(tools.list('a', 'deepseek-v4-pro').some((tool) => tool.name === 'screenshot')).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('workspace tools work without a screen, enforce paths and preserve unrelated files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-agent-tools-'));
  try {
    const shared = path.join(root, 'shared'),
      workdir = path.join(shared, 'current');
    await mkdir(workdir, { recursive: true });
    await writeFile(path.join(root, 'private.txt'), 'synthetic-private');
    const forbidden = async (): Promise<never> => {
      throw new Error('desktop must remain unused');
    };
    const control = new Control(['a', 'b']);
    await control.transfer('a', 0, 'human');
    const computer: ComputerFacade = {
      control,
      frame: forbidden,
      screens: { input: forbidden, openApp: forbidden },
      browser: { frame: forbidden, input: forbidden },
    };
    const tools = new AgentTools(computer, new WorkspaceFiles(shared));
    const run: AgentToolRun = {
      bot: 'a',
      abort: new AbortController(),
      toolCount: 0,
      limit: 30,
      seen: {},
      trace: [],
      workdir,
      canonicalRoot: await realpath(workdir),
    };
    expect.assert(
      ['read_file', 'write_file', 'list_files', 'shell', 'screenshot', 'act', 'open_app'].every(
        (name) => agentToolList.some((tool) => tool.name === name),
      ),
    );
    payload(
      await tools.invoke(run, 'write_file', { path: 'summary.md', content: '# 合成结果\n数量=3' }),
    );
    const read = payload(await tools.invoke(run, 'read_file', { path: 'summary.md', limit: 5 }));
    expect(read.content).toBe('# 合成结');
    expect(read.nextOffset).toBe(5);
    expect.assert(
      JSON.stringify(payload(await tools.invoke(run, 'list_files', {}))).includes('summary.md'),
    );
    expect((await tools.invoke(run, 'list_files', { path: false })).isError).toBe(true);
    await writeFile(path.join(shared, 'previous.md'), 'synthetic previous report');
    expect(
      payload(await tools.invoke(run, 'read_file', { path: '/shared/previous.md' })).content,
    ).toBe('synthetic previous report');
    expect.assert(
      JSON.stringify(payload(await tools.invoke(run, 'list_files', { path: '/shared' }))).includes(
        'previous.md',
      ),
    );
    payload(
      await tools.invoke(run, 'write_file', {
        path: '/workspace/alias.md',
        content: '合成当前输出',
      }),
    );
    expect(await readFile(path.join(workdir, 'alias.md'), 'utf8')).toBe('合成当前输出');
    expect(
      (await tools.invoke(run, 'write_file', { path: '/shared/previous.md', content: 'changed' }))
        .isError,
    ).toBe(true);
    expect(
      payload(
        await tools.invoke(run, 'read_file', {
          path: path.join(shared, 'previous.md').split(path.sep).join('/'),
        }),
      ).content,
    ).toBe('synthetic previous report');
    for (const args of [
      { path: '../private.txt' },
      { path: path.join(root, 'private.txt') },
      { path: 'summary.md', extra: true },
    ])
      expect((await tools.invoke(run, 'read_file', args)).isError).toBe(true);
    await symlink(path.join(root, 'private.txt'), path.join(workdir, 'escape'));
    await link(path.join(root, 'private.txt'), path.join(workdir, 'hardlink'));
    for (const file of ['escape', 'hardlink']) {
      expect((await tools.invoke(run, 'read_file', { path: file })).isError).toBe(true);
      expect(
        (await tools.invoke(run, 'write_file', { path: file, content: 'changed' })).isError,
      ).toBe(true);
    }
    expect(
      (
        await tools.invoke(run, 'write_file', {
          path: path.join(shared, 'previous.md'),
          content: 'changed',
        })
      ).isError,
    ).toBe(true);
    expect(await readFile(path.join(root, 'private.txt'), 'utf8')).toBe('synthetic-private');
    expect(await readFile(path.join(shared, 'previous.md'), 'utf8')).toBe(
      'synthetic previous report',
    );
    expect.assert(run.trace.every((item) => item.surface === 'workspace'));
    expect(control.state('a').owner).toBe('human');
    run.abort.abort();
    expect(
      (await tools.invoke(run, 'write_file', { path: 'stopped.md', content: 'no' })).isError,
    ).toBe(true);
    await expect(readFile(path.join(workdir, 'stopped.md'))).rejects.toThrowError();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace tools share the model tool budget and fail closed without a Linux shell sandbox', async () => {
  const control = new Control(['a']);
  const forbidden = async (): Promise<never> => {
    throw new Error('unused');
  };
  const computer: ComputerFacade = {
    control,
    frame: forbidden,
    screens: { input: forbidden, openApp: forbidden },
    browser: { frame: forbidden, input: forbidden },
  };
  const tools = new AgentTools(computer, new WorkspaceFiles('/synthetic'));
  const run: AgentToolRun = {
    bot: 'a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 0,
    seen: {},
    trace: [],
    workdir: '/synthetic',
    canonicalRoot: '/synthetic',
  };
  expect((await tools.invoke(run, 'list_files', {})).isError).toBe(true);
  expect(run.trace.at(-1)?.code).toBe('TOOL_LIMIT');
  if (process.platform !== 'linux') {
    run.limit = 3;
    const result = await tools.invoke(run, 'shell', { command: 'printf forbidden' });
    expect(result.isError).toBe(true);
    expect.assert(JSON.stringify(result).includes('SHELL_SANDBOX_UNAVAILABLE'));
  }
});
test('draining a run waits for its in-flight tool before lifecycle cleanup', async () => {
  let finish!: (value: Buffer) => unknown;
  const frame = new Promise<Buffer>((resolve) => {
    finish = resolve;
  });
  const control = new Control(['a']);
  const computer: ComputerFacade = {
    control,
    frame: async () => frame,
    screens: { input: async () => {}, openApp: async () => {} },
    browser: { frame: async () => frame, input: async () => {} },
  };
  const tools = new AgentTools(computer, new WorkspaceFiles('/synthetic'));
  const run: AgentToolRun = {
    bot: 'a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 3,
    seen: {},
    trace: [],
    workdir: '/synthetic',
    canonicalRoot: '/synthetic',
  };
  const pending = tools.invoke(run, 'screenshot', { surface: 'desktop' });
  let settled = false;
  const drained = tools.drain(run).then(() => {
    settled = true;
  });
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  finish(Buffer.from('synthetic-frame'));
  await pending;
  await drained;
  expect(settled).toBe(true);
});

test('draining also retires a remote lease whose open completes during an active call', async () => {
  let entered: () => unknown = () => undefined;
  let release: () => unknown = () => undefined;
  const ready = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const calls: string[] = [];
  const tools = new AgentTools(undefined, new WorkspaceFiles('/mock-unused'), {
    execution: {
      call: async (method: string) => {
        calls.push(method);
        if (method === 'tools.open') {
          entered();
          await gate;
          return { tools: [] };
        }
        return { phase: 'settled', result: { content: [] } };
      },
    },
  });
  const run: AgentToolRun = {
    id: 'mock-late-lease',
    bot: 'mock-bot',
    abort: new AbortController(),
    workdir: '/mock/task',
    canonicalRoot: '/mock/task',
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
  };
  const pending = tools.invoke(run, 'write_file', { path: 'result.txt', content: 'SYNTHETIC' });
  await ready;
  const drained = tools.drain(run);
  release();
  await pending;
  await drained;
  expect(calls).toEqual(['tools.open', 'tools.invoke', 'tools.drain']);
});

test('a parent replaced after validation cannot make a tool create even an empty file in a private directory', async (t) => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-write-parent-race-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const shared = path.join(root, 'shared'),
    workdir = path.join(shared, 'task'),
    parent = path.join(workdir, 'nested'),
    privateRoot = path.join(root, 'private');
  await mkdir(parent, { recursive: true });
  await mkdir(privateRoot);
  const canonicalRoot = await realpath(workdir);
  const target = await realpath(parent);
  const workspace = new WorkspaceFiles(shared);
  await workspace.base();
  const tools = new AgentTools(undefined, workspace);
  const run: AgentToolRun = {
    bot: 'mock-a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 8,
    seen: {},
    trace: [],
    workdir,
    canonicalRoot,
  };
  const original = fs.realpath;
  let redirected = false;
  vi.spyOn(fs, 'realpath').mockImplementation(async (file: Parameters<typeof original>[0]) => {
    const result = await original(file);
    if (file === target && !redirected) {
      redirected = true;
      await fs.rename(parent, path.join(workdir, 'retained'));
      await fs.symlink(privateRoot, parent);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  await expect(tools.writeText(run, 'nested/new.txt', 'SYNTHETIC-ATTACK')).rejects.toThrowError();
  expect(redirected).toBe(true);
  await expect(fs.access(path.join(privateRoot, 'new.txt'))).rejects.toThrowError();
});

test('task writes never create a dangling link target when the filesystem has no no-follow flag', async (t) => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-native-write-link-'));
  const workspace = new NativeWorkspace(path.join(root, 'workspace'));
  await workspace.prepare();
  const task = await workspace.create(['mock-run']);
  await task.close();
  await mkdir(path.join(root, 'private'));
  const outside = path.join(root, 'private', 'must-not-exist.txt');
  await symlink(outside, path.join(task.path, 'link.txt'));
  const original = fs.open;
  vi.spyOn(fs, 'open').mockImplementation((file, flags, mode) =>
    original(file, typeof flags === 'number' ? flags & ~constants.O_NOFOLLOW : flags, mode),
  );
  syncBuiltinESMExports();
  t.onTestFinished(async () => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const tools = new AgentTools(undefined, workspace);
  const run: AgentToolRun = {
    id: 'mock-native-write-link',
    bot: 'mock-a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 8,
    seen: {},
    trace: [],
    workdir: task.path,
    canonicalRoot: task.canonical,
  };
  await expect(
    tools.writeText(run, 'link.txt', 'SYNTHETIC MUST NOT ESCAPE'),
  ).rejects.toThrowError();
  await expect(fs.access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  await tools.writeText(run, 'result.txt', 'SYNTHETIC FIRST');
  await symlink(path.join(task.path, 'result.txt'), path.join(task.path, 'inside-link.txt'));
  await expect(
    tools.writeText(run, 'inside-link.txt', 'SYNTHETIC ALIAS WRITE'),
  ).rejects.toThrowError();
  expect(await readFile(path.join(task.path, 'result.txt'), 'utf8')).toBe('SYNTHETIC FIRST');
  await tools.writeText(run, 'result.txt', 'SYNTHETIC SECOND');
  expect(await readFile(path.join(task.path, 'result.txt'), 'utf8')).toBe('SYNTHETIC SECOND');
});

test('an explicitly selected host computer is pinned to the run and never falls back to VM inputs', async () => {
  let selected = true;
  let hostCalls = 0;
  const remoteCalls: string[] = [];
  const tools = Object.assign(
    new AgentTools(undefined, new WorkspaceFiles('/mock-guest'), {
      execution: {
        async call(method) {
          remoteCalls.push(method);
          if (method === 'tools.open')
            return { tools: [{ name: 'screenshot', description: 'Mock VM', inputSchema: {} }] };
          return {
            phase: 'settled',
            result: { content: [{ type: 'text', text: 'MOCK VM SCREEN' }] },
          };
        },
      },
    }),
    {
      localComputer: {
        list: [{ name: 'screenshot', description: 'Mock host computer', inputSchema: {} }],
        selected: () => selected,
        prepare: async () => selected,
        cancel: async () => {},
        async invoke(run: AgentToolRun): Promise<ToolResult> {
          hostCalls++;
          run.toolCount++;
          return { content: [{ type: 'text', text: 'MOCK HOST SCREEN' }] };
        },
      },
    },
  );
  const run: AgentToolRun = {
    id: 'mock-native-run',
    bot: 'mock-bot',
    abort: new AbortController(),
    vision: true,
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: '/mock-guest/task',
    canonicalRoot: '/mock-guest/task',
  };
  await tools.open(run);
  selected = false;
  const result = await tools.invoke(run, 'screenshot', { surface: 'desktop' }, 'mock-wire-1');
  expect(result.content).toStrictEqual([{ type: 'text', text: 'MOCK HOST SCREEN' }]);
  const repeated = await tools.invoke(
    run,
    'act',
    { surface: 'desktop', actions: [{ type: 'text', text: 'SYNTHETIC INPUT' }] },
    'mock-wire-1',
  );
  expect(repeated.isError).toBe(true);
  expect(hostCalls).toBe(1);
  expect(remoteCalls.includes('tools.invoke')).toBe(false);
  tools.localComputer.invoke = async () => {
    throw new Error('MOCK_HOST_DISCONNECTED');
  };
  await expect(tools.invoke(run, 'screenshot', { surface: 'desktop' })).rejects.toThrowError(
    /MOCK_HOST_DISCONNECTED/,
  );
  expect(remoteCalls.includes('tools.invoke')).toBe(false);
});

test('unavailable native-only tools still consume the run budget and report its limit', async () => {
  const tools = new AgentTools(undefined, new WorkspaceFiles('/synthetic'), { nativeOnly: true });
  const run: AgentToolRun = {
    id: 'mock-native-budget',
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 1,
    seen: {},
    trace: [],
    workdir: '/synthetic',
    canonicalRoot: '/synthetic',
  };
  const first = await tools.invoke(run, 'shell', { command: 'synthetic' });
  expect(JSON.stringify(first)).toMatch(/NATIVE_WORKSPACE_TOOL_UNAVAILABLE/);
  expect(run.toolCount).toBe(1);
  const second = await tools.invoke(run, 'read_file', { path: 'synthetic.txt' });
  expect(JSON.stringify(second)).toMatch(/TOOL_LIMIT/);
});

test('durability waits pin the task identity and the exact tool arguments before dispatch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-tool-fence-owner-'));
  const canonicalRoot = await realpath(root);
  const tools = new AgentTools(undefined, new WorkspaceFiles(root));
  let release: () => unknown = () => undefined;
  let gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const run: AgentToolRun = {
    id: 'mock-run',
    bot: 'mock-bot',
    abort: new AbortController(),
    workdir: root,
    canonicalRoot,
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    beforeTool: async () => gate,
  };
  try {
    const args = { path: 'mock.txt', content: 'Synthetic accepted content' };
    const first = tools.invoke(run, 'write_file', args);
    args.content = 'Synthetic later mutation';
    release();
    const firstResult = await first;
    expect(firstResult.isError, JSON.stringify(firstResult)).not.toBe(true);
    expect(await readFile(path.join(root, 'mock.txt'), 'utf8')).toBe('Synthetic accepted content');
    gate = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    const second = tools.invoke(run, 'write_file', {
      path: 'other.txt',
      content: 'Synthetic forbidden write',
    });
    run.bot = 'mock-other-bot';
    release();
    await expect(second).rejects.toMatchObject({ code: 'TOOL_CONTEXT_CHANGED' });
    await expect(readFile(path.join(root, 'other.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release();
    await tools.drain(run);
    await rm(root, { recursive: true, force: true });
  }
});
