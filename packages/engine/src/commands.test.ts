import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isInteractionInput, matchesReply } from '@daban/protocol';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { expect, test } from 'vitest';
import type { CommandReview } from './commands.js';
import { Commands } from './commands.js';
import { commands as commandsTable } from './commands-schema.js';
import type { ToolResult } from './computer-tools.js';
import { Interactions } from './interactions.js';
import { Risk } from './risk.js';

const output: ToolResult = { content: [{ type: 'text', text: 'mock guest output' }] };

test('VM approval records accept only exact bounded commands and absolute guest paths', () => {
  const approval = {
    id: 'mock-command',
    sessionId: 'mock-session',
    kind: 'approval',
    tool: 'vm_command',
    command: 'echo mock',
    cwd: '/mock-guest/task',
    purpose: 'Synthetic request',
    target: 'linux-vm',
  };
  expect(isInteractionInput(approval)).toBe(true);
  expect(isInteractionInput({ ...approval, command: 'x'.repeat(12001) })).toBe(false);
  expect(isInteractionInput({ ...approval, cwd: 'relative/task' })).toBe(false);
  expect(isInteractionInput({ ...approval, cwd: '/mock-guest/../private' })).toBe(false);
  expect(isInteractionInput({ ...approval, target: 'host' })).toBe(false);
  expect(isInteractionInput({ ...approval, env: { MOCK_PRIVATE: 'synthetic' } })).toBe(false);
});

test('local folder requests are bounded approvals tied to a host directory path', () => {
  const approval = {
    id: 'mock-folder-request',
    sessionId: 'mock-session',
    kind: 'approval',
    tool: 'local_folder',
    path: '/mock/project',
  };
  expect(isInteractionInput(approval)).toBe(true);
  expect(isInteractionInput({ ...approval, path: '' })).toBe(false);
  expect(isInteractionInput({ ...approval, path: '/mock/project\0' })).toBe(false);
  expect(isInteractionInput({ ...approval, path: 'x'.repeat(4097) })).toBe(false);
  expect(isInteractionInput({ ...approval, extra: true })).toBe(false);
  const grant = { kind: 'folder_grant', folderId: 'mock-folder', path: '/mock/project' };
  expect(matchesReply(approval as never, grant)).toBe(true);
  expect(matchesReply(approval as never, { kind: 'decision', allow: true })).toBe(false);
  expect(matchesReply(approval as never, { kind: 'decision', allow: false })).toBe(true);
  expect(matchesReply(approval as never, { ...grant, path: '' })).toBe(false);
  expect(
    matchesReply(
      { ...approval, tool: 'local_file', operation: 'local_write', arguments: '{}' } as never,
      grant,
    ),
  ).toBe(false);
});

test('host commands require one-time human approval even in full mode', async () => {
  const context = await fixture();
  let dispatches = 0;
  const options = {
    ...context,
    target: 'host-local' as const,
    review: async () => 'allow' as const,
  };
  const commands = new Commands(options);
  const current = {
    ...run(),
    root: '/synthetic/selected',
    workdir: '/synthetic/selected',
    task: { ...run().task, approvalMode: 'full' as const },
  };
  const pendingCall = commands.invoke(
    current,
    'local_shell',
    { folder: 'mock-folder', cwd: '', command: 'python3 process.py' },
    'mock-host-command',
    async () => {
      dispatches++;
      return output;
    },
  );
  try {
    const approval = await pending(context.interactions);
    expect(approval).toMatchObject({
      tool: 'host_command',
      command: 'python3 process.py',
      cwd: '/synthetic/selected',
      root: '/synthetic/selected',
      target: 'host-local',
    });
    expect(dispatches).toBe(0);
    await context.interactions.reply(current.bot, current.id, approval.id, {
      kind: 'decision',
      allow: true,
    });
    expect(await pendingCall).toEqual(output);
    expect(dispatches).toBe(1);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

const run = () => ({
  id: 'mock-run',
  bot: 'mock-bot',
  sessionId: 'mock-session',
  abort: new AbortController(),
  workdir: '/mock-guest/task',
  task: { requestId: 'mock-request', prompt: 'Prepare synthetic project.' },
});

test('ask mode overrides risk auto-approval and full mode still deduplicates its exact command', async () => {
  const context = await fixture();
  const commands = new Commands({
    ...context,
    review: async (request) => (request.command.startsWith('rm') ? 'deny' : 'allow'),
  });
  let dispatches = 0;
  const dispatch = async () => {
    dispatches++;
    return output;
  };
  try {
    const strict = { ...run(), task: { ...run().task, approvalMode: 'ask' as const } };
    const pendingCall = commands.invoke(
      strict,
      'shell',
      { command: 'ls' },
      'mock-strict-call',
      dispatch,
    );
    const approval = await pending(context.interactions);
    expect(dispatches).toBe(0);
    await context.interactions.reply(strict.bot, strict.id, approval.id, {
      kind: 'decision',
      allow: false,
    });
    expect((await pendingCall).isError).toBe(true);
    const full = {
      ...run(),
      id: 'mock-full-run',
      task: { ...run().task, approvalMode: 'full' as const },
    };
    const args = { command: 'rm mock-output.txt' };
    expect(await commands.invoke(full, 'shell', args, 'mock-full-call', dispatch)).toEqual(output);
    expect(await commands.invoke(full, 'shell', args, 'mock-full-call', dispatch)).toEqual(output);
    expect(dispatches).toBe(1);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});
test('production risk policy auto-runs reads once but opens a human approval for deletion', async () => {
  const context = await fixture();
  const policy = new Risk({
    settings: { file: '/mock/credentials.json', resolve: async () => null },
  });
  const commands = new Commands({ ...context, review: policy.review });
  let dispatched = 0;
  const current = run(),
    dispatch = async () => {
      dispatched++;
      return output;
    };
  try {
    expect(
      await commands.invoke(
        current,
        'shell',
        { command: 'ls -la /shared; cat input.csv' },
        'mock-read',
        dispatch,
      ),
    ).toStrictEqual(output);
    expect((await context.interactions.list()).length).toBe(0);
    expect(
      await commands.invoke(
        current,
        'shell',
        { command: 'ls -la /shared; cat input.csv' },
        'mock-read',
        dispatch,
      ),
    ).toStrictEqual(output);
    expect(dispatched).toBe(1);
    const deletion = commands.invoke(
      current,
      'process_start',
      { command: 'rm /shared/mock.csv' },
      'mock-delete',
      dispatch,
    );
    const approval = await pending(context.interactions);
    await context.interactions.reply(current.bot, current.id, approval.id, {
      kind: 'decision',
      allow: false,
    });
    expect((await deletion).isError).toBe(true);
    expect(dispatched).toBe(1);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-command-gate-'));
  const interactions = new Interactions(path.join(root, 'interactions'));
  await interactions.ready;
  return { root, interactions, file: path.join(root, 'commands.sqlite') };
}
async function pending(interactions: Interactions) {
  for (let count = 0; count < 100; count++) {
    const item = (await interactions.list()).find((entry) => entry.status === 'pending');
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Mock approval was not published');
}

test('a pre-ORM command file keeps settled receipts and fences an interrupted dispatch after the schema baseline', async () => {
  const context = await fixture();
  const source = path.join(context.root, 'source.sqlite');
  let dispatches = 0;
  const dispatch = async () => {
    dispatches++;
    return output;
  };
  let commands = new Commands({ ...context, file: source, review: async () => 'allow' });
  try {
    for (const wire of ['mock-settled', 'mock-interrupted'])
      expect(await commands.invoke(run(), 'shell', { command: wire }, wire, dispatch)).toEqual(
        output,
      );
    await commands.close();
    const reader = new DatabaseSync(source);
    const rows = drizzle({ client: reader }).select().from(commandsTable).all();
    reader.close();
    expect(rows.length).toBe(2);
    const old = new DatabaseSync(context.file);
    old.exec(
      'CREATE TABLE commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request TEXT NOT NULL,phase TEXT NOT NULL,decision TEXT,result TEXT);',
    );
    for (const row of rows) {
      const interrupted = row.request.includes('mock-interrupted');
      old
        .prepare('INSERT INTO commands VALUES(?,?,?,?,?,?)')
        .run(
          row.id,
          row.fingerprint,
          row.request,
          interrupted ? 'dispatching' : row.phase,
          row.decision,
          interrupted ? null : row.result,
        );
    }
    old.close();
    commands = new Commands({ ...context, review: async () => 'allow' });
    await commands.ready;
    expect(
      await commands.invoke(run(), 'shell', { command: 'mock-settled' }, 'mock-settled', dispatch),
    ).toEqual(output);
    const interrupted = await commands.invoke(
      run(),
      'shell',
      { command: 'mock-interrupted' },
      'mock-interrupted',
      dispatch,
    );
    expect(interrupted).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'COMMAND_OUTCOME_UNKNOWN' }],
    });
    expect(dispatches).toBe(2);
    expect(
      await commands.invoke(run(), 'shell', { command: 'mock-new' }, 'mock-new', dispatch),
    ).toEqual(output);
    expect(dispatches).toBe(3);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

test('raw commands ask by default and denial cannot dispatch', async () => {
  const context = await fixture();
  const commands = new Commands({ ...context });
  let dispatches = 0;
  try {
    const current = run();
    const result = commands.invoke(
      current,
      'shell',
      { command: 'echo mock' },
      'mock-call',
      async () => {
        dispatches++;
        return output;
      },
    );
    const approval = await pending(context.interactions);
    expect(approval.kind).toBe('approval');
    expect(approval.kind === 'approval' && approval.tool).toBe('vm_command');
    expect('command' in approval && approval.command).toBe('echo mock');
    expect('cwd' in approval && approval.cwd).toBe(current.workdir);
    await context.interactions.reply(current.bot, current.id, approval.id, {
      kind: 'decision',
      allow: false,
    });
    expect((await result).isError).toBe(true);
    expect(dispatches).toBe(0);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

test('human approval executes only its exact one-off command and remains an inspectable receipt', async () => {
  const context = await fixture();
  let commands = new Commands({ ...context });
  let dispatches = 0;
  try {
    const current = run();
    const dispatch = async () => {
      dispatches++;
      return output;
    };
    const first = commands.invoke(
      current,
      'shell',
      { command: 'echo mock approved' },
      'mock-human-call',
      dispatch,
    );
    const approval = await pending(context.interactions);
    await context.interactions.reply(current.bot, current.id, approval.id, {
      kind: 'decision',
      allow: true,
    });
    expect(await first).toStrictEqual(output);
    await commands.close();
    commands = new Commands({ ...context });
    expect(
      await commands.invoke(
        current,
        'shell',
        { command: 'echo mock approved' },
        'mock-human-call',
        dispatch,
      ),
    ).toStrictEqual(output);
    expect(dispatches).toBe(1);
    const next = commands.invoke(
      current,
      'shell',
      { command: 'echo mock different' },
      'mock-human-next',
      dispatch,
    );
    const second = await pending(context.interactions);
    expect(second.id).not.toBe(approval.id);
    await context.interactions.reply(current.bot, current.id, second.id, {
      kind: 'decision',
      allow: false,
    });
    expect((await next).isError).toBe(true);
    expect(dispatches).toBe(1);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

test('review sees exact context and one approved RPC identity dispatches once', async () => {
  const context = await fixture();
  const reviews: CommandReview[] = [];
  const commands = new Commands({
    ...context,
    review: async (request) => {
      reviews.push(request);
      return 'allow';
    },
  });
  let dispatches = 0;
  try {
    const current = run();
    const dispatch = async () => {
      dispatches++;
      return output;
    };
    const first = commands.invoke(
      current,
      'shell',
      { command: 'echo mock' },
      'mock-call',
      dispatch,
    );
    const duplicate = commands.invoke(
      current,
      'shell',
      { command: 'echo mock' },
      'mock-call',
      dispatch,
    );
    expect(await first).toStrictEqual(output);
    expect(await duplicate).toStrictEqual(output);
    expect(
      await commands.invoke(current, 'shell', { command: 'echo mock' }, 'mock-call', dispatch),
    ).toStrictEqual(output);
    expect(dispatches).toBe(1);
    expect(reviews.length).toBe(1);
    expect(reviews[0].sessionId).toBe(current.sessionId);
    expect(reviews[0].args).toStrictEqual({ command: 'echo mock' });
    expect(reviews[0].target).toBe('linux-vm');
    expect((await context.interactions.list()).length).toBe(0);
    const changed = await commands.invoke(
      current,
      'shell',
      { command: 'echo changed' },
      'mock-call',
      dispatch,
    );
    expect(changed.isError).toBe(true);
    expect(dispatches).toBe(1);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

test('a user grant applies to one exact command and stop after decision prevents dispatch', async () => {
  const context = await fixture();
  const commands = new Commands({ ...context });
  let dispatches = 0;
  try {
    const current = run();
    const result = commands.invoke(
      current,
      'process_start',
      { command: 'mock server' },
      'mock-start',
      async () => {
        dispatches++;
        return output;
      },
    );
    const approval = await pending(context.interactions);
    await context.interactions.reply(current.bot, current.id, approval.id, {
      kind: 'decision',
      allow: true,
    });
    current.abort.abort();
    expect((await result).isError).toBe(true);
    expect(dispatches).toBe(0);
    expect(
      (
        await commands.invoke(
          current,
          'process_start',
          { command: 'mock server' },
          'mock-start',
          async () => {
            dispatches++;
            return output;
          },
        )
      ).isError,
    ).toBe(true);
    expect(dispatches).toBe(0);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

test('lost dispatch outcomes and restored grants cannot authorize another execution', async () => {
  const context = await fixture();
  let commands = new Commands({ ...context, review: async () => 'allow' });
  let dispatches = 0;
  const current = run();
  try {
    const result = await commands.invoke(
      current,
      'shell',
      { command: 'mock mutation' },
      'mock-lost',
      async () => {
        dispatches++;
        throw new Error('MOCK_ACK_LOST');
      },
    );
    expect(result.isError).toBe(true);
    await commands.close();
    commands = new Commands({ ...context, review: async () => 'allow' });
    const restored = await commands.invoke(
      current,
      'shell',
      { command: 'mock mutation' },
      'mock-lost',
      async () => {
        dispatches++;
        return output;
      },
    );
    expect(restored.isError).toBe(true);
    expect(dispatches).toBe(1);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

test('review rejection and process input are bound to exact stdin bytes', async () => {
  const context = await fixture();
  const commands = new Commands({ ...context, review: async () => 'deny' });
  let dispatches = 0;
  try {
    const current = run();
    const dispatch = async () => {
      dispatches++;
      return output;
    };
    expect(
      (
        await commands.invoke(
          current,
          'process_input',
          { id: 'mock-process', data: 'mock bytes\n', eof: true },
          'mock-input',
          dispatch,
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await commands.invoke(
          current,
          'process_input',
          { id: 'mock-process', data: 'different bytes\n', eof: true },
          'mock-input',
          dispatch,
        )
      ).isError,
    ).toBe(true);
    expect(dispatches).toBe(0);
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

test('a restored unfinished decision cannot be dispatched by its previous owner', async () => {
  const context = await fixture();
  let release!: (value: 'allow') => unknown;
  let entered!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const review = new Promise<'allow'>((resolve) => {
    release = resolve;
  });
  const commands = new Commands({
    ...context,
    review: async () => {
      entered();
      return review;
    },
  });
  let replacement: Commands | undefined;
  let dispatches = 0;
  try {
    const current = run();
    const result = commands.invoke(
      current,
      'shell',
      { command: 'mock stale owner' },
      'mock-stale',
      async () => {
        dispatches++;
        return output;
      },
    );
    await started;
    replacement = new Commands({ ...context, review: async () => 'allow' });
    await replacement.ready;
    release('allow');
    expect((await result).isError).toBe(true);
    expect(dispatches).toBe(0);
  } finally {
    release('allow');
    await commands.close();
    await replacement?.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

test('an unusable host command store cannot dispatch or expose a storage exception', async () => {
  const context = await fixture();
  const broken = new DatabaseSync(context.file);
  broken.exec('CREATE TABLE commands(phase TEXT)');
  broken.close();
  const commands = new Commands({ ...context, review: async () => 'allow' });
  let dispatches = 0;
  try {
    const result = await commands.invoke(
      run(),
      'shell',
      { command: 'mock mutation' },
      'mock-broken-store',
      async () => {
        dispatches++;
        return output;
      },
    );
    expect(result.isError).toBe(true);
    expect(dispatches).toBe(0);
    expect.assert(!JSON.stringify(result).includes('SELECT'));
  } finally {
    await commands.close();
    await rm(context.root, { recursive: true, force: true });
  }
});
