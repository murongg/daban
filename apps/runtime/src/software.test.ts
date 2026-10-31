import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SoftwarePlan, SoftwareReceipt } from '@daban/protocol';
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
    assert.equal(card.kind, 'approval');
    assert.equal(f.counts().effects, 0);
    const duplicate = f.call();
    await f.cards.reply(f.run.bot, f.run.id, card.id, { kind: 'decision', allow: true });
    assert.equal((await pending).isError, undefined);
    assert.equal((await duplicate).isError, undefined);
    assert.equal(f.counts().effects, 1);
    await f.call();
    assert.equal(f.counts().effects, 1);
    assert.equal(f.counts().plans, 1);
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
    assert.equal((await pending).isError, true);
    assert.equal(f.counts().effects, 0);
    await f.call();
    assert.equal(f.counts().effects, 0);
    const invalid = await f.tools.invoke(f.run, 'software_install', {
      packages: ['-y'],
      purpose: '合成用途',
    });
    assert.equal(invalid.isError, true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
  const g = await fixture();
  try {
    const pending = g.call();
    await g.pending();
    g.run.abort.abort();
    assert.equal((await pending).isError, true);
    assert.equal(g.counts().effects, 0);
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
    assert.equal((await pending).isError, true);
    assert.equal(calls, 1);
    await f.call();
    assert.equal(calls, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('installed software needs no new effect or approval, and list reads shared inventory', async () => {
  const f = await fixture();
  try {
    f.set({ plan, phase: 'installed', updatedAt: plan.createdAt });
    assert.equal((await f.call()).isError, undefined);
    assert.equal((await f.cards.list()).length, 0);
    assert.equal(f.counts().effects, 0);
    const result = await f.tools.invoke({ ...f.run, bot: 'mock-b' }, 'software_list', {});
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result), /mock-calculator/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
