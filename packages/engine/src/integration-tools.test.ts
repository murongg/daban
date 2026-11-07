import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { IntegrationTools } from './integration-tools.js';
import { Integrations } from './integrations.js';
import { Interactions } from './interactions.js';

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
async function fixture() {
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
  const tools = new IntegrationTools(store, interactions, {
    remote: async (_config, options) => {
      factories++;
      return {
        start: async () => {},
        tools: async () => (changed ? [{ ...offered[0], description: '合成目录已更新' }] : offered),
        call: async (_name, args) => {
          await options.onDispatch?.();
          effects++;
          if (unknown) throw new Error('synthetic lost reply');
          return { content: [{ type: 'text', text: `SYNTHETIC:${args.value}` }] };
        },
        close: async () => {},
      };
    },
  });
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

test('catalog probe logs only safe rejection facts without replacing the reviewed catalog or binding', async () => {
  const f = await fixture();
  await f.tools.close();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const tools = new IntegrationTools(f.store, f.interactions, {
    remote: async () => ({
      start: async () => {},
      tools: async () => [
        {
          ...offered[0],
          name: 'synthetic-private-tool',
          description: 'synthetic-private-description'.padEnd(2001, 'x'),
        },
      ],
      call: async () => {
        throw Error('SYNTHETIC_MUST_NOT_DISPATCH');
      },
      close: async () => {},
    }),
  });
  try {
    await expect(tools.probe('mock-connection', 1)).rejects.toMatchObject({
      code: 'INVALID_MCP_CATALOG',
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[mcp-catalog-rejected]',
      JSON.stringify({
        reason: 'description_length',
        path: 'tools[0].description',
        toolCount: 1,
        actual: 2001,
        limit: 2000,
      }),
    );
    const logged = JSON.stringify(warn.mock.calls);
    for (const value of [
      'synthetic-private-tool',
      'synthetic-private-description',
      'synthetic-bearer-secret',
      'synthetic-query-secret',
    ])
      expect(logged.includes(value)).toBe(false);
    expect((await f.store.capture(f.run.bot)).connections).toEqual(f.run.integrations.connections);
    expect((await f.store.list()).items[0]).toMatchObject({
      health: 'unavailable',
      error: 'INVALID_MCP_CATALOG',
    });
    expect(f.counts().effects).toBe(0);
  } finally {
    warn.mockRestore();
    await tools.close();
    await f.close();
  }
});

test.each(['INVALID_MCP_CATALOG', 'INVALID_MCP_JSON'])(
  'catalog probe never logs a remote error that impersonates a local %s diagnostic',
  async (code) => {
    const f = await fixture();
    await f.tools.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tools = new IntegrationTools(f.store, f.interactions, {
      remote: async () => ({
        start: async () => {},
        tools: async () => {
          throw Object.assign(Error('synthetic-private-error'), {
            code,
            diagnostic: { reason: 'synthetic-private-value' },
          });
        },
        call: async () => {
          throw Error('SYNTHETIC_MUST_NOT_DISPATCH');
        },
        close: async () => {},
      }),
    });
    try {
      await expect(tools.probe('mock-connection', 1)).rejects.toMatchObject({
        code,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await tools.close();
      await f.close();
    }
  },
);

test.each([
  { nesting: 15, stage: 'definition' },
  { nesting: 14, stage: 'catalog' },
])(
  'catalog probe logs only bounded $stage JSON facts and keeps reviewed authority',
  async ({ nesting, stage }) => {
    const f = await fixture();
    await f.tools.close();
    let nested: unknown = 'synthetic-private-value';
    for (let index = 0; index < nesting; index++) nested = { 'synthetic-private-key': nested };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tools = new IntegrationTools(f.store, f.interactions, {
      remote: async () => ({
        start: async () => {},
        tools: async () => [
          {
            ...offered[0],
            name: 'synthetic-private-tool',
            inputSchema: { type: 'object', 'synthetic-private-schema-key': nested },
          },
        ],
        call: async () => {
          throw Error('SYNTHETIC_MUST_NOT_DISPATCH');
        },
        close: async () => {},
      }),
    });
    try {
      await expect(tools.probe('mock-connection', 1)).rejects.toMatchObject({
        code: 'INVALID_MCP_JSON',
      });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toBe('[mcp-catalog-rejected]');
      const diagnostic: unknown = JSON.parse(String(warn.mock.calls[0][1]));
      expect(diagnostic).toMatchObject({
        reason: 'json_depth',
        stage,
        kind: 'string',
        depth: 17,
        limit: 16,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-bearer-secret');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-query-secret');
      expect((await f.store.capture(f.run.bot)).connections).toEqual(
        f.run.integrations.connections,
      );
      expect((await f.store.list()).items[0]).toMatchObject({
        health: 'unavailable',
        error: 'INVALID_MCP_JSON',
      });
      expect(f.counts().effects).toBe(0);
    } finally {
      warn.mockRestore();
      await tools.close();
      await f.close();
    }
  },
);

test.each([false, true])(
  'depth observation stays local to one rejected probe and preserves authority (limited=%s)',
  async (limited) => {
    const f = await fixture();
    await f.tools.close();
    let lists = 0,
      effects = 0;
    const definitions = [15, 20].map((depth, index) => {
      let nested: unknown = 'synthetic-private-leaf';
      for (let level = 0; level < depth; level++) nested = { 'synthetic-private-key': nested };
      return {
        ...offered[0],
        name: `synthetic-private-tool-${index}`,
        inputSchema: { type: 'object', 'synthetic-private-schema': nested },
      };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tools = new IntegrationTools(f.store, f.interactions, {
      remote: async () => ({
        start: async () => {},
        tools: async () => {
          lists++;
          return limited
            ? [
                ...definitions,
                {
                  ...offered[0],
                  name: 'synthetic-private-overflow',
                  inputSchema: { type: 'object', padding: 'x'.repeat(32768) },
                },
              ]
            : definitions;
        },
        call: async () => {
          effects++;
          throw Error('SYNTHETIC_MUST_NOT_DISPATCH');
        },
        close: async () => {},
      }),
    });
    try {
      await expect(tools.probe('mock-connection', 1)).rejects.toMatchObject({
        code: 'INVALID_MCP_JSON',
      });
      expect(warn).toHaveBeenCalledOnce();
      const diagnostic: unknown = JSON.parse(String(warn.mock.calls[0][1]));
      if (limited)
        expect(diagnostic).toMatchObject({
          reason: 'json_depth',
          depth: 17,
          limit: 16,
          measurement: {
            status: 'incomplete',
            stopCode: 'MCP_CATALOG_LIMIT',
            stop: { kind: 'definition_bytes', toolOffset: 2, fragmentBasis: 'minimum' },
          },
        });
      else
        expect(diagnostic).toMatchObject({
          reason: 'json_depth',
          depth: 17,
          limit: 16,
          measurement: {
            status: 'complete',
            toolCount: 2,
            schemaDepth: 21,
            definitionDepth: 22,
            catalogDepth: 23,
          },
        });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private');
      expect(
        (await f.store.catalogView('mock-connection')).tools.map((entry) => entry.name),
      ).toEqual(['synthetic_echo']);
      expect((await f.store.capture(f.run.bot)).connections).toEqual(
        f.run.integrations.connections,
      );
      expect(lists).toBe(1);
      expect(effects).toBe(0);
    } finally {
      warn.mockRestore();
      await tools.close();
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
