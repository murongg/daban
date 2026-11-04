import { createHash } from 'node:crypto';
import {
  isPreflightReport,
  type PreflightQuery,
  preflightJson,
  preflightReportData,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { Fault } from './control.js';
import {
  Preflight,
  type PreflightMcp,
  type PreflightModel,
  type PreflightProfile,
  type PreflightRuntime,
  type PreflightSources,
} from './preflight.js';

const alias = 'ext_0123456789abcdef0123';
const digest = 'a'.repeat(64);
function deferred() {
  let resolve: () => unknown = () => undefined;
  const promise = new Promise<undefined>((done) => {
    resolve = () => done(undefined);
  });
  return { promise, resolve: () => resolve() };
}
function fixture() {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const profile: PreflightProfile = { revision: 1 };
  const model: PreflightModel = {
    revision: 1,
    configured: true,
    defaultModel: 'mock-model',
    searchConfigured: false,
    models: [{ id: 'mock-model', vision: true, contextWindow: 16000, maxTokens: 1000 }],
  };
  const mcp: PreflightMcp = {
    revision: 1,
    connections: [
      {
        id: 'mock-connection',
        revision: 1,
        bindingRevision: 1,
        enabled: true,
        available: true,
        label: 'SYNTHETIC-PRIVATE',
        digest,
        bindingDigest: digest,
        tools: [{ alias, label: 'SYNTHETIC-PRIVATE', selected: true }],
      },
    ],
  };
  const runtime: PreflightRuntime = {
    supported: false,
    connected: false,
    identity: null,
    documents: false,
  };
  let allowed = true;
  let scope = 'mock-workspace';
  const calls = { model: 0, runtime: 0, local: 0, mcp: 0 };
  const sources: PreflightSources = {
    scope: () => scope,
    authorize: async () => {
      if (!allowed) throw new Fault('BOT_ARCHIVED');
      return structuredClone(profile);
    },
    model: async () => {
      calls.model++;
      return structuredClone(model);
    },
    mcp: async () => {
      calls.mcp++;
      return structuredClone(mcp);
    },
    runtime: async () => {
      calls.runtime++;
      return structuredClone(runtime);
    },
    local: async () => {
      calls.local++;
      return {
        platform: 'darwin',
        available: true,
        shortcut: true,
        permissions: { screen: true, accessibility: true },
        session: {
          id: 'mock-session',
          bot: 'mock-bot',
          revision: 1,
          owner: 'agent',
          model: 'mock-model',
          modelRevision: 1,
        },
      };
    },
  };
  const owner = new Preflight(sources, { now: () => now, sourceTimeout: 20, totalTimeout: 40 });
  const query: PreflightQuery = {
    id: 'mock-query',
    bot: 'mock-bot',
    requirements: [{ kind: 'model', vision: false, tools: false }],
  };
  return {
    owner,
    query,
    sources,
    calls,
    model,
    profile,
    runtime,
    mcp,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      allowed = false;
    },
    move: () => {
      scope = 'mock-other';
    },
  };
}

test('model facts stay independent from an absent VM and distinguish unknown, false and input budget', async () => {
  const f = fixture();
  const ready = await f.owner.inspect(f.query);
  expect(isPreflightReport(ready)).toBe(true);
  expect(ready.checks[0]).toMatchObject({ state: 'ready', evidence: 'local-config' });
  expect(ready.externalProbe).toBe('not-run');
  expect(f.calls.runtime + f.calls.local + f.calls.mcp).toBe(0);
  expect(ready.digest).toBe(
    createHash('sha256')
      .update(preflightJson(preflightReportData(ready)))
      .digest('hex'),
  );
  const check = (id: string, tools = true, minContextTokens?: number) =>
    f.owner.inspect({
      ...f.query,
      id,
      requirements: [
        {
          kind: 'model',
          vision: true,
          tools,
          ...(minContextTokens === undefined ? {} : { minContextTokens }),
        },
      ],
    });
  expect((await check('mock-unknown')).checks[0]).toMatchObject({
    state: 'unknown',
    reason: 'MODEL_CAPABILITY_UNKNOWN',
  });
  f.model.models[0].toolCall = false;
  expect((await check('mock-false')).checks[0]).toMatchObject({
    state: 'missing',
    reason: 'MODEL_CAPABILITY_MISSING',
  });
  expect((await check('mock-budget', false, 15001)).checks[0].reason).toBe(
    'INPUT_BUDGET_TOO_SMALL',
  );
  f.model.models[0].vision = false;
  expect((await check('mock-vision', false)).checks[0].reason).toBe('MODEL_CAPABILITY_MISSING');
});

test('safe MCP options and inspections bind exact aliases and reject guessed private connections', async () => {
  const f = fixture();
  const page = await f.owner.options({ bot: f.query.bot });
  expect(page.items).toEqual([
    {
      connection: 'mock-connection',
      catalogDigest: digest,
      tool: alias,
      connectionLabel: 'SYNTHETIC-PRIVATE',
      toolLabel: 'SYNTHETIC-PRIVATE',
    },
  ]);
  const query: PreflightQuery = {
    ...f.query,
    requirements: [
      { kind: 'mcp', connection: 'mock-connection', catalogDigest: digest, tool: alias },
    ],
  };
  expect((await f.owner.inspect(query)).checks[0].state).toBe('ready');
  f.mcp.connections[0].digest = 'b'.repeat(64);
  expect((await f.owner.inspect({ ...query, id: 'mock-stale' })).checks[0]).toMatchObject({
    state: 'stale',
    reason: 'MCP_CATALOG_STALE',
  });
  f.mcp.connections[0].enabled = false;
  expect((await f.owner.inspect({ ...query, id: 'mock-unselected' })).checks[0].reason).toBe(
    'MCP_NOT_SELECTED',
  );
  await expect(
    f.owner.inspect({
      ...query,
      id: 'mock-private',
      requirements: [
        { kind: 'mcp', connection: 'mock-private', catalogDigest: digest, tool: alias },
      ],
    }),
  ).rejects.toMatchObject({ code: 'PREFLIGHT_NOT_AUTHORIZED' });
});

test('MCP pagination is stable, bounded to500, and invalidates cursors after authorization changes', async () => {
  const f = fixture();
  f.mcp.connections[0].tools = Array.from({ length: 501 }, (_, i) => ({
    alias: `ext_${i.toString(16).padStart(20, '0')}`,
    label: `mock-${i}`,
    selected: true,
  }));
  const first = await f.owner.options({ bot: f.query.bot });
  expect(first.items).toHaveLength(50);
  expect(first.truncated).toBe(true);
  expect(first.next).toBeTruthy();
  const second = await f.owner.options({ bot: f.query.bot, cursor: first.next });
  expect(second.items[0].tool).not.toBe(first.items[0].tool);
  f.mcp.revision++;
  await expect(f.owner.options({ bot: f.query.bot, cursor: first.next })).rejects.toMatchObject({
    code: 'PREFLIGHT_OPTIONS_STALE',
  });
  f.revoke();
  await expect(f.owner.options({ bot: f.query.bot })).rejects.toMatchObject({
    code: 'BOT_ARCHIVED',
  });
});

test('local computer needs the exact Bot, model revision, permissions and control owner', async () => {
  const f = fixture();
  const local = await f.sources.local();
  f.sources.local = async () => structuredClone(local);
  const query: PreflightQuery = {
    ...f.query,
    requirements: [{ kind: 'computer', mode: 'local', access: 'control' }],
  };
  expect((await f.owner.inspect(query)).checks[0].state).toBe('ready');
  local.session!.bot = 'mock-other';
  expect((await f.owner.inspect({ ...query, id: 'mock-other-bot' })).checks[0].reason).toBe(
    'LOCAL_SESSION_MISMATCH',
  );
  local.session!.bot = query.bot;
  local.session!.modelRevision = 0;
  expect((await f.owner.inspect({ ...query, id: 'mock-revision' })).checks[0].reason).toBe(
    'LOCAL_SESSION_MISMATCH',
  );
  local.session!.modelRevision = 1;
  local.session!.owner = 'human';
  expect((await f.owner.inspect({ ...query, id: 'mock-human' })).checks[0].reason).toBe(
    'CONTROL_HELD_BY_HUMAN',
  );
  local.permissions.screen = false;
  expect((await f.owner.inspect({ ...query, id: 'mock-permission' })).checks[0].reason).toBe(
    'LOCAL_PERMISSION_MISSING',
  );
});

test('search is a saved configuration fact, Office requires declared execution support', async () => {
  const f = fixture();
  const query: PreflightQuery = {
    ...f.query,
    requirements: [
      { kind: 'search' },
      { kind: 'office' },
      { kind: 'computer', mode: 'linux', access: 'control' },
    ],
  };
  const missing = await f.owner.inspect(query);
  expect(missing.checks.map((row) => row.state)).toEqual(['missing', 'unsupported', 'unsupported']);
  f.model.searchConfigured = true;
  Object.assign(f.runtime, {
    supported: true,
    connected: true,
    identity: 'mock-boot',
    documents: true,
    computer: { connected: true, revision: 1, owner: 'human' },
  });
  expect(
    (await f.owner.inspect({ ...query, id: 'mock-supported' })).checks.map((row) => row.state),
  ).toEqual(['ready', 'ready', 'missing']);
});

test('same query single-flights, conflicting content rejects, and hanging sources do not multiply', async () => {
  const f = fixture();
  let release: (value: PreflightModel) => unknown = () => undefined;
  f.sources.model = () => {
    f.calls.model++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const reports = await Promise.all([f.owner.inspect(f.query), f.owner.inspect(f.query)]);
  expect(f.calls.model).toBe(1);
  expect(reports[0]).toEqual(reports[1]);
  expect(reports[0].checks[0]).toMatchObject({ state: 'unknown', reason: 'CHECK_TIMED_OUT' });
  await expect(
    f.owner.inspect({ ...f.query, requirements: [{ kind: 'search' }] }),
  ).rejects.toMatchObject({ code: 'PREFLIGHT_ID_REUSED' });
  await f.owner.inspect({ ...f.query, id: 'mock-hung-again' });
  expect(f.calls.model).toBe(1);
  release(f.model);
});

test('mid-check configuration changes mark affected requirements stale without leaking source exceptions', async () => {
  const f = fixture();
  let reads = 0;
  f.sources.model = async () => ({ ...structuredClone(f.model), revision: ++reads });
  const report = await f.owner.inspect(f.query);
  expect(report.checks[0]).toMatchObject({ state: 'stale', reason: 'CONFIG_CHANGED' });
  f.sources.model = async () => {
    throw Error('SYNTHETIC-PRIVATE-EXCEPTION');
  };
  const unavailable = await f.owner.inspect({ ...f.query, id: 'mock-damaged' });
  expect(unavailable.checks[0]).toMatchObject({ state: 'unknown', reason: 'OWNER_UNAVAILABLE' });
  expect(JSON.stringify(unavailable)).not.toContain('SYNTHETIC-PRIVATE');
});

test('preview freezes exact whitelist bytes and export revalidates ownership, expiry and current source', async () => {
  const f = fixture();
  const report = await f.owner.inspect(f.query);
  const read = { id: report.id, digest: report.digest };
  await expect(f.owner.preview(read, true)).rejects.toMatchObject({
    code: 'PREFLIGHT_PREVIEW_REQUIRED',
  });
  const [first, second] = await Promise.all([f.owner.preview(read), f.owner.preview(read)]);
  expect(first).toEqual(second);
  f.advance(31000);
  expect(await f.owner.preview(read, true)).toEqual(first);
  expect(first.json).not.toContain(f.query.bot);
  expect(first.json).not.toContain('mock-workspace');
  expect(first.packageDigest).toBe(createHash('sha256').update(first.json).digest('hex'));
  f.model.revision++;
  await expect(f.owner.preview(read, true)).rejects.toMatchObject({
    code: 'PREFLIGHT_AUTHORITY_CHANGED',
  });
  f.model.revision--;
  f.move();
  await expect(f.owner.preview(read)).rejects.toMatchObject({ code: 'PREFLIGHT_REPORT_EXPIRED' });
  f.advance(300000);
  await expect(f.owner.preview(read)).rejects.toMatchObject({ code: 'PREFLIGHT_REPORT_EXPIRED' });
});

test('report retention is bounded and never evicts a still previewable snapshot', async () => {
  const f = fixture();
  const owner = new Preflight(f.sources, { reportLimit: 1 });
  const report = await owner.inspect(f.query);
  await owner.preview({ id: report.id, digest: report.digest });
  await expect(owner.inspect({ ...f.query, id: 'mock-over-limit' })).rejects.toMatchObject({
    code: 'PREFLIGHT_LIMIT',
  });
  expect((await owner.preview({ id: report.id, digest: report.digest }, true)).id).toBe(report.id);
  f.revoke();
  await expect(owner.inspect(f.query)).rejects.toMatchObject({ code: 'BOT_ARCHIVED' });
});

test('trusted local status transport failure is unknown, distinct from unsupported platform', async () => {
  const f = fixture();
  f.sources.local = async () => ({
    platform: 'unsupported',
    available: false,
    shortcut: false,
    permissions: { screen: false, accessibility: false },
    error: 'LOCAL_CLIENT_UNAVAILABLE',
  });
  const report = await f.owner.inspect({
    ...f.query,
    requirements: [{ kind: 'computer', mode: 'local', access: 'observe' }],
  });
  expect(report.checks[0]).toMatchObject({ state: 'unknown', reason: 'OWNER_UNAVAILABLE' });
});

test('evidence records the initial source sampling time rather than the later report assembly time', async () => {
  const f = fixture();
  f.sources.model = async () => {
    f.advance(1000);
    return structuredClone(f.model);
  };
  const report = await f.owner.inspect({ ...f.query, requirements: [{ kind: 'search' }] });
  expect(report.checks[0].observedAt).toBe('2026-01-01T00:00:01.000Z');
  expect(report.checkedAt).toBe('2026-01-01T00:00:02.000Z');
});

test('all report deadlines derive from one captured millisecond even while the clock advances', async () => {
  const f = fixture();
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const owner = new Preflight(f.sources, { now: () => clock++ });
  const report = await owner.inspect(f.query);
  expect(Date.parse(report.freshUntil) - Date.parse(report.checkedAt)).toBe(30000);
  expect(Date.parse(report.expiresAt) - Date.parse(report.checkedAt)).toBe(300000);
});

test('export rechecks Bot authorization after a deferred source read', async () => {
  const f = fixture();
  const report = await f.owner.inspect(f.query);
  const read = { id: report.id, digest: report.digest };
  await f.owner.preview(read);
  let release: () => unknown = () => undefined;
  let entered: () => unknown = () => undefined;
  const waiting = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const started = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  f.sources.model = async () => {
    entered();
    await waiting;
    return structuredClone(f.model);
  };
  const exported = f.owner.preview(read, true);
  await started;
  f.revoke();
  release();
  await expect(exported).rejects.toMatchObject({ code: 'BOT_ARCHIVED' });
});

test('failed options still recheck the original Bot and data scope before publishing', async () => {
  const f = fixture();
  f.sources.mcp = async () => {
    f.revoke();
    throw Error('SYNTHETIC-PRIVATE');
  };
  await expect(f.owner.options({ bot: f.query.bot })).rejects.toMatchObject({
    code: 'BOT_ARCHIVED',
  });
});

test('optional owner clone errors are isolated as unknown without exposing the malformed owner', async () => {
  const f = fixture();
  f.sources.model = async () =>
    Object.assign(structuredClone(f.model), { secret: () => 'SYNTHETIC-PRIVATE' });
  const report = await f.owner.inspect(f.query);
  expect(report.checks[0]).toMatchObject({ state: 'unknown', reason: 'OWNER_UNAVAILABLE' });
  expect(JSON.stringify(report)).not.toContain('SYNTHETIC-PRIVATE');
});

test('a damaged computer store does not hide independent Office execution capability', async () => {
  const f = fixture();
  Object.assign(f.runtime, {
    supported: true,
    connected: true,
    identity: 'mock-boot',
    documents: true,
    computer: { available: false, connected: false, revision: 1 },
  });
  const report = await f.owner.inspect({
    ...f.query,
    requirements: [{ kind: 'office' }, { kind: 'computer', mode: 'linux', access: 'observe' }],
  });
  expect(report.checks.map((check) => [check.state, check.reason])).toEqual([
    ['ready', 'CONFIG_PRESENT'],
    ['unknown', 'OWNER_UNAVAILABLE'],
  ]);
});

test('an already archived report owner is rejected before reading other sources', async () => {
  const f = fixture();
  const report = await f.owner.inspect(f.query);
  const before = f.calls.model;
  f.revoke();
  await expect(f.owner.preview({ id: report.id, digest: report.digest })).rejects.toMatchObject({
    code: 'BOT_ARCHIVED',
  });
  expect(f.calls.model).toBe(before);
});

test('a known configuration race during an owner projection is stale rather than a storage outage', async () => {
  const f = fixture();
  f.sources.mcp = async () => {
    throw new Fault('PREFLIGHT_SOURCE_CHANGED');
  };
  const report = await f.owner.inspect({
    ...f.query,
    requirements: [
      { kind: 'mcp', connection: 'mock-connection', catalogDigest: digest, tool: alias },
    ],
  });
  expect(report.checks[0]).toMatchObject({ state: 'stale', reason: 'CONFIG_CHANGED' });
});

test('unresolved dynamic sources have a fixed ceiling across repeated Bot identities', async () => {
  const f = fixture();
  const releases: (() => unknown)[] = [];
  f.sources.authorize = async () =>
    new Promise<PreflightProfile>((resolve) => {
      releases.push(() => resolve(f.profile));
    });
  const requests = Array.from({ length: 257 }, (_, index) =>
    f.owner.inspect({ ...f.query, bot: `mock-${index}`, id: `mock-${index}` }),
  );
  const result = await Promise.allSettled(requests);
  expect(result.every((row) => row.status === 'rejected')).toBe(true);
  expect(releases.length).toBeLessThanOrEqual(256);
  for (const release of releases) release();
  f.owner.close();
});

test('unavailable options pages obey the same total byte budget as successful pages', async () => {
  const f = fixture();
  f.sources.mcp = async () => {
    throw Error('SYNTHETIC-UNAVAILABLE');
  };
  const owner = new Preflight(f.sources, { totalBytes: 1 });
  await expect(owner.options({ bot: f.query.bot })).rejects.toMatchObject({
    code: 'PREFLIGHT_LIMIT',
  });
});

test.each(['archive', 'profile', 'scope', 'tools'] as const)(
  'options reject %s changes while the final MCP read is pending',
  async (change) => {
    const f = fixture();
    let release: () => unknown = () => undefined;
    let entered: () => unknown = () => undefined;
    const waiting = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    const started = new Promise<undefined>((resolve) => {
      entered = () => resolve(undefined);
    });
    const read = f.sources.mcp;
    let reads = 0;
    f.sources.mcp = async (bot) => {
      if (++reads === 2) {
        entered();
        await waiting;
      }
      return read(bot);
    };
    const result = f.owner.options({ bot: f.query.bot });
    await started;
    if (change === 'archive') f.revoke();
    if (change === 'profile') f.profile.revision++;
    if (change === 'scope') f.move();
    if (change === 'tools') {
      f.mcp.connections[0].enabled = false;
      f.mcp.revision++;
    }
    release();
    await expect(result).rejects.toMatchObject({
      code: change === 'archive' ? 'BOT_ARCHIVED' : 'PREFLIGHT_OPTIONS_STALE',
    });
    expect(reads).toBe(2);
    expect(f.calls.model + f.calls.runtime + f.calls.local).toBe(0);
  },
);

test.each(['timeout', 'error', 'source-change'] as const)(
  'a second model observation reports %s without inventing a revision change',
  async (failure) => {
    const f = fixture();
    let reads = 0;
    f.sources.model = async () => {
      if (++reads === 1) return structuredClone(f.model);
      if (failure === 'timeout') return new Promise<PreflightModel>(() => {});
      if (failure === 'source-change') throw new Fault('PREFLIGHT_SOURCE_CHANGED');
      throw Error('SYNTHETIC-PRIVATE-SECOND-READ');
    };
    try {
      const report = await f.owner.inspect({
        ...f.query,
        requirements: [
          { kind: 'model', vision: false, tools: false },
          { kind: 'search' },
          { kind: 'office' },
        ],
      });
      const expected = {
        state: failure === 'source-change' ? 'stale' : 'unknown',
        reason:
          failure === 'timeout'
            ? 'CHECK_TIMED_OUT'
            : failure === 'source-change'
              ? 'CONFIG_CHANGED'
              : 'OWNER_UNAVAILABLE',
        evidence: 'unavailable',
      };
      expect(report.checks[0]).toMatchObject(expected);
      expect(report.checks[1]).toMatchObject(expected);
      expect(report.checks[2]).toMatchObject({
        state: 'unsupported',
        reason: 'CAPABILITY_UNSUPPORTED',
      });
      expect(report.externalProbe).toBe('not-run');
      expect(JSON.stringify(report)).not.toContain('SYNTHETIC-PRIVATE');
    } finally {
      f.owner.close();
    }
  },
);

test('a trusted local transport failure on the second observation remains unknown', async () => {
  const f = fixture();
  const read = f.sources.local;
  let reads = 0;
  f.sources.local = async () =>
    ++reads === 1
      ? read()
      : {
          platform: 'unsupported',
          available: false,
          permissions: { screen: false, accessibility: false },
          shortcut: false,
          error: 'LOCAL_CLIENT_UNAVAILABLE',
        };
  const report = await f.owner.inspect({
    ...f.query,
    requirements: [{ kind: 'computer', mode: 'local', access: 'observe' }],
  });
  expect(report.checks[0]).toMatchObject({
    state: 'unknown',
    reason: 'OWNER_UNAVAILABLE',
    evidence: 'unavailable',
  });
});

test.each(['unchanged', 'model', 'archive'] as const)(
  'a deferred second model observation respects the %s profile at completion',
  async (change) => {
    const f = fixture();
    const entered = deferred(),
      gate = deferred();
    const read = f.sources.model;
    let reads = 0;
    f.model.models.push({ id: 'mock-new', vision: false, contextWindow: 16000, maxTokens: 1000 });
    f.sources.model = async () => {
      if (++reads === 2) {
        entered.resolve();
        await gate.promise;
      }
      return read();
    };
    const result = f.owner.inspect({
      ...f.query,
      requirements: [{ kind: 'model', vision: true, tools: false }],
    });
    await entered.promise;
    if (change === 'model') {
      f.profile.revision++;
      f.profile.model = 'mock-new';
    }
    if (change === 'archive') f.revoke();
    gate.resolve();
    if (change === 'archive') {
      await expect(result).rejects.toMatchObject({ code: 'BOT_ARCHIVED' });
    } else {
      const report = await result;
      expect(report.checks[0]).toMatchObject({
        state: change === 'model' ? 'stale' : 'ready',
        reason: change === 'model' ? 'CONFIG_CHANGED' : 'CONFIG_PRESENT',
      });
      expect(report.summary).toBe(change === 'model' ? 'attention' : 'ready');
    }
    expect(reads).toBe(2);
    expect(f.calls.mcp + f.calls.local + f.calls.runtime).toBe(0);
  },
);

test('the last authorization cannot publish a report made with an older profile', async () => {
  const f = fixture();
  const authorize = f.sources.authorize;
  let reads = 0;
  f.model.models.push({ id: 'mock-new', vision: false, contextWindow: 16000, maxTokens: 1000 });
  f.sources.authorize = async (bot) => {
    if (++reads === 3) {
      f.profile.revision++;
      f.profile.model = 'mock-new';
    }
    return authorize(bot);
  };
  const query: PreflightQuery = {
    ...f.query,
    requirements: [{ kind: 'model', vision: true, tools: false }],
  };
  await expect(f.owner.inspect(query)).rejects.toMatchObject({
    code: 'PREFLIGHT_AUTHORITY_CHANGED',
  });
  await expect(f.owner.inspect(query)).rejects.toMatchObject({
    code: 'PREFLIGHT_AUTHORITY_CHANGED',
  });
});

test('a late profile change does not relabel a timed-out source as ready or a config fact', async () => {
  const f = fixture();
  const entered = deferred(),
    gate = deferred();
  const read = f.sources.model;
  let reads = 0;
  f.sources.model = async () => {
    if (++reads === 2) {
      entered.resolve();
      await gate.promise;
    }
    return read();
  };
  const result = f.owner.inspect(f.query);
  await entered.promise;
  f.profile.revision++;
  try {
    const report = await result;
    expect(report.checks[0]).toMatchObject({
      state: 'unknown',
      reason: 'CHECK_TIMED_OUT',
      evidence: 'unavailable',
    });
    expect(report.summary).toBe('attention');
    expect(reads).toBe(2);
  } finally {
    gate.resolve();
    f.owner.close();
  }
});
