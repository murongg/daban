import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Chats } from './chats.js';

test('a fresh personal conversation commits its boundary and durable receipt together; replay cannot replace later state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-chats-'));
  let chats = new Chats(path.join(root, 'chats.sqlite'), () => {});
  const request = { id: 'mock-new-chat', bot: 'mock-alpha', revision: 0 };
  try {
    await chats.ready;
    assert.equal(chats.current('mock-alpha').revision, 0);
    const first = await chats.renew(request);
    assert.equal(first.chat.revision, 1);
    assert.equal(first.receipt.request.id, request.id);
    assert.equal(chats.current('mock-beta').revision, 0);
    await assert.rejects(chats.renew({ ...request, id: 'mock-stale' }), { code: 'CHAT_CONFLICT' });
    await chats.close();
    await chats.close();
    chats = new Chats(path.join(root, 'chats.sqlite'), () => {});
    await chats.ready;
    assert.deepEqual(await chats.receipt(request.bot, request.id), first);
    const second = await chats.renew({ ...request, id: 'mock-next', revision: 1 });
    const replay = await chats.renew(request);
    assert.equal(replay.chat.revision, 2);
    assert.equal(replay.receipt.revision, 1);
    assert.deepEqual(replay.chat, second.chat);
    await assert.rejects(chats.receipt('mock-beta', request.id), {
      code: 'CHAT_RECEIPT_NOT_FOUND',
    });
    await assert.rejects(chats.renew({ ...request, revision: 2 }), {
      code: 'CHAT_REQUEST_ID_REUSED',
    });
    assert.equal((await chats.status()).items.length, 1);
  } finally {
    await chats.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed admission or a still-stopping private job cannot commit a new boundary or receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-chat-gate-'));
  let blocked = true;
  const chats = new Chats(path.join(root, 'chats.sqlite'), () => {
    if (blocked) throw Object.assign(new Error('CHAT_BUSY'), { code: 'CHAT_BUSY' });
  });
  const request = { id: 'mock-fenced-chat', bot: 'mock-alpha', revision: 0 };
  try {
    await chats.ready;
    await assert.rejects(chats.renew(request), { code: 'CHAT_BUSY' });
    assert.equal(chats.current(request.bot).revision, 0);
    await assert.rejects(chats.receipt(request.bot, request.id), {
      code: 'CHAT_RECEIPT_NOT_FOUND',
    });
    blocked = false;
    assert.equal((await chats.renew(request)).chat.revision, 1);
    blocked = true;
    assert.equal((await chats.renew(request)).receipt.revision, 1);
    await assert.rejects(chats.renew({ ...request, unknown: true }), {
      code: 'INVALID_CHAT_REQUEST',
    });
  } finally {
    await chats.close();
    await rm(root, { recursive: true, force: true });
  }
});
