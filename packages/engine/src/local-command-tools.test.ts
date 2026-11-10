import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Interaction } from '@daban/protocol';
import { expect, onTestFinished, test } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { Commands } from './commands.js';
import { Folders } from './folders.js';
import { Interactions } from './interactions.js';
import { LocalCommandTools } from './local-command-tools.js';
import { NativeWorkspace } from './native-workspace.js';
import { WorkspaceFiles } from './workspace.js';

test('Windows offers PowerShell only after explicit full access and enforces it at dispatch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-windows-command-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = new NativeWorkspace(path.join(root, 'workspace'));
  await workspace.prepare();
  const directory = await workspace.create(['mock-run', 'mock-alpha']);
  const folders = new Folders(path.join(root, 'folders.json'), [root]);
  const interactions = new Interactions(path.join(root, 'interactions'));
  const commands = new Commands({
    file: path.join(root, 'commands.sqlite'),
    interactions,
    target: 'host-local',
  });
  onTestFinished(() => commands.close());
  let executions = 0;
  const local = new LocalCommandTools(
    folders,
    commands,
    async (request) => {
      executions++;
      expect(request).toEqual({
        root: directory.canonical,
        cwd: directory.canonical,
        command: 'Get-Location',
        unrestricted: true,
      });
      return { content: [{ type: 'text', text: 'synthetic result' }] };
    },
    'win32',
  );
  const run: AgentToolRun = {
    id: 'mock-run',
    bot: 'mock-alpha',
    sessionId: 'mock-session',
    task: { requestId: 'mock-request', prompt: 'Run a synthetic command.', approvalMode: 'full' },
    workdir: directory.path,
    canonicalRoot: directory.canonical,
    localTaskDirectory: directory,
    abort: new AbortController(),
    toolCount: 0,
    limit: 5,
    seen: {},
    trace: [],
  };
  const args = { command: 'Get-Location' };
  const allowed = { ...run, task: { ...run.task!, hostCommandFullAccess: true as const } };
  expect(local.listFor(run)).toEqual([]);
  await expect(local.invoke(run, 'workspace_shell', args, 'mock-denied')).rejects.toMatchObject({
    code: 'NATIVE_WORKSPACE_TOOL_UNAVAILABLE',
  });
  expect(local.listFor(allowed)).toMatchObject([
    { name: 'workspace_shell', description: expect.stringContaining('PowerShell') },
  ]);
  await expect(
    local.invoke(allowed, 'local_shell', { ...args, folder: 'mock-folder' }, 'mock-local-denied'),
  ).rejects.toMatchObject({ code: 'NATIVE_WORKSPACE_TOOL_UNAVAILABLE' });
  expect(await local.invoke(allowed, 'workspace_shell', args, 'mock-allowed')).toMatchObject({
    content: [{ type: 'text', text: 'synthetic result' }],
  });
  expect(executions).toBe(1);
  expect(await interactions.list()).toEqual([]);
});

test.each(['direct', 'agent'] as const)(
  'local shell through %s preserves approval and call deduplication even in full mode',
  async (entry) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-local-command-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'project');
    await mkdir(path.join(directory, 'nested'), { recursive: true });
    const folders = new Folders(path.join(root, 'folders.json'), []);
    const grant = await folders.connect('mock-alpha', directory);
    const interactions = new Interactions(path.join(root, 'interactions'));
    const commands = new Commands({
      file: path.join(root, 'commands.sqlite'),
      interactions,
      target: 'host-local',
    });
    let received: { root: string; cwd: string; command: string } | undefined;
    let executions = 0;
    const local = new LocalCommandTools(
      folders,
      commands,
      async (request) => {
        executions++;
        received = request;
        return { content: [{ type: 'text', text: 'synthetic result' }] };
      },
      'linux',
    );
    const agent = new AgentTools(undefined, new WorkspaceFiles(directory));
    agent.localCommands = local;
    const tools = entry === 'agent' ? agent : local;
    const runId = 'mock-run';
    const run: AgentToolRun = {
      bot: 'mock-alpha',
      id: runId,
      sessionId: 'mock-session',
      task: {
        requestId: 'mock-request',
        prompt: 'Process a synthetic file.',
        approvalMode: 'full',
      },
      workdir: directory,
      canonicalRoot: directory,
      abort: new AbortController(),
      toolCount: 0,
      limit: 5,
      seen: {},
      trace: [],
    };

    try {
      expect(local.list.map((item) => item.name)).toContain('local_shell');
      const pendingCall = tools.invoke(
        run,
        'local_shell',
        { folder: grant.id, cwd: 'nested', command: 'python3 convert.py' },
        'mock-local-command',
      );
      let approval: Interaction | undefined;
      for (let index = 0; index < 50; index++) {
        approval = (await interactions.list()).find((item) => item.kind === 'approval');
        if (approval) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(approval).toMatchObject({
        tool: 'host_command',
        command: 'python3 convert.py',
        cwd: path.join(grant.path, 'nested'),
        root: grant.path,
        target: 'host-local',
      });
      if (!approval) throw new Error('LOCAL_APPROVAL_MISSING');
      expect(received).toBeUndefined();
      await interactions.reply(run.bot, runId, approval.id, { kind: 'decision', allow: true });
      expect(await pendingCall).toMatchObject({
        content: [{ type: 'text', text: 'synthetic result' }],
      });
      expect(received).toEqual({
        root: grant.path,
        cwd: path.join(grant.path, 'nested'),
        command: 'python3 convert.py',
      });
      expect(
        await tools.invoke(
          run,
          'local_shell',
          { folder: grant.id, cwd: 'nested', command: 'python3 convert.py' },
          'mock-local-command',
        ),
      ).toMatchObject({ content: [{ type: 'text', text: 'synthetic result' }] });
      expect(executions).toBe(1);
    } finally {
      await commands.close();
    }
  },
);

test.each(['auto', 'ask', 'replace directory', 'legacy full', 'full host access'] as const)(
  'workspace shell uses the owned task directory and captured command scope (%s)',
  async (action) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-task-command-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const workspace = new NativeWorkspace(path.join(root, 'workspace'));
    await workspace.prepare();
    const directory = await workspace.create(['mock-run', 'mock-alpha']);
    const folders = new Folders(path.join(root, 'folders.json'), [root]);
    const interactions = new Interactions(path.join(root, 'interactions'));
    const commands = new Commands({
      file: path.join(root, 'commands.sqlite'),
      interactions,
      target: 'host-local',
    });
    onTestFinished(() => commands.close());
    const agent = new AgentTools(undefined, workspace, { nativeOnly: true });
    let executions = 0;
    agent.localCommands = new LocalCommandTools(
      folders,
      commands,
      async (request) => {
        executions++;
        expect(request).toEqual({
          root: directory.canonical,
          cwd: directory.canonical,
          command: 'python3 sample.py',
          ...(action === 'full host access' ? { unrestricted: true } : {}),
        });
        expect(await readFile(path.join(request.cwd, 'sample.py'), 'utf8')).toBe('print(42)');
        return { content: [{ type: 'text', text: '42' }] };
      },
      'linux',
    );
    const run = {
      bot: 'mock-alpha',
      id: 'mock-run',
      sessionId: 'mock-session',
      task: {
        requestId: 'mock-request',
        prompt: 'Run a synthetic script.',
        approvalMode:
          action === 'legacy full' || action === 'full host access'
            ? ('full' as const)
            : action === 'auto'
              ? ('auto' as const)
              : ('ask' as const),
        ...(action === 'full host access' ? { hostCommandFullAccess: true as const } : {}),
      },
      workdir: directory.path,
      canonicalRoot: directory.canonical,
      localTaskDirectory: directory,
      abort: new AbortController(),
      toolCount: 0,
      limit: 10,
      seen: {},
      trace: [],
    };
    const written = await agent.invoke(run, 'write_file', {
      path: 'sample.py',
      content: 'print(42)',
    });
    expect(written.isError).not.toBe(true);
    const pending = agent.invoke(
      run,
      'workspace_shell',
      { command: 'python3 sample.py' },
      'mock-command',
    );
    if (action === 'auto' || action === 'legacy full' || action === 'full host access') {
      expect(await pending).toMatchObject({ content: [{ type: 'text', text: '42' }] });
      expect(executions).toBe(1);
      expect(await interactions.list()).toEqual([]);
      if (action === 'full host access') {
        const legacy = { ...run, task: { ...run.task, hostCommandFullAccess: undefined } };
        expect(
          await agent.invoke(
            legacy,
            'workspace_shell',
            { command: 'python3 sample.py' },
            'mock-command',
          ),
        ).toMatchObject({
          isError: true,
          content: [{ type: 'text', text: 'COMMAND_CALL_ID_REUSED' }],
        });
        expect(executions).toBe(1);
      }
      return;
    }
    let approval: Interaction | undefined;
    for (let index = 0; index < 50; index++) {
      approval = (await interactions.list()).find((item) => item.kind === 'approval');
      if (approval) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!approval) throw new Error(`Missing approval: ${JSON.stringify(await pending)}`);
    expect(approval).toMatchObject({
      tool: 'host_command',
      cwd: directory.canonical,
      root: directory.canonical,
      target: 'host-local',
    });
    expect(executions).toBe(0);
    if (action === 'replace directory') {
      await rename(directory.path, `${directory.path}-old`);
      await mkdir(directory.path);
    }
    await interactions.reply(run.bot, run.id, approval.id, { kind: 'decision', allow: true });
    const result = await pending;
    if (action === 'replace directory') {
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'TASK_DIRECTORY_MOVED' }],
      });
      expect(executions).toBe(0);
    } else {
      expect(result.content).toEqual([{ type: 'text', text: '42' }]);
      expect(executions).toBe(1);
    }
  },
);
