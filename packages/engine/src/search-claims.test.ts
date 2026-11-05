import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultBudgetPolicy } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { observeTools } from './events.js';
import { ModelRuns } from './model.js';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';

async function fixture(limit = 3, local = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-search-claims-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.save({ apiKey: 'synthetic-model-key' });
  const supplier = vi.fn(async () => ({
    sources: [{ url: 'https://source.example.test/exact' }],
    truncated: false,
  }));
  const search = new SearchSettings(path.join(root, 'search.json'), settings, { query: supplier });
  await search.configure({
    requestId: 'synthetic-search-settings',
    revision: 0,
    enabled: true,
    provider: 'brave',
    key: 'synthetic-search-key',
  });
  let enter = () => {};
  let release = () => {};
  const ready = new Promise<undefined>((resolve) => {
    enter = () => resolve(undefined);
  });
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  class Harness {
    async start() {}
    async close() {
      release();
    }
    session(id = 'synthetic-root') {
      return {
        id,
        run: async () => {
          enter();
          await gate;
          return { sessionId: id, finalResponse: 'SYNTHETIC RESULT' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    search,
    Harness,
    dir: path.join(root, 'models'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  });
  await models.ready;
  if (local) vi.spyOn(models.tools, 'localSelected').mockReturnValue(true);
  models.budgets.configure(
    0,
    { ...defaultBudgetPolicy, toolLimit: limit },
    [],
    'synthetic-budget-policy',
  );
  await models.startHuman('mock-bot', {
    requestId: 'synthetic-search-task',
    prompt: 'Synthetic research.',
  });
  await ready;
  const job = models.jobs.get('mock-bot')!;
  const auth = `Bearer ${job.token}`;
  let rpcId = 0;
  const rpc = (method: string, params: Record<string, unknown>) =>
    models.rpc(job.bot, auth, { id: `synthetic-rpc-${++rpcId}`, method, params });
  const claim = (
    id = 'synthetic-execution',
    declaration: unknown = { executionSessionId: job.sessionId, queries: ['synthetic query'] },
  ) =>
    rpc('budget.tool', {
      scope: job.budget,
      modelAttemptId: job.attemptId,
      sessionId: job.sessionId,
      callId: id,
      ...(declaration === null ? {} : { search: declaration }),
    });
  const receipt = async (id?: string, queries?: string[]) => {
    const result = await claim(id, {
      executionSessionId: job.sessionId,
      queries: queries || ['synthetic query'],
    });
    expect(result).toMatchObject({
      result: { accepted: true, searchReceipt: { claimId: expect.any(String) } },
    });
    return (result as { result: { searchReceipt: { claimId: string } } }).result.searchReceipt
      .claimId;
  };
  const query = (claimId: string, text = 'synthetic query') =>
    rpc('search.query', { claimId, query: text });
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    release();
    await job.done;
    await models.close();
    closed = true;
  };
  return {
    root,
    settings,
    shutdown,
    models,
    search,
    job,
    supplier,
    claim,
    receipt,
    query,
    rpc,
    async close() {
      await shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('search dispatch requires its original persisted execution and one contribution despite RPC replay', async () => {
  const f = await fixture();
  try {
    const id = await f.receipt();
    expect(f.models.budgets.tools(f.job.budget!.budgetId)).toBe(1);
    expect(f.job.toolCount).toBe(1);
    expect((await f.models.journal.read(f.job.bot, f.job.id))?.toolCount).toBe(1);
    expect(await f.query(id)).toMatchObject({
      result: { sources: [{ url: 'https://source.example.test/exact' }] },
    });
    await f.query(id);
    expect(f.supplier).toHaveBeenCalledTimes(1);
    expect(f.job.fence).toBe('tool');
    expect(f.job.toolCount).toBe(1);
  } finally {
    await f.close();
  }
});

test('Host restart preserves consumption and unknown recovery fences but invalidates old search permissions', async () => {
  const f = await fixture();
  try {
    const id = await f.receipt();
    f.supplier.mockRejectedValue(new Error('SYNTHETIC_UNKNOWN_RESULT'));
    await f.query(id);
    const auth = `Bearer ${f.job.token}`;
    await f.shutdown();
    const settings = new ModelSettings(f.settings.file);
    const search = new SearchSettings(f.search.file, settings, { query: f.supplier });
    const restarted = new ModelRuns({
      settings,
      search,
      dir: path.join(f.root, 'models'),
      workspace: path.join(f.root, 'workspace'),
      origin: 'http://127.0.0.1:12345',
    });
    try {
      await restarted.ready;
      expect(restarted.budgets.tools(f.job.budget!.budgetId)).toBe(1);
      expect((await restarted.journal.recovery(f.job.bot, f.job.id))?.blocked).toBe(true);
      await expect(
        restarted.rpc(f.job.bot, auth, {
          id: 'synthetic-old-query',
          method: 'search.query',
          params: { claimId: id, query: 'synthetic query' },
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(f.supplier).toHaveBeenCalledTimes(1);
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});

test('ordinary and search declarations cannot rebind the same claim, including an orphaned durable row', async () => {
  const f = await fixture();
  try {
    await f.claim('synthetic-ordinary', null);
    await expect(f.claim('synthetic-ordinary')).rejects.toMatchObject({
      code: 'INVALID_BUDGET_TOOL',
    });
    const id = createHash('sha256')
      .update(JSON.stringify([f.job.budget!.budgetId, f.job.attemptId, 'synthetic-orphan']))
      .digest('hex');
    f.models.budgets.tool(f.job.budget!, id);
    await expect(f.claim('synthetic-orphan')).rejects.toMatchObject({
      code: 'INVALID_BUDGET_TOOL',
    });
    expect(f.supplier).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('the last admitted tool batch completes declared queries and the next execution is refused', async () => {
  const f = await fixture(1);
  try {
    const id = await f.receipt('synthetic-last', ['synthetic first', 'synthetic second']);
    expect(await f.query(id, 'synthetic first')).toHaveProperty('result');
    expect(await f.query(id, 'synthetic second')).toHaveProperty('result');
    await expect(f.claim('synthetic-excess')).rejects.toThrow();
    expect(f.models.budgets.tools(f.job.budget!.budgetId)).toBe(1);
    expect(f.supplier).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

test('search receipts wait for contribution durability and retain failed publication without an effect', async () => {
  const f = await fixture();
  try {
    const original = f.models.journal.put.bind(f.models.journal);
    vi.spyOn(f.models.journal, 'put').mockImplementation(async (record) => {
      if (record.toolCount === 1) throw new Error('SYNTHETIC_CONTRIBUTION_FAILURE');
      return original(record);
    });
    await expect(f.claim()).rejects.toThrow();
    expect(f.models.budgets.tools(f.job.budget!.budgetId)).toBe(1);
    await expect(f.claim()).rejects.toThrow();
    expect(f.job.toolCount).toBe(1);
    expect(f.supplier).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  } finally {
    await f.close();
  }
});

test('retired search authority cannot publish a cached result and run history stores only this contribution', async () => {
  const f = await fixture(6);
  try {
    f.job.activityBase = { toolCount: 3, activeMs: 0 };
    f.job.toolCount = 3;
    const id = await f.receipt();
    expect((await f.models.journal.read(f.job.bot, f.job.id))?.toolCount).toBe(1);
    await f.query(id);
    f.job.token = 'synthetic-replaced-token';
    await expect(f.query(id)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.supplier).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test('a guessed claim hash cannot use a failed contribution barrier to dispatch', async () => {
  const f = await fixture();
  try {
    let failed = false;
    const original = f.models.journal.put.bind(f.models.journal);
    vi.spyOn(f.models.journal, 'put').mockImplementation(async (record) => {
      if (record.toolCount === 1 && !failed) {
        failed = true;
        throw new Error('SYNTHETIC_FIRST_WRITE_FAILURE');
      }
      return original(record);
    });
    await expect(f.claim()).rejects.toThrow();
    const id = createHash('sha256')
      .update(JSON.stringify([f.job.budget!.budgetId, f.job.attemptId, 'synthetic-execution']))
      .digest('hex');
    expect(await f.query(id)).toHaveProperty('error');
    expect(f.supplier).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  } finally {
    await f.close();
  }
});

test('current ledger revision gates a previously admitted search without another debit', async () => {
  const f = await fixture();
  try {
    const id = await f.receipt();
    const view = f.models.budgets.view(f.job.budget!.budgetId);
    f.models.budgets.increase(
      view.scope.budgetId,
      view.scope.revision,
      { ...view.policy, toolLimit: 4 },
      'synthetic-increase',
    );
    expect(await f.query(id)).toHaveProperty('error');
    expect(f.supplier).not.toHaveBeenCalled();
    expect(f.models.budgets.tools(view.scope.budgetId)).toBe(1);
  } finally {
    await f.close();
  }
});

test.each(['success', 'failure'] as const)(
  'a retired execution cannot be revived by supplier %s',
  async (outcome) => {
    const f = await fixture();
    try {
      const id = await f.receipt();
      let release = () => {};
      let enter = () => {};
      const entered = new Promise<undefined>((resolve) => {
        enter = () => resolve(undefined);
      });
      const gate = new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
      f.supplier.mockImplementation(async () => {
        enter();
        await gate;
        if (outcome === 'failure') throw new Error('SYNTHETIC_LOST_RESULT');
        return { sources: [], truncated: false };
      });
      const result = f.query(id);
      await entered;
      f.job.attemptId = 'synthetic-retired-attempt';
      const before = JSON.stringify(f.job.trace);
      release();
      expect(await result).toHaveProperty('error');
      expect(JSON.stringify(f.job.trace)).toBe(before);
      expect(f.supplier).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  },
);

test('unknown search results stay consumed across new RPC identities and block clean recovery', async () => {
  const f = await fixture();
  try {
    const id = await f.receipt();
    f.supplier.mockRejectedValue(new Error('SYNTHETIC_UNKNOWN_RESULT'));
    expect(await f.query(id)).toHaveProperty('error');
    expect(await f.query(id)).toHaveProperty('error');
    expect(f.supplier).toHaveBeenCalledTimes(1);
    expect(f.job.fence).toBe('unknown');
    expect((await f.models.journal.read(f.job.bot, f.job.id))?.trace).toContainEqual(
      expect.objectContaining({ code: 'SEARCH_OUTCOME_UNKNOWN' }),
    );
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  'first-await claim reservations cannot change declaration kind (search first=%s)',
  async (searchFirst) => {
    const f = await fixture();
    let release = () => {};
    try {
      const gate = new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
      const original = f.models.journal.put.bind(f.models.journal);
      let first = true;
      vi.spyOn(f.models.journal, 'put').mockImplementation(async (record) => {
        if (first) {
          first = false;
          await gate;
        }
        return original(record);
      });
      const ordinary = f.claim('synthetic-shared', searchFirst ? undefined : null);
      await new Promise(setImmediate);
      await expect(
        f.claim('synthetic-shared', searchFirst ? null : undefined),
      ).rejects.toMatchObject({
        code: 'INVALID_BUDGET_TOOL',
      });
      release();
      await ordinary;
      expect(f.models.budgets.tools(f.job.budget!.budgetId)).toBe(1);
      expect(f.supplier).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    } finally {
      release();
      await f.close();
    }
  },
);

test('local desktop session binding retains the independently captured search configuration', async () => {
  const f = await fixture(3, true);
  try {
    const binding = f.job.binding;
    await f.job.harness?.close();
    await f.job.done;
    await f.search.configure({
      requestId: 'synthetic-new-search-key',
      revision: 1,
      enabled: true,
      provider: 'brave',
      key: 'synthetic-replacement-search-key',
    });
    await f.models.startHuman('mock-bot', {
      requestId: 'synthetic-next-task',
      prompt: 'Synthetic next research.',
    });
    const next = f.models.jobs.get('mock-bot')!;
    await next.done;
    expect(next.binding).not.toBe(binding);
  } finally {
    await f.close();
  }
});

test('a retired delivery Work cannot authorize a new paid query from an otherwise current job', async () => {
  const f = await fixture();
  try {
    const id = await f.receipt();
    f.job.delivery = {
      workId: 'synthetic-missing-work',
      attemptId: 'synthetic-missing-attempt',
      requestId: 'synthetic-missing-request',
    };
    expect(await f.query(id)).toHaveProperty('error');
    expect(f.supplier).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('native search progress cannot duplicate the canonical trace used by Goal recovery accounting', async () => {
  const f = await fixture();
  try {
    const observe = observeTools(f.job, f.job.sessionId!);
    const note = (type: string, data: unknown) => ({
      method: 'session.event',
      params: { sessionId: f.job.sessionId, event: { type, data } },
    });
    observe(note('tool/call', { name: 'web_search', callId: 'synthetic-provider-id' }));
    const id = await f.receipt();
    await f.query(id);
    observe(
      note('tool/result', { message: { toolCallId: 'synthetic-provider-id', isError: false } }),
    );
    await f.query(id);
    const saved = await f.models.journal.read(f.job.bot, f.job.id);
    expect(saved?.executedCount).toBe(1);
    expect((await f.models.journal.recovery(f.job.bot, f.job.id))?.toolCount).toBe(1);
  } finally {
    await f.close();
  }
});

test('a settled supplier refusal remains known while its execution cannot replay the request', async () => {
  const f = await fixture();
  try {
    const { Fault } = await import('./control.js');
    const id = await f.receipt();
    f.supplier.mockRejectedValue(new Fault('SEARCH_FORBIDDEN', 403));
    expect(await f.query(id)).toMatchObject({ error: { message: 'SEARCH_FORBIDDEN' } });
    await f.query(id);
    expect(f.job.fence).toBe('tool');
    expect(f.supplier).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test('a post-claim search configuration refusal keeps its canonical run contribution', async () => {
  const f = await fixture();
  try {
    await f.search.configure({
      requestId: 'synthetic-disable-before-claim',
      revision: 1,
      enabled: false,
      provider: 'brave',
    });
    await expect(f.claim()).rejects.toThrow();
    expect(f.models.budgets.tools(f.job.budget!.budgetId)).toBe(1);
    expect(f.job.toolCount).toBe(1);
    expect((await f.models.journal.read(f.job.bot, f.job.id))?.toolCount).toBe(1);
    expect(f.supplier).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('a failed old contribution write cannot mark a replacement physical attempt unknown', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    let enter = () => {};
    const entered = new Promise<undefined>((resolve) => {
      enter = () => resolve(undefined);
    });
    const gate = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    const original = f.models.journal.put.bind(f.models.journal);
    vi.spyOn(f.models.journal, 'put').mockImplementation(async (record) => {
      if (record.toolCount === 1) {
        enter();
        await gate;
        throw new Error('SYNTHETIC_RETIRED_WRITE');
      }
      return original(record);
    });
    const claimed = f.claim().catch((error: unknown) => error);
    await entered;
    f.job.attemptId = 'synthetic-new-physical-attempt';
    f.job.fence = 'clean';
    release();
    await claimed;
    expect(f.job.fence).toBe('clean');
    expect(f.supplier).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  } finally {
    release();
    await f.close();
  }
});
