import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Interaction } from '@daban/protocol';
import { expect, test } from 'vitest';
import type { AgentToolRun } from './agent-tools.js';
import { Commands } from './commands.js';
import { Folders } from './folders.js';
import { Interactions } from './interactions.js';
import { LocalCommandTools } from './local-command-tools.js';

test('local shell is scoped to a connected folder and waits for exact approval even in full mode', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-local-command-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
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
  const tools = new LocalCommandTools(folders, commands, async (request) => {
    received = request;
    return { content: [{ type: 'text', text: 'synthetic result' }] };
  });
  const runId = 'mock-run';
  const run: AgentToolRun = {
    bot: 'mock-alpha',
    id: runId,
    sessionId: 'mock-session',
    task: { requestId: 'mock-request', prompt: 'Process a synthetic file.', approvalMode: 'full' },
    workdir: directory,
    canonicalRoot: directory,
    abort: new AbortController(),
    toolCount: 0,
    limit: 5,
    seen: {},
    trace: [],
  };

  try {
    expect(tools.list.map((item) => item.name)).toEqual(['local_shell']);
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
  } finally {
    await commands.close();
  }
});
