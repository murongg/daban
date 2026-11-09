import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { Commands } from './commands.js';
import { Folders } from './folders.js';
import { Interactions } from './interactions.js';
import { LocalCommandTools } from './local-command-tools.js';
import { runCodexTurn } from './model-cli.js';
import { Work } from './work.js';
import { WorkTools } from './work-tools.js';
import { WorkspaceFiles } from './workspace.js';

function wire() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const messages = lines[Symbol.asyncIterator]();
  return {
    input,
    output,
    next: async (): Promise<unknown> => {
      const message = await messages.next();
      if (message.done) throw new Error('Synthetic client closed before sending a message');
      return JSON.parse(message.value);
    },
    send: (value: unknown) => input.write(`${JSON.stringify(value)}\n`),
    close: () => {
      lines.close();
      input.destroy();
      output.destroy();
    },
  };
}

test.each(['human denial', 'premature completion'] as const)(
  'Codex receives real Daban tool results and shell dispatch stays at zero after %s',
  async (ending) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-codex-'));
    const peer = wire();
    const workspace = path.join(root, 'project');
    await mkdir(workspace);
    const folders = new Folders(path.join(root, 'folders.json'), []);
    const grant = await folders.connect('mock-bot', workspace);
    const interactions = new Interactions(path.join(root, 'interactions'));
    const commands = new Commands({
      file: path.join(root, 'commands.sqlite'),
      interactions,
      target: 'host-local',
    });
    const work = new Work(path.join(root, 'work.sqlite'));
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'mock output' }],
    }));
    const tools = new AgentTools(undefined, new WorkspaceFiles(workspace));
    tools.work = new WorkTools(work);
    tools.localCommands = new LocalCommandTools(folders, commands, execute);
    const run: AgentToolRun = {
      bot: 'mock-bot',
      id: 'mock-run',
      sessionId: 'mock-daban-session',
      task: { requestId: 'mock-request', prompt: 'List the synthetic tasks.', approvalMode: 'ask' },
      workdir: workspace,
      canonicalRoot: workspace,
      abort: new AbortController(),
      toolCount: 0,
      limit: 5,
      seen: {},
      trace: [],
    };
    let turn: Promise<string> | undefined;
    try {
      await work.write(
        {
          id: 'mock-create',
          item: 'mock-item',
          revision: 0,
          action: 'create',
          value: { title: 'Synthetic checklist', description: '', progress: '', status: 'todo' },
        },
        { kind: 'human' },
      );
      const delta = vi.fn();
      turn = runCodexTurn({
        input: peer.input,
        output: peer.output,
        model: 'mock-model',
        prompt: run.task!.prompt,
        run,
        tools,
        onDelta: delta,
      });
      // Race the peer read so a handshake failure reports the actual error instead of hanging the test.
      const next = () =>
        Promise.race([
          peer.next(),
          turn!.then(() => {
            throw new Error('Synthetic turn ended early');
          }),
        ]);
      expect(await next()).toMatchObject({
        id: 1,
        method: 'initialize',
        params: { capabilities: { experimentalApi: true } },
      });
      peer.send({ id: 1, result: { userAgent: 'daban_poc/0.167.0 (synthetic)' } });
      expect(await next()).toMatchObject({ method: 'initialized' });
      expect(await next()).toMatchObject({
        id: 2,
        method: 'thread/start',
        params: {
          model: 'mock-model',
          ephemeral: true,
          environments: [],
          dynamicTools: [
            { type: 'function', name: 'work_list', inputSchema: { type: 'object' } },
            { type: 'function', name: 'local_shell', inputSchema: { type: 'object' } },
          ],
        },
      });
      peer.send({ id: 2, result: { thread: { id: 'mock-thread' } } });
      expect(await next()).toMatchObject({
        id: 3,
        method: 'turn/start',
        params: { threadId: 'mock-thread', input: [{ type: 'text', text: run.task!.prompt }] },
      });
      peer.send({ id: 3, result: { turn: { id: 'mock-turn', status: 'inProgress' } } });
      const call = (id: string, callId: string, tool: string, args = {}, turnId = 'mock-turn') =>
        peer.send({
          id,
          method: 'item/tool/call',
          params: { threadId: 'mock-thread', turnId, callId, tool, arguments: args },
        });
      call('mock-foreign', 'mock-stale', 'work_list', {}, 'mock-old-turn');
      expect(await next()).toMatchObject({ id: 'mock-foreign', result: { success: false } });
      call('mock-unlisted', 'mock-hidden', 'shell', { command: 'echo synthetic' });
      expect(await next()).toMatchObject({ id: 'mock-unlisted', result: { success: false } });
      peer.send({ id: 'mock-native-approval', method: 'item/commandExecution/requestApproval' });
      expect(await next()).toMatchObject({
        id: 'mock-native-approval',
        result: { decision: 'decline' },
      });
      call('mock-read', 'mock-list', 'work_list');
      expect(await next()).toMatchObject({
        id: 'mock-read',
        result: {
          success: true,
          contentItems: [
            { type: 'inputText', text: expect.stringContaining('Synthetic checklist') },
          ],
        },
      });

      const args = { folder: grant.id, command: 'echo synthetic' };
      call('mock-approval', 'mock-command', 'local_shell', args);
      const approval = await vi.waitFor(async () => {
        const record = (await interactions.list()).find((item) => item.kind === 'approval');
        expect(record).toMatchObject({ status: 'pending', tool: 'host_command' });
        return record!;
      });
      expect(execute).not.toHaveBeenCalled();
      const complete = () =>
        peer.send({
          method: 'turn/completed',
          params: { threadId: 'mock-thread', turn: { id: 'mock-turn', status: 'completed' } },
        });
      if (ending === 'premature completion') {
        complete();
        await expect(turn).rejects.toThrow('CODEX_TOOL_IN_FLIGHT');
        expect(run.abort.signal.aborted).toBe(true);
        expect(execute).not.toHaveBeenCalled();
        return;
      }
      await interactions.reply(run.bot, run.id!, approval.id, { kind: 'decision', allow: false });
      expect(await next()).toMatchObject({
        id: 'mock-approval',
        result: {
          success: false,
          contentItems: [{ type: 'inputText', text: 'COMMAND_APPROVAL_REJECTED' }],
        },
      });
      call('mock-replay', 'mock-command', 'local_shell', args);
      expect(await next()).toMatchObject({ id: 'mock-replay', result: { success: false } });
      expect(run.toolCount).toBe(2);
      expect(execute).not.toHaveBeenCalled();

      peer.send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'mock-thread', turnId: 'mock-old-turn', delta: 'stale' },
      });
      peer.send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'mock-thread', turnId: 'mock-turn', delta: 'Synthetic reply.' },
      });
      complete();
      await expect(turn).resolves.toBe('Synthetic reply.');
      expect(delta.mock.calls).toEqual([['Synthetic reply.']]);
    } finally {
      run.abort.abort();
      peer.close();
      await turn?.catch(() => {});
      await commands.close();
      await work.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('stopping a turn releases a blocked write to the App Server', async () => {
  const input = new PassThrough();
  const tools = new AgentTools(undefined, new WorkspaceFiles(tmpdir()));
  const run: AgentToolRun = {
    bot: 'mock-bot',
    workdir: tmpdir(),
    canonicalRoot: tmpdir(),
    abort: new AbortController(),
    toolCount: 0,
    limit: 1,
    seen: {},
    trace: [],
  };
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      run.abort.abort();
      // Simulate an App Server that no longer reads its stdin.
      completeWrite = callback;
    },
  });
  let completeWrite: (() => unknown) | undefined;
  try {
    const turn = runCodexTurn({ input, output, tools, run, model: 'mock-model', prompt: 'mock' });
    const settled = vi.fn();
    turn.catch(settled);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 500 });
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    completeWrite?.();
    input.destroy();
    output.destroy();
  }
});

test('an unverified App Server version is rejected before a thread starts', async () => {
  const peer = wire();
  const tools = new AgentTools(undefined, new WorkspaceFiles(tmpdir()));
  const run: AgentToolRun = {
    bot: 'mock-bot',
    workdir: tmpdir(),
    canonicalRoot: tmpdir(),
    abort: new AbortController(),
    toolCount: 0,
    limit: 1,
    seen: {},
    trace: [],
  };
  const turn = runCodexTurn({
    input: peer.input,
    output: peer.output,
    tools,
    run,
    model: 'mock-model',
    prompt: 'mock',
  });
  try {
    expect(await peer.next()).toMatchObject({ method: 'initialize' });
    peer.send({ id: 1, result: { userAgent: 'daban_poc/0.167.1 (synthetic)' } });
    const first = await Promise.race([peer.next(), turn.catch((error: unknown) => error)]);
    expect(first).toMatchObject({ message: 'CODEX_UNVERIFIED_VERSION' });
    expect(run.abort.signal.aborted).toBe(true);
  } finally {
    run.abort.abort();
    peer.close();
    await turn.catch(() => {});
  }
});
