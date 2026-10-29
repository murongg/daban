import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isGroupActionAck, isGroupPage } from '@daban/protocol';
import { startPrototype } from './server.js';

test('authenticated group archive/restore retains definitions, fences sends, and preserves legacy group representations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-group-actions-http-'));
  const app = await startPrototype({
    port: 0,
    computers: true,
    profileDir: path.join(root, 'profile'),
  });
  const call = async (route: string, data?: unknown, modern = true, authenticated = true) =>
    fetch(app.url + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(authenticated ? { 'x-prototype-token': app.token } : {}),
        ...(modern ? { 'x-daban-client-protocol': '28' } : {}),
        'content-type': 'application/json',
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    for (const id of ['mock-alpha', 'mock-beta'])
      assert.equal(
        (
          await call('/api/bots', {
            id,
            name: '合成成员',
            instructions: 'SYNTHETIC',
            memory: '',
            color: 'mint',
          })
        ).ok,
        true,
      );
    const group = await (
      await call('/api/groups/register', {
        id: 'mock-http-group',
        name: '合成归档群',
        members: ['mock-alpha', 'mock-beta'],
      })
    ).json();
    const request = { id: 'mock-http-archive', group: group.id, revision: 1, action: 'archive' };
    assert.equal((await call('/api/groups/action', request, true, false)).status, 403);
    assert.equal(
      (await call('/api/groups/action', { ...request, members: ['mock-alpha'] })).status,
      400,
    );
    const response = await call('/api/groups/action', request),
      archived = await response.json();
    assert.equal(response.ok, true, JSON.stringify(archived));
    assert.ok(isGroupActionAck(archived));
    assert.equal(archived.group.archived, true);
    const current = await (await call('/api/state')).json(),
      legacy = await (await call('/api/state', undefined, false)).json();
    assert.equal(current.clientProtocol, 33);
    assert.equal(
      current.groups.items.find((item: { id: string }) => item.id === group.id).archived,
      true,
    );
    assert.ok(!legacy.groups.items.some((item: { id: string }) => item.id === group.id));
    assert.equal(current.model.configured, false);
    const history = await (await call('/api/groups/read', { group: group.id }, false)).json();
    assert.ok(isGroupPage(history));
    assert.equal('archived' in history.group, false);
    assert.equal(
      (
        await call(
          '/api/groups/send',
          {
            id: 'mock-denied',
            group: group.id,
            prompt: 'SYNTHETIC DENIED',
            recipients: ['mock-alpha'],
          },
          false,
        )
      ).status,
      409,
    );
    assert.deepEqual(
      await (await call('/api/groups/action-receipt', { group: group.id, id: request.id })).json(),
      archived,
    );
    const restored = await (
      await call('/api/groups/action', {
        id: 'mock-http-restore',
        group: group.id,
        action: 'restore',
        revision: 2,
      })
    ).json();
    assert.ok(isGroupActionAck(restored));
    assert.equal(!!restored.group.archived, false);
    const replay = await (await call('/api/groups/action', request)).json();
    assert.equal(replay.group.revision, 3);
    assert.equal(!!replay.group.archived, false);
    assert.equal(replay.receipt.revision, 2);
    const oldRead = await (await call('/api/state', undefined, false)).json();
    assert.equal(
      oldRead.groups.items.find((item: { id: string }) => item.id === group.id).revision,
      3,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
