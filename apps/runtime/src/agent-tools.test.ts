import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type AgentToolRun, AgentTools, agentToolList } from './agent-tools.js';
import type { ComputerFacade, ToolResult } from './computer-tools.js';
import { Control } from './control.js';
import { WorkspaceFiles } from './workspace.js';

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
