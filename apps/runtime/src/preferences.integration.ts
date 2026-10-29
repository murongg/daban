import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isMemoryPage } from '@daban/protocol';
import { startPrototype } from './server.js';

test('human preference history stays authenticated, bounded, current-only in snapshots and readable during recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-preferences-api-'));
  const config = { port: 0, computers: true as const, profileDir: path.join(root, 'profile') };
  let app = await startPrototype(config);
  const call = async (route: string, data?: unknown, authenticated = true) => {
    const response = await fetch(app.url + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { 'x-prototype-token': app.token } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    const bot = 'mock-preference-a';
    let current = (
      await call('/api/bots', {
        id: bot,
        name: '合成偏好',
        instructions: '',
        memory: 'SYNTHETIC OLD PREFERENCE',
        color: 'mint',
      })
    ).value;
    assert.equal((await call('/api/memory/history', { bot, query: {} }, false)).status, 403);
    const first = await call('/api/memory/history', { bot, query: {} });
    assert.equal(first.status, 200);
    assert.ok(isMemoryPage(first.value));
    assert.equal(first.value.items[0].source, 'initial');
    for (const data of [
      { bot, query: { before: '2' } },
      { bot, query: {}, restore: true },
      { bot: '../mock', query: {} },
      { bot },
    ])
      assert.equal((await call('/api/memory/history', data)).status, 400);
    assert.equal((await call('/api/memory/history', { bot: 'mock-other', query: {} })).status, 404);
    for (let i = 1; i <= 12; i++)
      current = (
        await call(`/api/bots/${bot}/profile`, {
          revision: current.revision,
          patch: { memory: `SYNTHETIC CURRENT ${i}` },
        })
      ).value;
    const page = (await call('/api/memory/history', { bot, query: {} })).value;
    assert.ok(isMemoryPage(page));
    assert.equal(page.items.length, 5);
    assert.equal(page.nextBefore, 9);
    const older = (await call('/api/memory/history', { bot, query: { before: page.nextBefore } }))
      .value;
    assert.ok(isMemoryPage(older));
    assert(older.items.every((item) => item.revision < 9));
    const state = (await call('/api/state')).value;
    assert.equal(state.clientProtocol, 32);
    assert(!JSON.stringify(state).includes('SYNTHETIC OLD PREFERENCE'));
    assert(!JSON.stringify(state).includes('memoryHistory'));
    assert.deepEqual(
      state.profiles.find((p: { id: string }) => p.id === bot),
      current,
    );
    await app.close();
    app = await startPrototype(config);
    assert.deepEqual((await call('/api/memory/history', { bot, query: {} })).value, page);
    const stale = await call(`/api/bots/${bot}/profile`, {
      revision: 1,
      patch: { memory: 'SYNTHETIC MUST NOT REPLACE' },
    });
    assert.equal(stale.status, 409);
    const review = (await call('/api/recovery/review')).value;
    const prepared = await call('/api/recovery/prepare', {
      id: 'mock-preferences-recovery',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    assert.equal(prepared.status, 200);
    assert.deepEqual((await call('/api/memory/history', { bot, query: {} })).value, page);
    assert.equal(
      (
        await call(`/api/bots/${bot}/profile`, {
          revision: current.revision,
          patch: { memory: 'SYNTHETIC BLOCKED' },
        })
      ).status,
      409,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
