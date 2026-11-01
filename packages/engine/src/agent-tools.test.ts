import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isExecutionParams } from '@daban/protocol';
import { type AgentToolRun, AgentTools, agentToolList } from './agent-tools.js';
import { Commands } from './commands.js';
import type { ComputerFacade, ToolResult } from './computer-tools.js';
import { Control } from './control.js';
import { Interactions } from './interactions.js';
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
  assert.equal(
    'vision' in calls[0],
    false,
    'legacy exact validators must receive only known fields',
  );
  assert.equal(calls[0].model, 'deepseek-flash');
  const custom = { ...run, id: 'mock-custom-run', model: 'provider:mock-provider:mock-chat' };
  await assert.rejects(tools.open(custom), { code: 'EXECUTION_UPGRADE_REQUIRED' });
  assert.equal(calls.length, 1);
  execution.snapshot.capabilities.push('model-capabilities-v1');
  await tools.open(custom);
  assert.equal(calls[1].vision, true);
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
        assert.equal(
          isExecutionParams(method as Parameters<typeof isExecutionParams>[0], params),
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
      assert.equal(result.isError, undefined);
    }
    assert.deepEqual(hostIds, [numberId, stringId, numberId]);
    assert.deepEqual(
      guestIds,
      [numberId, stringId].map((value) => createHash('sha256').update(value).digest('hex')),
    );
    assert.notEqual(guestIds[0], guestIds[1]);
    assert.equal(reviews, 2);
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
  assert.equal(result.content[0].type, 'text');
  assert.equal(polls, 1);
  assert.deepEqual(waits, [true, false]);
  assert.deepEqual(calls[0].params, {
    id: run.id,
    bot: run.bot,
    workdir: run.workdir,
    canonicalRoot: run.canonicalRoot,
    limit: 1,
  });
  assert.ok(!JSON.stringify(calls).includes(run.token));
  assert.ok(!JSON.stringify(calls).includes(run.privateDir));
  assert.equal((await tools.invoke(run, 'shell', { command: 'too many' })).isError, true);
  assert.equal(calls.filter((call) => call.method === 'tools.invoke').length, 1);
  await tools.drain(run);
  assert.equal(calls.at(-1)?.method, 'tools.drain');
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
  assert.equal((await tools.invoke(run, 'shell', { command: 'mock command' })).isError, true);
  assert.equal(calls.filter((method) => method === 'tools.invoke').length, 0);
  let denied = false;
  tools.authorizeComputer = async () => {
    if (denied) throw new Error('MOCK_REFUSED_WEB');
  };
  tools.executeRemote = async (_run, _name, _args, _wireId, dispatch) => {
    denied = true;
    return dispatch();
  };
  assert.equal(
    (await tools.invoke(run, 'process_start', { command: 'mock server' })).isError,
    true,
  );
  assert.equal(calls.filter((method) => method === 'tools.invoke').length, 0);
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
  assert.equal((await tools.invoke(run, 'screenshot', { surface: 'desktop' })).isError, true);
  assert.equal(calls.filter((method) => method === 'tools.invoke').length, 0);
  const result = await tools.invoke(run, 'read_file', {
    path: '/mock-private-host-directory/secret',
  });
  assert.deepEqual(result, {
    isError: true,
    content: [{ type: 'text', text: 'EXECUTOR_TOOL_FAILED' }],
  });
  assert.equal(calls.filter((method) => method === 'tools.invoke').length, 1);
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
  assert.deepEqual(calls[1], {
    method: 'tools.write',
    params: { runId: run.id, path: 'mock.txt', content: 'mock', createOnly: true },
  });
  assert.equal(run.toolCount, 0);
  run.abort.abort();
  await tools.cancel(run);
  assert.deepEqual(calls.at(-1), { method: 'tools.cancel', params: { runId: run.id } });
});

function payload(result: ToolResult) {
  assert.ok(!result.isError, JSON.stringify(result));
  const part = result.content[0];
  assert.equal(part.type, 'text');
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
  assert.equal(tools.hasComputer('mock-detached', 'deepseek-flash'), false);
  assert.ok(
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
    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result).includes('MODEL_COMPUTER_UNSUPPORTED'));
    assert.equal(observed, 0);
    payload(await tools.invoke(run, 'list_files', {}));
    assert.equal(
      tools.list('a', 'deepseek-v4-pro').some((tool) => tool.name === 'screenshot'),
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
    assert.ok(
      ['read_file', 'write_file', 'list_files', 'shell', 'screenshot', 'act', 'open_app'].every(
        (name) => agentToolList.some((tool) => tool.name === name),
      ),
    );
    payload(
      await tools.invoke(run, 'write_file', { path: 'summary.md', content: '# 合成结果\n数量=3' }),
    );
    const read = payload(await tools.invoke(run, 'read_file', { path: 'summary.md', limit: 5 }));
    assert.equal(read.content, '# 合成结');
    assert.equal(read.nextOffset, 5);
    assert.ok(
      JSON.stringify(payload(await tools.invoke(run, 'list_files', {}))).includes('summary.md'),
    );
    assert.equal((await tools.invoke(run, 'list_files', { path: false })).isError, true);
    await writeFile(path.join(shared, 'previous.md'), 'synthetic previous report');
    assert.equal(
      payload(await tools.invoke(run, 'read_file', { path: '/shared/previous.md' })).content,
      'synthetic previous report',
    );
    assert.ok(
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
    assert.equal(await readFile(path.join(workdir, 'alias.md'), 'utf8'), '合成当前输出');
    assert.equal(
      (await tools.invoke(run, 'write_file', { path: '/shared/previous.md', content: 'changed' }))
        .isError,
      true,
    );
    assert.equal(
      payload(await tools.invoke(run, 'read_file', { path: path.join(shared, 'previous.md') }))
        .content,
      'synthetic previous report',
    );
    for (const args of [
      { path: '../private.txt' },
      { path: path.join(root, 'private.txt') },
      { path: 'summary.md', extra: true },
    ])
      assert.equal((await tools.invoke(run, 'read_file', args)).isError, true);
    await symlink(path.join(root, 'private.txt'), path.join(workdir, 'escape'));
    await link(path.join(root, 'private.txt'), path.join(workdir, 'hardlink'));
    for (const file of ['escape', 'hardlink']) {
      assert.equal((await tools.invoke(run, 'read_file', { path: file })).isError, true);
      assert.equal(
        (await tools.invoke(run, 'write_file', { path: file, content: 'changed' })).isError,
        true,
      );
    }
    assert.equal(
      (
        await tools.invoke(run, 'write_file', {
          path: path.join(shared, 'previous.md'),
          content: 'changed',
        })
      ).isError,
      true,
    );
    assert.equal(await readFile(path.join(root, 'private.txt'), 'utf8'), 'synthetic-private');
    assert.equal(
      await readFile(path.join(shared, 'previous.md'), 'utf8'),
      'synthetic previous report',
    );
    assert.ok(run.trace.every((item) => item.surface === 'workspace'));
    assert.equal(control.state('a').owner, 'human');
    run.abort.abort();
    assert.equal(
      (await tools.invoke(run, 'write_file', { path: 'stopped.md', content: 'no' })).isError,
      true,
    );
    await assert.rejects(readFile(path.join(workdir, 'stopped.md')));
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
  assert.equal((await tools.invoke(run, 'list_files', {})).isError, true);
  assert.equal(run.trace.at(-1)?.code, 'TOOL_LIMIT');
  if (process.platform !== 'linux') {
    run.limit = 3;
    const result = await tools.invoke(run, 'shell', { command: 'printf forbidden' });
    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result).includes('SHELL_SANDBOX_UNAVAILABLE'));
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
  assert.equal(settled, false);
  finish(Buffer.from('synthetic-frame'));
  await pending;
  await drained;
  assert.equal(settled, true);
});

test('a parent replaced after validation cannot make a tool create even an empty file in a private directory', async (t) => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-write-parent-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  t.mock.method(fs, 'realpath', async (file: Parameters<typeof original>[0]) => {
    const result = await original(file);
    if (file === target && !redirected) {
      redirected = true;
      await fs.rename(parent, path.join(workdir, 'retained'));
      await fs.symlink(privateRoot, parent);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(tools.writeText(run, 'nested/new.txt', 'SYNTHETIC-ATTACK'));
  assert.equal(redirected, true);
  await assert.rejects(fs.access(path.join(privateRoot, 'new.txt')));
});
