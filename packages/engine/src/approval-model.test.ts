import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { ApprovalRules } from './approval-rules.js';
import * as durability from './durability.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

const transport = vi.hoisted(() => ({
  effects: 0,
  unknown: false,
  beforeSend: async () => {},
  offered: [
    {
      name: 'synthetic_write',
      description: 'Synthetic external write',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  ],
}));
vi.mock('./mcp.js', () => ({
  McpRemote: class {
    constructor(
      _config: unknown,
      readonly options: import('./mcp-fetch.js').McpFetchOptions,
    ) {}
    async start() {}
    async tools() {
      return transport.offered;
    }
    async call() {
      await this.options.onDispatch?.();
      await transport.beforeSend();
      this.options.assertAuthority?.();
      transport.effects++;
      if (transport.unknown) throw new Error('Synthetic lost reply');
      return { content: [{ type: 'text', text: 'SYNTHETIC-RESULT' }] };
    }
    async close() {}
  },
}));

async function until(check: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 3000, interval: 5 });
}

async function mcpFixture(mode: 'auto' | 'ask' | 'full' | 'default' = 'auto') {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-current-purpose-'));
  const releases: (() => unknown)[] = [];
  let closed = false;
  class Harness {
    async start() {}
    async close() {
      for (const release of releases) release();
    }
    session() {
      return {
        id: 'mock-session',
        run: async () => {
          if (!closed)
            await new Promise<unknown>((resolve) => {
              releases.push(() => resolve(undefined));
            });
          return { sessionId: 'mock-session', finalResponse: 'SYNTHETIC' };
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  transport.effects = 0;
  transport.unknown = false;
  transport.beforeSend = async () => {};
  await mkdir(path.join(root, 'workspace'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.save({ apiKey: 'mock-purpose-key' });
  const models = new ModelRuns({
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness,
  });
  await models.integrations.save({
    requestId: 'mock-create',
    id: 'mock-connection',
    revision: 0,
    name: 'Synthetic connection',
    endpoint: 'https://mcp.example.test/mcp',
    bearer: 'synthetic-secret',
  });
  const catalog = await models.integrations.catalog('mock-connection', 1, transport.offered);
  await models.integrations.bind('mock-bot', {
    connection: 'mock-connection',
    configRevision: 1,
    bindingRevision: 0,
    catalogDigest: catalog.current.catalogDigest!,
    tools: ['synthetic_write'],
    enabled: true,
  });
  const { mcpDigest } = await import('./mcp-catalog.js');
  const selector = {
    kind: 'mcp' as const,
    connection: 'mock-connection',
    configRevision: 1,
    catalogDigest: catalog.current.catalogDigest!,
    tool: 'synthetic_write',
    inputHash: mcpDigest({ value: 'synthetic-value' }),
  };
  const rule = {
    id: 'mock-allow',
    name: 'Synthetic exact rule',
    enabled: true,
    effect: 'allow' as const,
    trigger: 'interactive' as const,
    selector,
    purposeConfirmed: true as const,
  };
  await models.approvalRules.write({
    requestId: 'mock-save',
    expectedRevision: 0,
    scope: { kind: 'bot', bot: 'mock-bot' },
    action: 'save',
    rule,
  });
  await models.start('mock-bot', {
    requestId: 'mock-task',
    prompt: 'Only greet me. Do not use integrations or write external records.',
    approvalMode: mode === 'default' ? undefined : mode,
  });
  await until(() => releases.length === 1);
  let job = models.jobs.get('mock-bot')!;
  const calls: Promise<unknown>[] = [];
  const call = (id: number, value = 'synthetic-value') => {
    const pending = models.rpc('mock-bot', `Bearer ${job.token}`, {
      id,
      method: 'tools/call',
      params: { name: catalog.tools[0].alias, arguments: { value } },
    });
    pending.catch(() => {});
    calls.push(pending);
    return pending;
  };
  const card = async (count: number) => {
    await until(async () => (await models.interactions.list()).length >= count);
    return (await models.interactions.list())[count - 1];
  };
  const nextTurn = async () => {
    await models.insert(job.bot, {
      runId: job.id,
      chatRevision: job.chatRevision ?? 0,
      id: 'mock-followup',
      text: 'Synthetic unrelated follow-up',
    });
    releases[0]();
    await until(() => releases.length === 2);
    expect(job.turns?.at(-1)?.id).toBe('mock-followup');
    expect(models.journal.findRequest(job.bot, 'mock-task')?.turns?.at(-1)?.id).toBe(
      'mock-followup',
    );
  };
  const nextTask = async () => {
    await models.stop(job.bot);
    await job.done;
    await models.start('mock-bot', {
      requestId: 'mock-new-task',
      prompt: 'Synthetic unrelated new task',
      approvalMode: mode === 'default' ? undefined : mode,
    });
    await until(() => releases.length === 2);
    job = models.jobs.get('mock-bot')!;
  };
  return {
    models,
    get job() {
      return job;
    },
    call,
    card,
    nextTurn,
    nextTask,
    rule,
    close: async () => {
      closed = true;
      for (const release of releases) release();
      await models.close();
      await Promise.allSettled(calls);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('a saved exact MCP allow rule is not current human purpose authority, and one-time approval cannot authorize a new call', async () => {
  const f = await mcpFixture();
  try {
    const pending = f.call(1);
    const card = await f.card(1);
    expect(card.status).toBe('pending');
    expect(transport.effects).toBe(0);
    expect(await f.models.rulePolicy.review(f.job, f.rule.selector, 'ask', true)).toMatchObject({
      effect: 'ask',
    });
    expect(
      await f.models.rpc(f.job.bot, `Bearer ${f.job.token}`, {
        id: 90,
        method: 'interaction.reply',
        params: { id: card.id, reply: { kind: 'decision', allow: true, confirmPurpose: true } },
      }),
    ).toMatchObject({ error: { code: -32601 } });
    await expect(
      f.models.rpc(f.job.bot, `Bearer ${f.job.token}`, {
        id: 91,
        method: 'interaction.open',
        params: { ...card, id: 'mock-forged-card' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INTERACTION' });
    await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
      kind: 'decision',
      allow: true,
    });
    await pending;
    expect(transport.effects).toBe(1);
    await f.call(1);
    expect(transport.effects).toBe(1);
    const again = f.call(2);
    expect((await f.card(2)).status).toBe('pending');
    expect(transport.effects).toBe(1);
    await f.models.interactions.reply(f.job.bot, f.job.id, (await f.card(2)).id, {
      kind: 'decision',
      allow: false,
    });
    await again;
  } finally {
    await f.close();
  }
});

test.each(['parameters', 'rule revision', 'source', 'conversation', 'task'] as const)(
  'current-purpose evidence cannot survive a changed %s',
  async (change) => {
    const f = await mcpFixture();
    try {
      const first = f.call(1);
      const card = await f.card(1);
      await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
        kind: 'decision',
        allow: true,
        confirmPurpose: true,
      });
      await first;
      if (change === 'rule revision')
        await f.models.approvalRules.write({
          requestId: 'mock-edit',
          expectedRevision: 1,
          scope: { kind: 'bot', bot: f.job.bot },
          action: 'save',
          rule: { ...f.rule, name: 'Synthetic revised rule' },
        });
      if (change === 'source') f.job.trigger = 'automation';
      if (change === 'conversation') f.job.conversationId = 'mock-another-group';
      if (change === 'task') await f.nextTask();
      const next = f.call(2, change === 'parameters' ? 'synthetic-changed-value' : undefined);
      const current = await f.card(2);
      expect(current.status).toBe('pending');
      expect(transport.effects).toBe(1);
      await f.models.interactions.reply(f.job.bot, f.job.id, current.id, {
        kind: 'decision',
        allow: false,
      });
      await next;
    } finally {
      await f.close();
    }
  },
);

test('a lost MCP reply remains unknown and cannot replay even with current-purpose consent', async () => {
  const f = await mcpFixture();
  try {
    const first = f.call(1);
    const card = await f.card(1);
    transport.unknown = true;
    await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
      kind: 'decision',
      allow: true,
      confirmPurpose: true,
    });
    expect(JSON.stringify(await first)).toContain('MCP_OUTCOME_UNKNOWN');
    expect(JSON.stringify(await f.call(1))).toContain('MCP_OUTCOME_UNKNOWN');
    expect(JSON.stringify(await f.call(2))).toContain('MCP_OUTCOME_UNKNOWN');
    expect(transport.effects).toBe(1);
    expect(await f.models.interactions.list()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each(['connection', 'catalog', 'expiry'] as const)(
  'current-purpose consent cannot bypass changed %s authority',
  async (change) => {
    if (change === 'expiry') vi.useFakeTimers({ toFake: ['Date'] });
    const f = await mcpFixture();
    try {
      const expiry = Date.now() + 60000;
      if (change === 'expiry')
        await f.models.approvalRules.write({
          requestId: 'mock-expiring',
          expectedRevision: 1,
          scope: { kind: 'bot', bot: f.job.bot },
          action: 'save',
          rule: { ...f.rule, expiresAt: new Date(expiry).toISOString() },
        });
      const first = f.call(1);
      const card = await f.card(1);
      await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
        kind: 'decision',
        allow: true,
        confirmPurpose: true,
      });
      await first;
      if (change === 'connection')
        await f.models.integrations.save({
          requestId: 'mock-reconfigured',
          id: 'mock-connection',
          revision: 1,
          name: 'Synthetic revised connection',
          endpoint: 'https://mcp.example.test/changed',
          bearer: 'synthetic-secret',
        });
      if (change === 'catalog')
        await f.models.integrations.catalog('mock-connection', 1, [
          { ...transport.offered[0], description: 'Synthetic revised catalog' },
        ]);
      if (change === 'expiry')
        transport.beforeSend = async () => {
          vi.setSystemTime(expiry + 1);
        };
      expect(await f.call(2)).toMatchObject({ result: { isError: true } });
      expect(transport.effects).toBe(1);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      await f.close();
    }
  },
);

test.each(['deny', 'ask'] as const)('an MCP %s rule still restricts full mode', async (effect) => {
  const f = await mcpFixture('full');
  try {
    await f.models.approvalRules.write({
      requestId: 'mock-restrict',
      expectedRevision: 1,
      scope: { kind: 'bot', bot: f.job.bot },
      action: 'save',
      rule: { ...f.rule, effect },
    });
    const pending = f.call(1);
    const card = await f.card(1);
    expect(card.purposeScope).toBeUndefined();
    expect(card.policyDecision?.effect).toBe(effect);
    expect(transport.effects).toBe(0);
    if (effect === 'ask') {
      expect(card.status).toBe('pending');
      await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
        kind: 'decision',
        allow: false,
      });
    }
    await pending;
    expect(transport.effects).toBe(0);
  } finally {
    await f.close();
  }
});

test.each(['ask', 'full'] as const)(
  'current-purpose wiring preserves %s mode semantics',
  async (mode) => {
    const f = await mcpFixture(mode);
    try {
      const pending = f.call(1);
      const card = await f.card(1);
      expect(card.purposeScope).toBeUndefined();
      if (mode === 'full') {
        await pending;
        expect(card).toMatchObject({
          status: 'resolved',
          decisionSource: 'policy',
          policyDecision: { reasonCode: 'baselineAllowed' },
        });
        expect(transport.effects).toBe(1);
      } else {
        expect(card.status).toBe('pending');
        await expect(
          f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
            kind: 'decision',
            allow: true,
            confirmPurpose: true,
          }),
        ).rejects.toMatchObject({ code: 'INVALID_INTERACTION_REPLY' });
        expect(transport.effects).toBe(0);
        await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
          kind: 'decision',
          allow: false,
        });
        await pending;
      }
    } finally {
      await f.close();
    }
  },
);

test.each(['auto', 'default'] as const)(
  'explicit current-purpose consent in %s mode enables exact rule allow, but a new persisted Human turn invalidates it',
  async (mode) => {
    const f = await mcpFixture(mode);
    try {
      const first = f.call(1);
      const card = await f.card(1);
      expect(card.status).toBe('pending');
      expect(card).toMatchObject({ purposeScope: { taskId: 'mock-task', turnId: 'mock-task' } });
      await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
        kind: 'decision',
        allow: true,
        confirmPurpose: true,
      });
      await first;
      expect(transport.effects).toBe(1);
      const repeated = await f.call(2);
      expect(JSON.stringify(repeated)).toContain('SYNTHETIC-RESULT');
      expect(await f.card(2)).toMatchObject({
        decisionSource: 'policy',
        policyDecision: { effect: 'allow', reasonCode: 'ruleAllowed' },
      });
      expect(transport.effects).toBe(2);
      await f.call(2);
      expect(transport.effects).toBe(2);
      await f.nextTurn();
      const next = f.call(3);
      const nextCard = await f.card(3);
      expect(nextCard.status).toBe('pending');
      expect(transport.effects).toBe(2);
      await f.models.interactions.reply(f.job.bot, f.job.id, nextCard.id, {
        kind: 'decision',
        allow: false,
      });
      await next;
    } finally {
      await f.close();
    }
  },
);

test('a Human turn change during transport preparation invalidates even a just-committed current-purpose approval before the final send', async () => {
  const f = await mcpFixture();
  try {
    const pending = f.call(1);
    const card = await f.card(1);
    transport.beforeSend = f.nextTurn;
    await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
      kind: 'decision',
      allow: true,
      confirmPurpose: true,
    });
    expect(JSON.stringify(await pending)).toContain('APPROVAL_AUTHORITY_CHANGED');
    expect(transport.effects).toBe(0);
  } finally {
    await f.close();
  }
});

test('purpose consent loses authority if the persisted Human turn changes while its receipt commits', async () => {
  const f = await mcpFixture();
  const sync = durability.syncDirectory;
  try {
    const pending = f.call(1);
    const card = await f.card(1);
    let changed = false;
    vi.spyOn(durability, 'syncDirectory').mockImplementation(async (directory) => {
      await sync(directory);
      if (!changed) {
        changed = true;
        await f.nextTurn();
      }
    });
    await expect(
      f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
        kind: 'decision',
        allow: true,
        confirmPurpose: true,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_AUTHORITY_CHANGED' });
    await pending;
    expect(await f.card(1)).toMatchObject({ status: 'cancelled' });
    expect((await f.card(1)).reply).toBeUndefined();
    expect(transport.effects).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

test.each(['interactive', 'automation'] as const)(
  'Host web decisions bind the live %s source and session; model RPC cannot edit rules',
  async (trigger) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-rules-model-'));
    let models: ModelRuns | undefined;
    let entered: () => unknown = () => undefined;
    let release: () => unknown = () => undefined;
    const started = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    const held = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    class Harness {
      async start() {}
      async close() {
        release();
      }
      session() {
        return {
          id: 'mock-session',
          run: async () => {
            entered();
            await held;
            return { sessionId: 'mock-session', finalResponse: 'SYNTHETIC' };
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    const rules = new ApprovalRules(path.join(root, 'model', 'approval-rules.sqlite'));
    try {
      await mkdir(path.join(root, 'workspace'));
      const selector = { kind: 'url' as const, url: 'https://example.test/mock' };
      await rules.write({
        requestId: 'mock-save',
        expectedRevision: 0,
        scope: { kind: 'bot', bot: 'mock-bot' },
        action: 'save',
        rule: {
          id: 'mock-deny',
          name: 'Synthetic URL restriction',
          enabled: true,
          effect: 'deny',
          trigger: 'interactive',
          selector,
        },
      });
      const settings = new ModelSettings(path.join(root, 'credentials.json'));
      await settings.save({ apiKey: 'mock-approval-key' });
      models = new ModelRuns({
        settings,
        workspace: path.join(root, 'workspace'),
        dir: path.join(root, 'model'),
        origin: 'http://127.0.0.1:12345',
        Harness,
      });
      await models.start(
        'mock-bot',
        {
          requestId: 'mock-task',
          prompt: 'Read https://example.test/mock',
          approvalMode: 'full',
        },
        undefined,
        trigger,
      );
      await started;
      const job = models.jobs.get('mock-bot')!;
      const auth = `Bearer ${job.token}`;
      const response = await models.rpc('mock-bot', auth, {
        id: 1,
        method: 'approval.web',
        params: { sessionId: job.sessionId, url: selector.url },
      });
      expect(response).toMatchObject({
        result: {
          trigger,
          effect: trigger === 'interactive' ? 'deny' : 'allow',
          matchedRules: trigger === 'interactive' ? [{ id: 'mock-deny' }] : [],
        },
      });
      expect(
        models.transcripts.page(job.transcript!, 0).items.some((item) => item.name === 'policy'),
      ).toBe(true);
      if (trigger === 'interactive')
        await expect(models.tools.authorizeComputer!(job)).rejects.toMatchObject({
          code: 'WEB_APPROVAL_REJECTED',
        });
      expect(models.journal.findRequest('mock-bot', 'mock-task')?.trigger).toBe(trigger);
      await expect(
        models.rpc('mock-bot', auth, {
          id: 2,
          method: 'approval.web',
          params: { sessionId: 'mock-other-session', url: selector.url },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INTERACTION' });
      await expect(
        models.rpc('mock-bot', auth, {
          id: 3,
          method: 'interaction.open',
          params: {
            id: 'mock-forged',
            sessionId: job.sessionId,
            kind: 'approval',
            tool: 'web_fetch',
            url: selector.url,
            policyDecision: {},
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INTERACTION' });
      expect(
        await models.rpc('mock-bot', auth, { id: 4, method: 'approval.rules.write', params: {} }),
      ).toMatchObject({ error: { code: -32601 } });
      expect((await rules.snapshot({ kind: 'bot', bot: 'mock-bot' })).revision).toBe(1);
    } finally {
      release();
      await models?.close();
      await rules.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
