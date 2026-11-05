import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { AgentTools } from './agent-tools.js';
import { IntegrationTools } from './integration-tools.js';
import { Integrations } from './integrations.js';
import { Interactions } from './interactions.js';
import { Projects } from './projects.js';
import { WorkspaceFiles } from './workspace.js';

const offered = [
  {
    name: 'synthetic_echo',
    description: '返回合成输入',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
];
async function ready(check: () => Promise<boolean>) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect.unreachable('Synthetic integration did not reach expected state');
}
async function fixture(start?: () => Promise<unknown>, beforeSend?: () => Promise<unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-integration-tools-'));
  const store = new Integrations(path.join(root, 'integrations.sqlite'));
  const interactions = new Interactions(path.join(root, 'interactions'));
  await store.save({
    requestId: 'mock-create',
    id: 'mock-connection',
    revision: 0,
    name: '合成外部连接',
    endpoint: 'https://mcp.example.test/mcp?key=synthetic-query-secret',
    bearer: 'synthetic-bearer-secret',
  });
  const catalog = await store.catalog('mock-connection', 1, offered);
  const binding = {
    connection: 'mock-connection',
    configRevision: 1,
    bindingRevision: 0,
    catalogDigest: catalog.current.catalogDigest!,
    tools: ['synthetic_echo'],
    enabled: true,
  };
  await store.bind('mock-a', binding);
  let factories = 0,
    effects = 0,
    unknown = false,
    changed = false;
  const options = {
    remote: async (
      _config: { endpoint: string; bearer?: string },
      options: import('./mcp-fetch.js').McpFetchOptions,
    ) => {
      factories++;
      return {
        start: async () => {
          await start?.();
        },
        tools: async () => (changed ? [{ ...offered[0], description: '合成目录已更新' }] : offered),
        call: async (_name: string, args: Record<string, unknown>) => {
          await options.onDispatch?.();
          await beforeSend?.();
          options.authorize?.();
          effects++;
          if (unknown) throw new Error('synthetic lost reply');
          return { content: [{ type: 'text', text: `SYNTHETIC:${args.value}` }] };
        },
        close: async () => {},
      };
    },
  };
  const tools = new IntegrationTools(store, interactions, options);
  const run = {
    id: 'mock-run',
    bot: 'mock-a',
    sessionId: 'mock-session',
    abort: new AbortController(),
    integrations: await store.capture('mock-a'),
  };
  return {
    root,
    store,
    interactions,
    tools,
    run,
    alias: catalog.tools[0].alias,
    counts: () => ({ factories, effects }),
    setUnknown: () => {
      unknown = true;
    },
    setChanged: () => {
      changed = true;
    },
    close: async () => {
      run.abort.abort();
      await tools.close();
      await interactions.endRun(run.bot, run.id);
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each([
  ['approval', 'remove'],
  ['approval', 'downgrade'],
  ['startup', 'remove'],
  ['startup', 'downgrade'],
  ['send', 'remove'],
  ['send', 'downgrade'],
  ['receipt', 'remove'],
  ['receipt', 'downgrade'],
] as const)(
  'project authority changing during MCP %s (%s) prevents a new external effect',
  async (phase, change) => {
    const f = await fixture();
    await f.tools.close();
    const project = { projectId: 'mock-project', revision: 1 };
    const run = {
      ...f.run,
      project,
      workdir: f.root,
      canonicalRoot: f.root,
      seen: {},
      trace: [],
      toolCount: 0,
      limit: 10,
    };
    const projects = new Projects(path.join(f.root, 'projects.sqlite'), {
      changed: async (current) => {
        if (current.revision !== project.revision) await f.interactions.endRun(run.bot, run.id);
      },
    });
    let release: (() => unknown) | undefined, arrived: (() => unknown) | undefined;
    const gate = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    const waiting = new Promise<unknown>((resolve) => {
      arrived = () => resolve(undefined);
    });
    const pause = async () => {
      arrived?.();
      await gate;
    };
    let effects = 0;
    const integrations = new IntegrationTools(f.store, f.interactions, {
      remote: async (_config, options) => ({
        start: async () => {
          if (phase === 'startup') await pause();
        },
        tools: async () => offered,
        call: async () => {
          if (phase === 'send') await pause();
          await options.onDispatch?.();
          if (phase === 'receipt') await pause();
          options.authorize?.();
          effects++;
          return { content: [{ type: 'text', text: 'SYNTHETIC EFFECT' }] };
        },
        close: async () => {},
      }),
    });
    const tools = new AgentTools(undefined, new WorkspaceFiles(f.root), {
      projectAccess: (captured, access) =>
        projects.assertScope(captured.bot, captured.project!, access),
    });
    tools.integrations = integrations;
    try {
      await projects.ready;
      await projects.write({
        action: 'create',
        requestId: 'mock-project-create',
        projectId: project.projectId,
        expectedRevision: 0,
        value: { name: 'SYNTHETIC', grants: [{ bot: run.bot, content: 'write', browser: true }] },
      });
      const pending = tools.invoke(run, f.alias, { value: 'SYNTHETIC' }, 'mock-project-wire');
      await ready(async () =>
        (await f.interactions.list()).some((item) => item.status === 'pending'),
      );
      const approval = (await f.interactions.list()).find((item) => item.status === 'pending')!;
      if (phase !== 'approval') {
        await f.interactions.reply(run.bot, run.id, approval.id, { kind: 'decision', allow: true });
        await waiting;
      }
      await projects.write({
        action: 'update',
        requestId: 'mock-project-revoke',
        projectId: project.projectId,
        expectedRevision: 1,
        value: { name: 'SYNTHETIC', grants: change === 'remove' ? [] : [{ bot: run.bot }] },
      });
      expect(() => projects.assertScope(run.bot, project, 'read')).toThrow(
        expect.objectContaining({ code: 'PROJECT_SCOPE_STALE' }),
      );
      release?.();
      const result = await pending;
      expect(effects).toBe(0);
      expect(result.isError).toBe(true);
      if (phase === 'receipt') {
        expect(JSON.stringify(result)).toContain('MCP_OUTCOME_UNKNOWN');
        expect(
          JSON.stringify(
            await integrations.invoke(run, f.alias, { value: 'SYNTHETIC' }, 'mock-project-wire'),
          ),
        ).toContain('MCP_OUTCOME_UNKNOWN');
      } else if (phase !== 'approval')
        expect(JSON.stringify(result)).toContain('PROJECT_SCOPE_STALE');
      expect(
        (await tools.invoke(run, f.alias, { value: 'SYNTHETIC' }, 'mock-project-wire')).isError,
      ).toBe(true);
      expect(effects).toBe(0);
    } finally {
      release?.();
      run.abort.abort();
      await integrations.close();
      await projects.close();
      await f.close();
    }
  },
);

test('external tools stay lazy and per-Bot; only a committed one-time decision permits dispatch, and exact retries read the receipt', async () => {
  const f = await fixture();
  try {
    expect(f.tools.list(f.run).length).toBe(1);
    expect(f.counts().factories).toBe(0);
    const pending = f.tools.invoke(f.run, f.alias, { value: '47' }, 'mock-wire-1');
    await ready(async () =>
      (await f.interactions.list()).some((item) => item.status === 'pending'),
    );
    const request = (await f.interactions.list())[0];
    expect(request.kind).toBe('approval');
    expect(f.counts().effects).toBe(0);
    expect(f.counts().factories).toBe(0);
    expect(JSON.stringify(request).includes('synthetic-bearer-secret')).toBe(false);
    await f.interactions.reply(f.run.bot, f.run.id, request.id, { kind: 'decision', allow: true });
    const result = await pending;
    expect(result.isError).toBe(false);
    expect.assert(JSON.stringify(result).includes('SYNTHETIC:47'));
    expect(f.counts().effects).toBe(1);
    expect(await f.tools.invoke(f.run, f.alias, { value: '47' }, 'mock-wire-1')).toStrictEqual(
      result,
    );
    expect(f.counts().effects).toBe(1);
    const other = {
      ...f.run,
      id: 'mock-other-run',
      bot: 'mock-b',
      integrations: await f.store.capture('mock-b'),
    };
    expect((await f.tools.invoke(other, f.alias, { value: '47' }, 'mock-other-wire')).isError).toBe(
      true,
    );
    expect(f.counts().effects).toBe(1);
  } finally {
    await f.close();
  }
});

test('refusal and disable revoke pending authority without connecting, while uncertain effects cannot replay under a new wire id', async () => {
  const f = await fixture();
  try {
    const denied = f.tools.invoke(f.run, f.alias, { value: 'denied' }, 'mock-denied');
    await ready(async () =>
      (await f.interactions.list()).some((item) => item.status === 'pending'),
    );
    const request = (await f.interactions.list()).find((item) => item.status === 'pending')!;
    await f.interactions.reply(f.run.bot, f.run.id, request.id, { kind: 'decision', allow: false });
    expect((await denied).isError).toBe(true);
    expect(f.counts().factories).toBe(0);
    f.setUnknown();
    const unknown = f.tools.invoke(f.run, f.alias, { value: 'unknown' }, 'mock-unknown');
    await ready(async () =>
      (await f.interactions.list()).some((item) => item.status === 'pending'),
    );
    const approval = (await f.interactions.list()).find((item) => item.status === 'pending')!;
    await f.interactions.reply(f.run.bot, f.run.id, approval.id, { kind: 'decision', allow: true });
    expect.assert(JSON.stringify(await unknown).includes('MCP_OUTCOME_UNKNOWN'));
    expect.assert(
      JSON.stringify(
        await f.tools.invoke(f.run, f.alias, { value: 'unknown' }, 'mock-retry-new-id'),
      ).includes('MCP_OUTCOME_UNKNOWN'),
    );
    expect(f.counts().effects).toBe(1);
    const stopped = f.tools.invoke(f.run, f.alias, { value: 'stop' }, 'mock-stop');
    await ready(async () =>
      (await f.interactions.list()).some((item) => item.status === 'pending'),
    );
    await f.store.bind(f.run.bot, {
      connection: 'mock-connection',
      configRevision: 1,
      bindingRevision: 1,
      tools: [],
      enabled: false,
    });
    expect((await stopped).isError).toBe(true);
    expect((await f.interactions.list()).filter((item) => item.status === 'pending').length).toBe(
      0,
    );
    expect(f.counts().effects).toBe(1);
  } finally {
    await f.close();
  }
});

test('catalog drift after approval cannot execute the old reviewed tool definition', async () => {
  const f = await fixture();
  try {
    f.setChanged();
    const pending = f.tools.invoke(f.run, f.alias, { value: '47' }, 'mock-drift');
    await ready(async () =>
      (await f.interactions.list()).some((item) => item.status === 'pending'),
    );
    const approval = (await f.interactions.list()).find((item) => item.status === 'pending')!;
    await f.interactions.reply(f.run.bot, f.run.id, approval.id, { kind: 'decision', allow: true });
    expect((await pending).isError).toBe(true);
    expect(f.counts().effects).toBe(0);
    expect((await f.store.capture(f.run.bot)).connections.length).toBe(0);
  } finally {
    await f.close();
  }
});

test('the granted MCP arguments are immutable while awaiting approval', async () => {
  const f = await fixture();
  try {
    const args = { value: 'mock-reviewed' };
    const pending = f.tools.invoke(f.run, f.alias, args, 'mock-immutable-call');
    await ready(async () =>
      (await f.interactions.list()).some((item) => item.status === 'pending'),
    );
    const card = (await f.interactions.list())[0];
    args.value = 'mock-changed';
    await f.interactions.reply(f.run.bot, f.run.id, card.id, { kind: 'decision', allow: true });
    expect(JSON.stringify(await pending)).toContain('SYNTHETIC:mock-reviewed');
    expect(f.counts().effects).toBe(1);
  } finally {
    await f.close();
  }
});

test('the final MCP send checks the original binding even if its change notification is delayed', async () => {
  let signalReady: () => unknown = () => undefined;
  let release: () => unknown = () => undefined;
  const readyToSend = new Promise<unknown>((resolve) => {
    signalReady = () => resolve(undefined);
  });
  const held = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const f = await fixture(undefined, async () => {
    signalReady();
    await held;
  });
  try {
    const pending = f.tools.invoke(
      f.run,
      f.alias,
      { value: 'mock-binding-race' },
      'mock-binding-race',
    );
    await ready(async () =>
      (await f.interactions.list()).some((item) => item.status === 'pending'),
    );
    const card = (await f.interactions.list())[0];
    await f.interactions.reply(f.run.bot, f.run.id, card.id, { kind: 'decision', allow: true });
    await readyToSend;
    const capture = f.run.integrations.connections[0];
    f.store.onChange = undefined;
    await f.store.bind(f.run.bot, {
      connection: capture.connection,
      configRevision: capture.revision,
      bindingRevision: capture.bindingRevision,
      catalogDigest: capture.catalogDigest,
      tools: ['synthetic_echo'],
      enabled: false,
    });
    release();
    expect(JSON.stringify(await pending)).toContain('MCP_AUTHORITY_CHANGED');
    expect(f.counts().effects).toBe(0);
  } finally {
    release();
    await f.close();
  }
});

test('shutdown waits for an aborted catalog probe to close its transport before returning', async () => {
  const f = await fixture();
  await f.tools.close();
  let started!: () => unknown;
  let finish!: () => unknown;
  const entered = new Promise<undefined>((resolve) => {
    started = () => resolve(undefined);
  });
  const release = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const tools = new IntegrationTools(f.store, f.interactions, {
    remote: async () => ({
      start: async (signal) => {
        started();
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('synthetic abort')), {
            once: true,
          });
        });
      },
      tools: async () => offered,
      call: async () => {
        throw new Error('Must never dispatch');
      },
      close: async () => {
        await release;
      },
    }),
  });
  const probe = tools.probe('mock-connection', 1).catch(() => {});
  try {
    await entered;
    let closed = false;
    const closing = tools.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(closed).toBe(false);
    finish();
    await closing;
    await probe;
    expect(closed).toBe(true);
  } finally {
    finish();
    await tools.close();
    await probe;
    await f.close();
  }
});

test('stopping a dispatched external call records uncertainty and leaves another Bot usable', async () => {
  const f = await fixture();
  await f.tools.close();
  const assignments = await f.store.assignments('mock-a');
  await f.store.bind('mock-b', {
    connection: 'mock-connection',
    configRevision: 1,
    bindingRevision: 0,
    catalogDigest: assignments.items[0].catalogDigest,
    tools: ['synthetic_echo'],
    enabled: true,
  });
  let effects = 0;
  let closed = 0;
  const tools = new IntegrationTools(f.store, f.interactions, {
    remote: async (_config, options) => ({
      start: async () => {},
      tools: async () => offered,
      call: async (_name, args, signal) => {
        await options.onDispatch?.();
        effects++;
        if (args.value === 'held')
          await new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('synthetic abort after effect')),
              { once: true },
            );
            if (signal.aborted) reject(new Error('synthetic early abort'));
          });
        return { content: [{ type: 'text', text: 'SYNTHETIC-OTHER-OK' }] };
      },
      close: async () => {
        closed++;
      },
    }),
  });
  try {
    const first = tools.invoke(f.run, f.alias, { value: 'held' }, 'mock-held-wire');
    await ready(async () =>
      (await f.interactions.list()).some((item) => item.status === 'pending'),
    );
    const approval = (await f.interactions.list()).find((item) => item.status === 'pending')!;
    await f.interactions.reply(f.run.bot, f.run.id, approval.id, { kind: 'decision', allow: true });
    await ready(async () => effects === 1);
    f.run.abort.abort();
    expect.assert(JSON.stringify(await first).includes('MCP_OUTCOME_UNKNOWN'));
    expect(closed).toBe(1);
    const other = {
      ...f.run,
      id: 'mock-other-run',
      bot: 'mock-b',
      sessionId: 'mock-other-session',
      abort: new AbortController(),
      integrations: await f.store.capture('mock-b'),
    };
    const second = tools.invoke(other, f.alias, { value: 'other' }, 'mock-other-wire');
    await ready(async () =>
      (await f.interactions.list()).some((item) => item.status === 'pending'),
    );
    const next = (await f.interactions.list()).find((item) => item.status === 'pending')!;
    await f.interactions.reply(other.bot, other.id, next.id, { kind: 'decision', allow: true });
    expect((await second).isError).toBe(false);
    expect(effects).toBe(2);
    expect(closed).toBe(2);
  } finally {
    f.run.abort.abort();
    await tools.close();
    await f.close();
  }
});
