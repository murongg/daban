import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isRuntimeNoticeStatus, managedProtocol } from '@daban/protocol';
import { startPrototype } from './server.js';

test('authenticated status exposes private completion metadata without full prompt/results and without running a model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-notices-api-'));
  const app = await startPrototype({
    port: 0,
    computers: true,
    profileDir: path.join(root, 'profile'),
  });
  try {
    assert.equal((await fetch(app.url + '/api/state')).status, 403);
    assert.ok(app.models);
    await app.models.journal.put({
      bot: 'mock-result-bot',
      runId: 'mock-completion',
      requestId: 'mock-request',
      kind: 'chat',
      chatRevision: 3,
      prompt: 'SYNTHETIC PRIVATE REQUEST',
      result: 'SYNTHETIC PRIVATE OUTPUT',
      error: '',
      phase: 'completed',
      running: false,
      trace: [],
    });
    const state = await (
      await fetch(app.url + '/api/state', { headers: { 'x-prototype-token': app.token } })
    ).json();
    assert.equal(state.clientProtocol, managedProtocol);
    const notices: unknown = state.notices;
    assert.ok(isRuntimeNoticeStatus(notices));
    assert.ok(
      notices.items.some(
        (item) => item.kind === 'task' && item.id === 'mock-completion' && item.chatRevision === 3,
      ),
    );
    assert.equal(JSON.stringify(state.notices).includes('SYNTHETIC PRIVATE'), false);
    assert.equal(state.model.configured, false);
    await app.models.journal.put({
      bot: 'mock-reader',
      runId: 'mock-exact-run',
      requestId: 'mock-exact-request',
      kind: 'chat',
      chatRevision: 0,
      prompt: 'SYNTHETIC EXACT REQUEST',
      result: 'SYNTHETIC EXACT RESULT',
      error: '',
      phase: 'completed',
      running: false,
      trace: [],
    });
    const exact = await fetch(app.url + '/api/chats/history', {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify({ bot: 'mock-reader', revision: 0, runId: 'mock-exact-run' }),
    });
    assert.equal(exact.status, 200);
    const page = await exact.json();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].runId, 'mock-exact-run');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
