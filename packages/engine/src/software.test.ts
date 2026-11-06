import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SoftwarePlan, SoftwareReceipt } from '@daban/protocol';
import { expect, test } from 'vitest';
import { Interactions } from './interactions.js';
import { type SoftwareBackend, SoftwareTools } from './software.js';

const plan: SoftwarePlan = {
  id: 'mock-plan',
  requested: ['mock-calculator'],
  targets: [{ name: 'mock-calculator', version: '1.0-1' }],
  packages: [{ name: 'mock-calculator', version: '1.0-1' }],
  source: 'debian',
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T00:20:00Z',
  digest: 'a'.repeat(64),
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-software-'));
  const cards = new Interactions(root);
  let effects = 0,
    plans = 0;
  let receipt: SoftwareReceipt = { plan, phase: 'planned', updatedAt: plan.createdAt };
  const backend: SoftwareBackend = {
    plan: async () => {
      plans++;
      return structuredClone(receipt);
    },
    install: async () => {
      effects++;
      receipt = { ...receipt, phase: 'installed' };
      return structuredClone(receipt);
    },
    receipt: async () => structuredClone(receipt),
    status: async () => ({ available: true, items: [structuredClone(receipt)] }),
  };
  const tools = new SoftwareTools(cards, backend, { pollMilliseconds: 1 });
  const run = {
    id: 'mock-run',
    sessionId: 'mock-session',
    bot: 'mock-a',
    abort: new AbortController(),
  };
  const call = () =>
    tools.invoke(run, 'software_install', {
      packages: ['mock-calculator'],
      purpose: '合成计算任务',
    });
  const pending = async () => {
    for (let i = 0; i < 100; i++) {
      const item = (await cards.list())[0];
      if (item) return item;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Synthetic approval missing');
  };
  return {
    root,
    cards,
    backend,
    tools,
    run,
    call,
    pending,
    counts: () => ({ effects, plans }),
    set: (value: SoftwareReceipt) => {
      receipt = value;
    },
  };
}
test('installation requires exact durable approval; duplicate requests never install twice', async () => {
  const f = await fixture();
  try {
    const pending = f.call(),
      card = await f.pending();
    expect(card.kind).toBe('approval');
    expect(f.counts().effects).toBe(0);
    const duplicate = f.call();
    await f.cards.reply(f.run.bot, f.run.id, card.id, { kind: 'decision', allow: true });
    expect((await pending).isError).toBe(undefined);
    expect((await duplicate).isError).toBe(undefined);
    expect(f.counts().effects).toBe(1);
    await f.call();
    expect(f.counts().effects).toBe(1);
    expect(f.counts().plans).toBe(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('refusal and stopping before dispatch cannot install; changed args cannot reuse consent', async () => {
  const f = await fixture();
  try {
    const pending = f.call(),
      card = await f.pending();
    await f.cards.reply(f.run.bot, f.run.id, card.id, { kind: 'decision', allow: false });
    expect((await pending).isError).toBe(true);
    expect(f.counts().effects).toBe(0);
    await f.call();
    expect(f.counts().effects).toBe(0);
    const invalid = await f.tools.invoke(f.run, 'software_install', {
      packages: ['-y'],
      purpose: '合成用途',
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
  const g = await fixture();
  try {
    const pending = g.call();
    await g.pending();
    g.run.abort.abort();
    expect((await pending).isError).toBe(true);
    expect(g.counts().effects).toBe(0);
  } finally {
    await rm(g.root, { recursive: true, force: true });
  }
});
test('a lost dispatch reply is inspected and never automatically retried after a new tool call', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.backend.install = async () => {
      calls++;
      throw new Error('Synthetic disconnect');
    };
    const pending = f.call(),
      card = await f.pending();
    await f.cards.reply(f.run.bot, f.run.id, card.id, { kind: 'decision', allow: true });
    expect((await pending).isError).toBe(true);
    expect(calls).toBe(1);
    await f.call();
    expect(calls).toBe(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('installed software needs no new effect or approval, and list reads shared inventory', async () => {
  const f = await fixture();
  try {
    f.set({ plan, phase: 'installed', updatedAt: plan.createdAt });
    expect((await f.call()).isError).toBe(undefined);
    expect((await f.cards.list()).length).toBe(0);
    expect(f.counts().effects).toBe(0);
    const result = await f.tools.invoke({ ...f.run, bot: 'mock-b' }, 'software_list', {});
    expect(result.isError).toBe(undefined);
    expect(JSON.stringify(result)).toMatch(/mock-calculator/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
