import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApprovalSelector, SoftwarePlan, SoftwareReceipt } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { AgentTools } from './agent-tools.js';
import { ApprovalRules, approvalHash, commandHash, type RulePolicy } from './approval-rules.js';
import { Commands } from './commands.js';
import { Interactions } from './interactions.js';
import { SoftwareTools } from './software.js';
import { WorkspaceFiles } from './workspace.js';

const plan: SoftwarePlan = {
  id: 'mock-plan',
  requested: ['mock-calculator'],
  targets: [{ name: 'mock-calculator', version: '1.0-1' }],
  packages: [
    { name: 'mock-calculator', version: '1.0-1' },
    { name: 'mock-dependency', version: '2.0-1' },
  ],
  source: 'debian',
  createdAt: '2099-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:10:00Z',
  digest: 'a'.repeat(64),
};
async function fixture(mode: 'auto' | 'full' = 'full') {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-rule-dispatch-'));
  const rules = new ApprovalRules(path.join(root, 'rules.sqlite'));
  const run = {
    id: 'mock-run',
    bot: 'mock-bot',
    sessionId: 'mock-session',
    workdir: '/workspace/mock',
    abort: new AbortController(),
    task: { requestId: 'mock-task', prompt: 'Synthetic task', approvalMode: mode },
  };
  const cards = new Interactions(path.join(root, 'interactions'), undefined, () => mode === 'full');
  const policy: RulePolicy = {
    review: (_run, selector, baseline, allowEligible = false) =>
      rules.evaluate({
        scope: { kind: 'bot', bot: run.bot },
        trigger: 'interactive',
        selector,
        mode,
        baseline: mode === 'full' ? 'allow' : baseline,
        allowEligible,
      }),
    assertCurrent: (_run, decision) => rules.assertCurrent(decision),
  };
  const save = async (selector: ApprovalSelector, effect: 'deny' | 'ask' | 'allow') =>
    rules.write({
      requestId: `mock-${effect}`,
      scope: { kind: 'bot', bot: run.bot },
      expectedRevision: (await rules.status()).revision,
      action: 'save',
      rule: {
        id: `mock-${effect}`,
        name: `Synthetic ${effect}`,
        enabled: true,
        trigger: 'interactive',
        effect,
        selector,
      },
    });
  const pending = async () => {
    for (let i = 0; i < 200; i++) {
      const card = (await cards.list())[0];
      if (card) return card;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Synthetic approval missing');
  };
  return {
    root,
    rules,
    run,
    cards,
    policy,
    save,
    pending,
    close: async () => {
      run.abort.abort();
      await cards.endRun(run.bot, run.id);
      await rules.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('a rule ask remains pending in full mode and metadata is Host-only', async () => {
  const f = await fixture();
  try {
    const selector: ApprovalSelector = { kind: 'url', url: 'https://example.test/mock' };
    await f.save(selector, 'ask');
    const decision = await f.policy.review(f.run, selector, 'allow');
    const input = {
      id: 'mock-card',
      sessionId: f.run.sessionId,
      kind: 'approval',
      tool: 'web_fetch',
      url: selector.url,
    };
    const card = await Reflect.apply(f.cards.open, f.cards, [
      f.run.bot,
      f.run.id,
      input,
      undefined,
      decision,
    ]);
    expect(card.status).toBe('pending');
    await expect(
      f.cards.open(f.run.bot, f.run.id, { ...input, policyDecision: decision }),
    ).rejects.toThrow('INVALID_INTERACTION');
  } finally {
    await f.close();
  }
});

test('full installation deny sends zero installs and the decision binds the complete plan', async () => {
  const f = await fixture();
  let installs = 0;
  const receipt: SoftwareReceipt = { plan, phase: 'planned', updatedAt: plan.createdAt };
  try {
    await f.save({ kind: 'software', planId: plan.id, planHash: approvalHash(plan) }, 'deny');
    const options = { policy: f.policy, pollMilliseconds: 1 };
    const tools = new SoftwareTools(
      f.cards,
      {
        plan: async () => structuredClone(receipt),
        install: async () => {
          installs++;
          return { ...receipt, phase: 'installed' };
        },
        receipt: async () => receipt,
        status: async () => ({ available: true, items: [] }),
      },
      options,
    );
    const result = await tools.invoke(f.run, 'software_install', {
      packages: plan.requested,
      purpose: 'Synthetic install',
    });
    expect(installs).toBe(0);
    expect(result.isError).toBe(true);
    expect((await f.cards.list())[0]).toMatchObject({
      policyDecision: { effect: 'deny' },
      reply: { allow: false },
    });
  } finally {
    await f.close();
  }
});

test('a durable installation approval cannot survive a policy edit and cannot be replayed', async () => {
  const f = await fixture('auto');
  let installs = 0;
  let inspections = 0;
  const receipt: SoftwareReceipt = { plan, phase: 'planned', updatedAt: plan.createdAt };
  try {
    const options = { policy: f.policy, pollMilliseconds: 1 };
    const tools = new SoftwareTools(
      f.cards,
      {
        plan: async () => structuredClone(receipt),
        install: async () => {
          installs++;
          return { ...receipt, phase: 'installed' };
        },
        receipt: async () => {
          inspections++;
          return receipt;
        },
        status: async () => ({ available: true, items: [] }),
      },
      options,
    );
    const call = () =>
      tools.invoke(f.run, 'software_install', {
        packages: plan.requested,
        purpose: 'Synthetic install',
      });
    const pending = call();
    const card = await f.pending();
    await f.save({ kind: 'software', planId: plan.id, planHash: approvalHash(plan) }, 'deny');
    await f.cards.reply(f.run.bot, f.run.id, card.id, { kind: 'decision', allow: true });
    const outcome = await pending;
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome)).toContain('APPROVAL_POLICY_CHANGED');
    expect(installs).toBe(0);
    await call();
    expect(installs).toBe(0);
    expect(inspections).toBe(1);
  } finally {
    await f.close();
  }
});

test('a command rechecks rules after the dispatch claim yields', async () => {
  const f = await fixture();
  let effects = 0;
  const options = {
    file: path.join(f.root, 'commands.sqlite'),
    interactions: f.cards,
    policy: f.policy,
    review: async () => 'allow' as const,
  };
  const commands = new Commands(options);
  try {
    const result = commands.invoke(
      f.run,
      'shell',
      { command: 'ls' },
      'mock-call',
      async (...args: unknown[]) => {
        const decision = await f.rules.evaluate({
          scope: { kind: 'bot', bot: f.run.bot },
          trigger: 'interactive',
          selector: { kind: 'url', url: 'https://example.test/mock' },
          mode: 'full',
          baseline: 'allow',
          allowEligible: false,
        });
        await f.save(decision.selector, 'deny');
        const guard = args[0];
        if (typeof guard === 'function') guard();
        effects++;
        return { content: [{ type: 'text', text: 'SYNTHETIC' }] };
      },
    );
    const outcome = await result;
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome)).toContain('APPROVAL_POLICY_CHANGED');
    expect(effects).toBe(0);
  } finally {
    await commands.close();
    await f.close();
  }
});

test('a changed dependency plan or policy while reading its receipt prevents installation', async () => {
  for (const change of ['plan', 'policy', 'expiry']) {
    const f = await fixture();
    let installs = 0;
    const receipt: SoftwareReceipt = { plan, phase: 'planned', updatedAt: plan.createdAt };
    try {
      const options = { policy: f.policy, pollMilliseconds: 1 };
      const tools = new SoftwareTools(
        f.cards,
        {
          plan: async () => structuredClone(receipt),
          install: async () => {
            installs++;
            return { ...receipt, phase: 'installed' };
          },
          receipt: async () => {
            if (change === 'expiry')
              vi.spyOn(Date, 'now').mockReturnValue(Date.parse(plan.expiresAt) + 1);
            if (change === 'policy')
              await f.save(
                { kind: 'software', planId: plan.id, planHash: approvalHash(plan) },
                'deny',
              );
            return change === 'plan'
              ? {
                  ...receipt,
                  plan: {
                    ...plan,
                    packages: [...plan.packages, { name: 'mock-added', version: '3.0-1' }],
                  },
                }
              : receipt;
          },
          status: async () => ({ available: true, items: [] }),
        },
        options,
      );
      const result = await tools.invoke(f.run, 'software_install', {
        packages: plan.requested,
        purpose: 'Synthetic install',
      });
      expect(installs).toBe(0);
      expect(result.isError).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  }
});

test('revocation during actual guest preparation prevents tools.invoke from being sent', async () => {
  const f = await fixture();
  let signalOpened: () => unknown = () => undefined;
  let releaseOpen: () => unknown = () => undefined;
  const opened = new Promise<unknown>((resolve) => {
    signalOpened = () => resolve(undefined);
  });
  const hold = new Promise<unknown>((resolve) => {
    releaseOpen = () => resolve(undefined);
  });
  let effects = 0;
  const execution = {
    snapshot: { capabilities: [] },
    call: async (method: string) => {
      if (method === 'tools.open') {
        signalOpened();
        await hold;
        return {
          tools: [
            { name: 'shell', description: 'Synthetic shell', inputSchema: { type: 'object' } },
          ],
        };
      }
      if (method === 'tools.invoke') {
        effects++;
        return { phase: 'settled', result: { content: [{ type: 'text', text: 'SYNTHETIC' }] } };
      }
      return undefined;
    },
  };
  const tools = new AgentTools(undefined, new WorkspaceFiles(f.root), { execution });
  const commands = new Commands({
    file: path.join(f.root, 'commands.sqlite'),
    interactions: f.cards,
    policy: f.policy,
  });
  tools.executeRemote = commands.invoke.bind(commands);
  const run = {
    ...f.run,
    canonicalRoot: f.run.workdir,
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
  };
  try {
    const pending = tools.invoke(run, 'shell', { command: 'ls' }, 'mock-guest-call');
    await Promise.race([
      opened,
      pending.then((value) => {
        throw new Error(`Synthetic guest never opened: ${JSON.stringify(value)}`);
      }),
    ]);
    await f.save(
      { kind: 'command', tool: 'shell', commandHash: commandHash('ls'), cwd: run.workdir },
      'deny',
    );
    releaseOpen();
    expect(JSON.stringify(await pending)).toContain('APPROVAL_POLICY_CHANGED');
    expect(effects).toBe(0);
  } finally {
    releaseOpen();
    await commands.close();
    await f.close();
  }
});

test('a physical attempt changed during guest open cannot dispatch on the opened old run', async () => {
  const f = await fixture();
  let effects = 0;
  const run = {
    ...f.run,
    executionId: 'mock-execution-before',
    canonicalRoot: f.run.workdir,
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
  };
  const execution = {
    snapshot: { capabilities: [] },
    call: async (method: string) => {
      if (method === 'tools.open') {
        run.executionId = 'mock-execution-after';
        return {
          tools: [
            { name: 'shell', description: 'Synthetic shell', inputSchema: { type: 'object' } },
          ],
        };
      }
      if (method === 'tools.invoke') {
        effects++;
        return { phase: 'settled', result: { content: [{ type: 'text', text: 'SYNTHETIC' }] } };
      }
      return undefined;
    },
  };
  const tools = new AgentTools(undefined, new WorkspaceFiles(f.root), { execution });
  const commands = new Commands({
    file: path.join(f.root, 'commands.sqlite'),
    interactions: f.cards,
    policy: f.policy,
  });
  tools.executeRemote = commands.invoke.bind(commands);
  try {
    const result = await tools.invoke(run, 'shell', { command: 'ls' }, 'mock-joint-call');
    expect(result.isError).toBe(true);
    expect(effects).toBe(0);
  } finally {
    await commands.close();
    await f.close();
  }
});
