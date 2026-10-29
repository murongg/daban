import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { managedProtocol } from '@daban/protocol';
import { startPrototype } from './server.js';

test('personal conversation boundaries and receipt/history reads require authenticated exact scope and preserve Bot state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-chats-api-'));
  const app = await startPrototype({
    port: 0,
    computers: true,
    profileDir: path.join(root, 'profile'),
  });
  const call = (route: string, data?: unknown, authorized = true) =>
    fetch(app.url + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorized ? { 'x-prototype-token': app.token } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    const bot = 'mock-personal';
    const registered = await (
      await call('/api/bots', {
        id: bot,
        name: '合成伙伴',
        instructions: 'SYNTHETIC ROLE',
        memory: 'SYNTHETIC KEEP',
        color: 'mint',
      })
    ).json();
    const request = { bot, id: 'mock-new-conversation', revision: 0 };
    assert.equal((await call('/api/chats/new', request, false)).status, 403);
    assert.equal((await call('/api/chats/new', { ...request, unknown: true })).status, 400);
    const response = await call('/api/chats/new', request);
    assert.equal(response.status, 200);
    const first = await response.json();
    assert.equal(first.chat.revision, 1);
    const state = await (await call('/api/state')).json();
    assert.equal(state.clientProtocol, managedProtocol);
    assert.equal(state.chats.items.find((item: { bot: string }) => item.bot === bot).revision, 1);
    assert.equal(state.model.configured, false);
    assert.deepEqual(
      await (await call('/api/chats/receipt', { bot, id: request.id })).json(),
      first,
    );
    const history = await (await call('/api/chats/history', { bot, revision: 0 })).json();
    assert.deepEqual(history.items, []);
    assert.equal((await call('/api/chats/history', { bot, revision: 2 })).status, 404);
    assert.equal(
      (await call('/api/chats/receipt', { bot: 'mock-other', id: request.id })).status,
      404,
    );
    const profiles = await (await call('/api/bots')).json();
    assert.deepEqual(
      profiles.find((item: { id: string }) => item.id === bot),
      registered,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
