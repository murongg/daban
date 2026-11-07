import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { Chats } from './chats.js';

test('a pre-ORM chat file keeps its boundary and receipts after the schema baseline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-chats-legacy-'));
  const file = path.join(root, 'chats.sqlite');
  const chat = { bot: 'mock-alpha', revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' };
  const receipt = {
    request: { id: 'mock-old', bot: 'mock-alpha', revision: 0 },
    revision: 1,
    completedAt: chat.updatedAt,
  };
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE chats(bot TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE chat_receipts(id TEXT PRIMARY KEY,bot TEXT NOT NULL,value TEXT NOT NULL);
    CREATE TABLE chat_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
    INSERT INTO chat_meta VALUES(1,4);`);
  old.prepare('INSERT INTO chats VALUES(?,?)').run(chat.bot, JSON.stringify(chat));
  old
    .prepare('INSERT INTO chat_receipts VALUES(?,?,?)')
    .run(receipt.request.id, chat.bot, JSON.stringify(receipt));
  old.close();
  const chats = new Chats(file, () => {});
  try {
    await chats.ready;
    expect(await chats.receipt(chat.bot, receipt.request.id)).toStrictEqual({ chat, receipt });
    expect((await chats.status()).revision).toBe(4);
    const next = await chats.renew({ id: 'mock-new', bot: chat.bot, revision: 1 });
    expect(next.chat.revision).toBe(2);
    expect((await chats.status()).revision).toBe(5);
  } finally {
    await chats.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a fresh personal conversation commits its boundary and durable receipt together; replay cannot replace later state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-chats-'));
  let chats = new Chats(path.join(root, 'chats.sqlite'), () => {});
  const request = { id: 'mock-new-chat', bot: 'mock-alpha', revision: 0 };
  try {
    await chats.ready;
    expect(chats.current('mock-alpha').revision).toBe(0);
    const first = await chats.renew(request);
    expect(first.chat.revision).toBe(1);
    expect(first.receipt.request.id).toBe(request.id);
    expect(chats.current('mock-beta').revision).toBe(0);
    await expect(chats.renew({ ...request, id: 'mock-stale' })).rejects.toMatchObject({
      code: 'CHAT_CONFLICT',
    });
    await chats.close();
    await chats.close();
    chats = new Chats(path.join(root, 'chats.sqlite'), () => {});
    await chats.ready;
    expect(await chats.receipt(request.bot, request.id)).toStrictEqual(first);
    const second = await chats.renew({ ...request, id: 'mock-next', revision: 1 });
    const replay = await chats.renew(request);
    expect(replay.chat.revision).toBe(2);
    expect(replay.receipt.revision).toBe(1);
    expect(replay.chat).toStrictEqual(second.chat);
    await expect(chats.receipt('mock-beta', request.id)).rejects.toMatchObject({
      code: 'CHAT_RECEIPT_NOT_FOUND',
    });
    await expect(chats.renew({ ...request, revision: 2 })).rejects.toMatchObject({
      code: 'CHAT_REQUEST_ID_REUSED',
    });
    expect((await chats.status()).items.length).toBe(1);
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
    await expect(chats.renew(request)).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    expect(chats.current(request.bot).revision).toBe(0);
    await expect(chats.receipt(request.bot, request.id)).rejects.toMatchObject({
      code: 'CHAT_RECEIPT_NOT_FOUND',
    });
    blocked = false;
    expect((await chats.renew(request)).chat.revision).toBe(1);
    blocked = true;
    expect((await chats.renew(request)).receipt.revision).toBe(1);
    await expect(chats.renew({ ...request, unknown: true })).rejects.toMatchObject({
      code: 'INVALID_CHAT_REQUEST',
    });
  } finally {
    await chats.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation trash and restore persist exact scoped receipts, preserve boundaries and reject stale undo', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-conversation-trash-'));
  const file = path.join(root, 'chats.sqlite');
  let chats = new Chats(file, () => {});
  const request = {
    id: 'mock-trash',
    bot: 'mock-alpha',
    revision: 0,
    version: 0,
    action: 'trash' as const,
    title: 'SYNTHETIC TOPIC',
  };
  try {
    await chats.ready;
    const first = await chats.action(request);
    expect((await chats.status()).lifecycle).toEqual([first.conversation]);
    expect(first.conversation).toMatchObject({
      bot: request.bot,
      revision: 0,
      version: 1,
      trashed: true,
    });
    expect(first.chat.revision).toBe(1);
    expect(chats.current('mock-beta').revision).toBe(0);
    expect(() => chats.assertVisible(request.bot, 0)).toThrow('CONVERSATION_TRASHED');
    await chats.close();
    chats = new Chats(file, () => {});
    await chats.ready;
    expect(await chats.actionReceipt(request)).toEqual(first);
    const restored = await chats.action({
      ...request,
      id: 'mock-restore',
      action: 'restore',
      version: 1,
    });
    expect(restored.conversation).toMatchObject({ trashed: false, version: 2 });
    expect(restored.chat.revision).toBe(1);
    expect(() => chats.assertVisible(request.bot, 0)).not.toThrow();
    const second = await chats.action({ ...request, id: 'mock-trash-again', version: 2 });
    expect(second.conversation.version).toBe(3);
    await expect(
      chats.action({ ...request, id: 'mock-stale-undo', action: 'restore', version: 1 }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_CONFLICT' });
    expect((await chats.action(request)).conversation.version).toBe(3);
    await expect(chats.action({ ...request, title: 'SYNTHETIC CHANGED' })).rejects.toMatchObject({
      code: 'CONVERSATION_REQUEST_ID_REUSED',
    });
    await expect(chats.actionReceipt({ ...request, bot: 'mock-beta' })).rejects.toMatchObject({
      code: 'CONVERSATION_RECEIPT_NOT_FOUND',
    });
    expect((await chats.conversations()).filter((entry) => entry.trashed)).toHaveLength(1);
    await expect(
      chats.action({ ...request, id: 'mock-future', revision: 9 }),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
  } finally {
    await chats.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('trash admission is atomic and never stops active work or commits a receipt on rejection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-conversation-busy-'));
  let busy = true;
  const chats = new Chats(path.join(root, 'chats.sqlite'), () => {
    if (busy) throw Object.assign(new Error('CHAT_BUSY'), { code: 'CHAT_BUSY' });
  });
  const request = {
    id: 'mock-busy-trash',
    bot: 'mock-alpha',
    revision: 0,
    version: 0,
    action: 'trash' as const,
    title: 'SYNTHETIC BUSY',
  };
  try {
    await chats.ready;
    await expect(chats.action(request)).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    expect(chats.current(request.bot).revision).toBe(0);
    expect(await chats.conversations()).toEqual([]);
    await expect(chats.actionReceipt(request)).rejects.toMatchObject({
      code: 'CONVERSATION_RECEIPT_NOT_FOUND',
    });
    busy = false;
    await chats.action(request);
    busy = true;
    expect((await chats.action(request)).conversation.trashed).toBe(true);
  } finally {
    await chats.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupt lifecycle record reports unavailable state without hiding retained data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-corrupt-conversation-'));
  const file = path.join(root, 'chats.sqlite');
  const chats = new Chats(file, () => {});
  try {
    await chats.ready;
    const corrupt = new DatabaseSync(file);
    corrupt
      .prepare('INSERT INTO conversation_states(bot, revision, value) VALUES(?, ?, ?)')
      .run('mock-alpha', 0, '{');
    corrupt.close();
    expect(await chats.status()).toMatchObject({ available: false, error: 'CHAT_UNAVAILABLE' });
    await expect(chats.conversations()).rejects.toMatchObject({ code: 'CHAT_CORRUPT' });
  } finally {
    await chats.close();
    await rm(root, { recursive: true, force: true });
  }
});
