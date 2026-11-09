import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Interaction } from '@daban/protocol';
import { expect, test } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { Folders } from './folders.js';
import { Interactions } from './interactions.js';
import { LocalTools } from './local-tools.js';
import { WorkspaceFiles } from './workspace.js';

test('local tools participate in task budgets/traces without expanding existing workspace access', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-local-tools-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project');
  await mkdir(directory);
  await writeFile(path.join(directory, 'mock.txt'), 'SYNTHETIC LOCAL');
  const workspace = new WorkspaceFiles(path.join(root, 'workspace'));
  await workspace.prepare();
  const task = await workspace.create(['mock-run']);
  const folders = new Folders(path.join(root, 'folders.json'), [workspace.root]);
  const grant = await folders.connect('mock-a', directory);
  const tools = new AgentTools(undefined, workspace, { nativeOnly: true });
  tools.localFiles = new LocalTools(folders);
  const run: AgentToolRun = {
    bot: 'mock-a',
    id: 'mock-run',
    workdir: task.path,
    canonicalRoot: task.canonical,
    abort: new AbortController(),
    toolCount: 0,
    limit: 5,
    seen: {},
    trace: [],
  };
  expect(tools.list('mock-a').map((item) => item.name)).toContain('local_search');
  expect(tools.list('mock-a').map((item) => item.name)).toContain('local_request_folder');
  expect(tools.list('mock-a').map((item) => item.name)).not.toContain('shell');
  expect(
    await tools.invoke(run, 'local_read', { folder: grant.id, path: 'mock.txt' }),
  ).toMatchObject({ content: [{ text: expect.stringContaining('SYNTHETIC LOCAL') }] });
  expect(run.trace).toMatchObject([{ surface: 'local-files', phase: 'settled' }]);
  expect(
    (await tools.invoke(run, 'read_file', { path: path.join(directory, 'mock.txt') })).isError,
  ).toBe(true);
  expect(
    (
      await tools.invoke({ ...run, bot: 'mock-b' }, 'local_read', {
        folder: grant.id,
        path: 'mock.txt',
      })
    ).isError,
  ).toBe(true);
  expect(run.toolCount).toBe(2);
});

test('ask mode waits for an exact local-file approval and revocation remains available while waiting', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-local-approval-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project');
  await mkdir(directory);
  const folders = new Folders(path.join(root, 'folders.json'), []);
  const grant = await folders.connect('mock-a', directory);
  const interactions = new Interactions(path.join(root, 'interactions'));
  const tools = new LocalTools(folders, interactions);
  const abort = new AbortController();
  const run: AgentToolRun = {
    bot: 'mock-a',
    id: 'mock-run',
    sessionId: 'mock-session',
    task: { requestId: 'mock-request', prompt: 'SYNTHETIC WRITE', approvalMode: 'ask' },
    workdir: directory,
    canonicalRoot: directory,
    abort,
    toolCount: 0,
    limit: 5,
    seen: {},
    trace: [],
  };
  const result = tools.invoke(run, 'local_write', {
    folder: grant.id,
    path: 'mock.txt',
    content: 'SYNTHETIC',
    revision: null,
  });
  let card: Interaction | undefined;
  for (let index = 0; index < 50; index++) {
    card = (await interactions.list()).find((item) => item.kind === 'approval');
    if (card) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(card).toMatchObject({
    tool: 'local_file',
    path: path.join(grant.path, 'mock.txt'),
    operation: 'local_write',
  });
  await folders.disconnect(run.bot, grant.id);
  abort.abort();
  await expect(result).rejects.toThrow();
  expect((await folders.status(run.bot)).operations).toEqual([]);
});

test('local folder access requests wait for a human-selected directory before returning it to the Bot', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-local-folder-request-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project');
  await mkdir(directory);
  const folders = new Folders(path.join(root, 'folders.json'), []);
  const interactions = new Interactions(path.join(root, 'interactions'));
  const tools = new LocalTools(folders, interactions);
  const current = {
    id: 'mock-run',
    bot: 'mock-a',
    sessionId: 'mock-session',
    abort: new AbortController(),
    workdir: directory,
    canonicalRoot: directory,
    toolCount: 0,
    limit: 5,
    seen: {},
    trace: [],
    task: { requestId: 'mock-request', prompt: 'Read the synthetic project.' },
  };

  expect(tools.list.map((tool) => tool.name)).toContain('local_request_folder');
  const result = tools.invoke(current, 'local_request_folder', { path: `file://${directory}` });
  try {
    let approval: Interaction | undefined;
    for (let index = 0; index < 50; index++) {
      approval = (await interactions.list()).find(
        (item) =>
          item.kind === 'approval' && 'tool' in item && String(item.tool) === 'local_folder',
      );
      if (approval) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(approval).toMatchObject({
      tool: 'local_folder',
      path: directory,
      status: 'pending',
    });
    expect((await folders.status(current.bot)).folders).toEqual([]);

    const selected = await folders.connect(current.bot, directory);
    await interactions.reply(current.bot, current.id!, approval!.id, {
      kind: 'folder_grant',
      folderId: selected.id,
      path: selected.path,
    } as never);
    await expect(result).resolves.toEqual({ folder: selected });
    expect(await new Interactions(path.join(root, 'interactions')).list()).toMatchObject([
      {
        id: approval!.id,
        status: 'resolved',
        reply: { kind: 'folder_grant', folderId: selected.id },
      },
    ]);
  } finally {
    current.abort.abort();
    await result.catch(() => {});
  }
});

test("a local folder approval cannot borrow another Bot's connected directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-local-folder-denied-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project');
  await mkdir(directory);
  const folders = new Folders(path.join(root, 'folders.json'), []);
  const otherBotFolder = await folders.connect('mock-b', directory);
  const interactions = new Interactions(path.join(root, 'interactions'));
  const current = {
    id: 'mock-run',
    bot: 'mock-a',
    sessionId: 'mock-session',
    abort: new AbortController(),
    workdir: directory,
    canonicalRoot: directory,
    toolCount: 0,
    limit: 5,
    seen: {},
    trace: [],
    task: { requestId: 'mock-request', prompt: 'Read the synthetic project.' },
  };
  const result = new LocalTools(folders, interactions).invoke(current, 'local_request_folder', {
    path: directory,
  });
  try {
    let approval: Interaction | undefined;
    for (let index = 0; index < 50; index++) {
      approval = (await interactions.list()).find(
        (item) =>
          item.kind === 'approval' && 'tool' in item && String(item.tool) === 'local_folder',
      );
      if (approval) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!approval) throw new Error('LOCAL_FOLDER_APPROVAL_MISSING');
    await interactions.reply(current.bot, current.id!, approval.id, {
      kind: 'folder_grant',
      folderId: otherBotFolder.id,
      path: otherBotFolder.path,
    } as never);
    await expect(result).rejects.toThrow('FOLDER_NOT_CONNECTED');
    expect((await folders.status(current.bot)).folders).toEqual([]);
    expect((await folders.status('mock-b')).folders).toEqual([otherBotFolder]);
  } finally {
    current.abort.abort();
    await result.catch(() => {});
  }
});
