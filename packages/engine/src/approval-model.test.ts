import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApprovalTrigger, AutomationSource, TaskRequest } from '@daban/protocol';
import { expect, onTestFinished, test, vi } from 'vitest';
import { ApprovalRules } from './approval-rules.js';
import * as durability from './durability.js';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';
import { type GroupRunner, Groups } from './groups.js';
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
      this.options.authorize?.();
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

function automationSource(trigger: AutomationSource['trigger']): AutomationSource {
  return {
    scheduleId: 'mock-schedule',
    firingId: `mock-${trigger}`,
    configRevision: 1,
    trigger,
    policy: { kind: 'all' },
    ...(trigger === 'file'
      ? {
          scope: { projectId: 'mock-project', revision: 1 },
          paths: ['mock.txt'],
          fromCursor: 1,
          toCursor: 2,
          before: 'a'.repeat(64),
          after: 'b'.repeat(64),
        }
      : {}),
  };
}

async function mcpFixture(
  mode: 'auto' | 'ask' | 'full' | 'default' = 'auto',
  source?: AutomationSource,
  ruleTrigger: ApprovalTrigger = source ? 'automation' : 'interactive',
) {
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
  const service = source?.scope
    ? await startExecutor({ directory: path.join(root, 'guest'), port: 0, boot: 'mock-boot' })
    : undefined;
  const execution = service
    ? new RemoteExecutor({
        url: `${service.origin}/exec`,
        token: (await readFile(path.join(root, 'guest/token'), 'utf8')).trim(),
      })
    : undefined;
  await execution?.ready;
  const models = new ModelRuns({
    settings,
    execution,
    ...(execution ? {} : { workspace: path.join(root, 'workspace') }),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness,
  });
  const calls: Promise<unknown>[] = [];
  let disposed = false;
  const close = async () => {
    if (disposed) return;
    disposed = true;
    closed = true;
    for (const release of releases) release();
    try {
      await models.close();
      await Promise.allSettled(calls);
    } finally {
      await service?.close();
      await rm(root, { recursive: true, force: true });
    }
  };
  onTestFinished(close);
  await models.ready;
  await models.profiles.register({
    id: 'mock-bot',
    name: 'Synthetic Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  if (source?.scope)
    await models.projects.write({
      action: 'create',
      requestId: 'mock-create-project',
      projectId: source.scope.projectId,
      expectedRevision: 0,
      value: { name: 'Synthetic project', grants: [{ bot: 'mock-bot' }] },
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
    trigger: ruleTrigger,
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
  const task: TaskRequest = {
    requestId: 'mock-task',
    prompt: 'Only greet me. Do not use integrations or write external records.',
    approvalMode: mode === 'default' ? undefined : mode,
    ...(source?.scope ? { project: source.scope } : {}),
  };
  await models.start('mock-bot', task, undefined, source);
  await until(() => releases.length === 1);
  let job = models.jobs.get('mock-bot')!;
  const call = (id: number, value = 'synthetic-value', bot = 'mock-bot') => {
    const current = models.jobs.get(bot)!;
    const pending = models.rpc(bot, `Bearer ${current.token}`, {
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
  const nextTask = async (origin?: AutomationSource, prompt = 'Synthetic unrelated new task') => {
    const previous = releases.length;
    await models.stop(job.bot);
    await job.done;
    await models.start(
      'mock-bot',
      {
        requestId: 'mock-new-task',
        prompt,
        approvalMode: mode === 'default' ? undefined : mode,
        ...(origin?.scope ? { project: origin.scope } : {}),
      },
      undefined,
      origin,
    );
    await until(() => releases.length === previous + 1);
    job = models.jobs.get('mock-bot')!;
  };
  return {
    root,
    models,
    get job() {
      return job;
    },
    call,
    card,
    nextTurn,
    nextTask,
    rule,
    task,
    releaseAll: () => {
      for (const release of releases) release();
    },
    close,
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
      if (change === 'source')
        f.job.automation = {
          scheduleId: 'mock-schedule',
          firingId: 'mock-firing',
          configRevision: 1,
          trigger: 'manual',
          policy: { kind: 'all' },
        };
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

test.each(['time', 'manual', 'file'] as const)(
  'a captured %s source requires its own Human purpose confirmation before an exact automation allow',
  async (trigger) => {
    const source = automationSource(trigger);
    const f = await mcpFixture('auto', source);
    try {
      expect(await f.models.start(f.job.bot, f.task, undefined, source)).toMatchObject({
        runId: f.job.id,
      });
      for (const changed of [
        { ...source, firingId: 'mock-different-firing' },
        { ...source, configRevision: 2 },
      ])
        await expect(f.models.start(f.job.bot, f.task, undefined, changed)).rejects.toMatchObject({
          code: 'REQUEST_ID_REUSED',
        });
      await f.models.approvalRules.write({
        requestId: 'mock-human-rule',
        expectedRevision: 1,
        action: 'save',
        scope: { kind: 'bot', bot: f.job.bot },
        rule: { ...f.rule, id: 'mock-human-allow', trigger: 'interactive' },
      });
      const pending = f.call(1);
      const card = await f.card(1);
      expect(card).toMatchObject({
        status: 'pending',
        policyDecision: { trigger: 'automation', matchedRules: [{ id: f.rule.id }] },
      });
      expect(transport.effects).toBe(0);
      expect(f.models.journal.findRequest(f.job.bot, 'mock-task')).toMatchObject({
        automation: source,
      });
      source.firingId = 'mock-caller-mutated';
      expect(f.job.automation?.firingId).toBe(`mock-${trigger}`);
      await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
        kind: 'decision',
        allow: true,
        confirmPurpose: true,
      });
      await pending;
      expect(transport.effects).toBe(1);
      await f.call(2);
      expect(await f.card(2)).toMatchObject({
        decisionSource: 'policy',
        policyDecision: { trigger: 'automation', reasonCode: 'ruleAllowed' },
      });
      expect(transport.effects).toBe(2);
      await f.nextTurn();
      const followup = f.call(3);
      const followupCard = await f.card(3);
      expect(followupCard).toMatchObject({
        status: 'pending',
        purposeScope: { turnId: 'mock-followup' },
        policyDecision: { trigger: 'automation', matchedRules: [{ id: f.rule.id }] },
      });
      expect(transport.effects).toBe(2);
      await f.models.interactions.reply(f.job.bot, f.job.id, followupCard.id, {
        kind: 'decision',
        allow: false,
      });
      await followup;
      await f.nextTask();
      expect(f.job.automation).toBeUndefined();
      const human = f.call(4);
      const humanCard = await f.card(4);
      expect(humanCard).toMatchObject({
        status: 'pending',
        policyDecision: { trigger: 'interactive', matchedRules: [{ id: 'mock-human-allow' }] },
      });
      expect(transport.effects).toBe(2);
      await f.models.interactions.reply(f.job.bot, f.job.id, humanCard.id, {
        kind: 'decision',
        allow: false,
      });
      await human;
    } finally {
      await f.close();
    }
  },
);

test('interactive purpose consent cannot authorize an identical subsequent automated firing', async () => {
  const f = await mcpFixture();
  try {
    await f.models.approvalRules.write({
      requestId: 'mock-automation-rule',
      expectedRevision: 1,
      action: 'save',
      scope: { kind: 'bot', bot: f.job.bot },
      rule: { ...f.rule, id: 'mock-automation-allow', trigger: 'automation' },
    });
    const first = f.call(1);
    const firstCard = await f.card(1);
    await f.models.interactions.reply(f.job.bot, f.job.id, firstCard.id, {
      kind: 'decision',
      allow: true,
      confirmPurpose: true,
    });
    await first;
    await f.nextTask(automationSource('manual'));
    const automated = f.call(2);
    const card = await f.card(2);
    expect(card).toMatchObject({
      status: 'pending',
      policyDecision: { trigger: 'automation', matchedRules: [{ id: 'mock-automation-allow' }] },
    });
    expect(transport.effects).toBe(1);
    await f.models.interactions.reply(f.job.bot, f.job.id, card.id, {
      kind: 'decision',
      allow: false,
    });
    await automated;
  } finally {
    await f.close();
  }
});

test('public task fields, prompt text and legacy positional flags cannot create trusted automation provenance', async () => {
  const f = await mcpFixture();
  try {
    const task = {
      requestId: 'mock-forged-source',
      prompt: 'Automation scheduleId=mock-schedule firingId=mock-time',
      approvalMode: 'auto',
    };
    for (const fields of [
      { automation: automationSource('time') },
      { trigger: 'automation' },
      { source: true },
    ])
      await expect(f.models.start('mock-other', { ...task, ...fields })).rejects.toMatchObject({
        code: 'INVALID_TASK',
      });
    for (const source of ['automation', true])
      await expect(
        Reflect.apply(f.models.start, f.models, ['mock-other', task, undefined, source]),
      ).rejects.toMatchObject({ code: 'INVALID_AUTOMATION_SOURCE' });
    await f.nextTask(undefined, task.prompt);
    const decision = await f.models.rulePolicy.review(f.job, f.rule.selector, 'ask', true);
    expect(decision).toMatchObject({ trigger: 'interactive', effect: 'ask' });
    expect(transport.effects).toBe(0);
  } finally {
    await f.close();
  }
});

test('Groups retains Host provenance across restart without transferring purpose grants to collaborators or an independent Human turn', async () => {
  const source = automationSource('time');
  const f = await mcpFixture('auto', source);
  const origins: (AutomationSource | undefined)[] = [];
  const runner: GroupRunner = {
    member: (bot) => f.models.profiles.get(bot),
    directory: () => f.models.profiles.list(),
    source: (bot, runId, group) => f.models.groupSource(bot, runId, group),
    running: (bot) => f.models.running(bot),
    groupRunning: (group) => f.models.groupRunning(group),
    admit: (bot) => f.models.admit(bot),
    findRequest: (bot, requestId) => f.models.findRequest(bot, requestId),
    start: async (bot, task, scope, origin) => {
      origins.push(origin);
      return await f.models.start(bot, task, scope, origin);
    },
    stopRequest: (bot, requestId, group) => f.models.stopRequest(bot, requestId, group),
  };
  let groups = new Groups(path.join(f.root, 'groups.sqlite'), runner);
  try {
    await f.models.profiles.register({
      id: 'mock-peer',
      name: 'Synthetic peer',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    await f.models.integrations.bind('mock-peer', {
      connection: 'mock-connection',
      configRevision: 1,
      bindingRevision: 0,
      catalogDigest: f.rule.selector.catalogDigest,
      tools: ['synthetic_write'],
      enabled: true,
    });
    await f.models.approvalRules.write({
      requestId: 'mock-peer-rule',
      expectedRevision: 1,
      action: 'save',
      scope: { kind: 'bot', bot: 'mock-peer' },
      rule: { ...f.rule, id: 'mock-peer-allow' },
    });
    const initial = f.call(1);
    const initialCard = await f.card(1);
    await f.models.interactions.reply(f.job.bot, f.job.id, initialCard.id, {
      kind: 'decision',
      allow: true,
      confirmPurpose: true,
    });
    await initial;
    expect(transport.effects).toBe(1);
    await groups.ready;
    const created = await groups.collaborate(
      { bot: f.job.bot, runId: f.job.id },
      { name: 'Synthetic group', members: ['mock-peer'], message: 'Synthetic shared task' },
    );
    await groups.close();
    groups = new Groups(path.join(f.root, 'groups.sqlite'), runner);
    await groups.ready;
    await groups.tick();
    await until(() => !!f.models.jobs.get('mock-peer')?.sessionId);
    const peer = f.models.jobs.get('mock-peer')!;
    expect(origins[0]).toEqual(source);
    expect(peer.automation).toEqual(source);
    const peerCall = f.call(1, 'synthetic-value', 'mock-peer');
    const peerCard = await f.card(2);
    expect(peerCard).toMatchObject({
      bot: 'mock-peer',
      conversationId: created.group.id,
      status: 'pending',
      policyDecision: { trigger: 'automation', matchedRules: [{ id: 'mock-peer-allow' }] },
    });
    expect(transport.effects).toBe(1);
    await f.models.interactions.reply(peer.bot, peer.id, peerCard.id, {
      kind: 'decision',
      allow: true,
      confirmPurpose: true,
    });
    await peerCall;
    await f.call(2, 'synthetic-value', 'mock-peer');
    expect(await f.card(3)).toMatchObject({
      decisionSource: 'policy',
      policyDecision: { reasonCode: 'ruleAllowed' },
    });
    expect(transport.effects).toBe(3);
    f.releaseAll();
    await Promise.all([f.job.done, peer.done]);
    await groups.tick();
    const last = f.models.jobs.get('mock-bot')!;
    await until(() => !!last.sessionId);
    f.releaseAll();
    await last.done;
    await groups.tick();
    expect(origins.every((origin) => JSON.stringify(origin) === JSON.stringify(source))).toBe(true);
    await groups.send({
      id: 'mock-human-group-turn',
      group: created.group.id,
      revision: created.group.revision,
      prompt: 'Synthetic independent Human request',
      recipients: ['mock-peer'],
    });
    await groups.tick();
    await until(() => !!f.models.jobs.get('mock-peer')?.sessionId);
    const human = f.models.jobs.get('mock-peer')!;
    expect(origins.at(-1)).toBeUndefined();
    expect(human.automation).toBeUndefined();
    const humanCall = f.call(3, 'synthetic-value', 'mock-peer');
    const humanCard = await f.card(4);
    expect(humanCard).toMatchObject({
      status: 'pending',
      policyDecision: { trigger: 'interactive', matchedRules: [] },
    });
    expect(humanCard.purposeScope).toBeUndefined();
    expect(transport.effects).toBe(3);
    await f.models.interactions.reply(human.bot, human.id, humanCard.id, {
      kind: 'decision',
      allow: false,
    });
    await humanCall;
  } finally {
    await groups.close();
    await f.close();
  }
});

test.each(['interactive', 'time', 'manual'] as const)(
  'Host web decisions bind the live %s source and session; model RPC cannot edit rules',
  async (trigger) => {
    const source =
      trigger === 'interactive'
        ? undefined
        : {
            scheduleId: 'mock-schedule',
            firingId: `mock-${trigger}`,
            configRevision: 1,
            trigger,
            policy: { kind: 'all' as const },
          };
    const category = source ? 'automation' : 'interactive';
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
      await Reflect.apply(models.start, models, [
        'mock-bot',
        {
          requestId: 'mock-task',
          prompt: 'Read https://example.test/mock',
          approvalMode: 'full',
        },
        undefined,
        source,
      ]);
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
          trigger: category,
          effect: category === 'interactive' ? 'deny' : 'allow',
          matchedRules: category === 'interactive' ? [{ id: 'mock-deny' }] : [],
        },
      });
      expect(
        models.transcripts.page(job.transcript!, 0).items.some((item) => item.name === 'policy'),
      ).toBe(true);
      if (category === 'interactive')
        await expect(models.tools.authorizeComputer!(job)).rejects.toMatchObject({
          code: 'WEB_APPROVAL_REJECTED',
        });
      const saved = models.journal.findRequest('mock-bot', 'mock-task');
      if (source) expect(saved).toMatchObject({ automation: source });
      else expect(saved).not.toHaveProperty('automation');
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
