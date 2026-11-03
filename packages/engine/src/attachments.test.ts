import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { count, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { expect, test } from 'vitest';
import { Attachments } from './attachments.js';
import { purges, uploads } from './attachments-schema.js';

const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

test('a pre-ORM upload file without trash, versions or purge receipts keeps its bytes after the schema baseline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-legacy-uploads-'));
  const file = path.join(root, 'uploads.sqlite');
  const data = Buffer.from('synthetic-pre-orm-original'),
    name = 'mock-legacy.pdf',
    sha256 = digest(data),
    id = digest(`${name}\0${sha256}`);
  const old = new DatabaseSync(file);
  old.exec(
    'CREATE TABLE uploads (bot TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,data BLOB NOT NULL,content TEXT NOT NULL,PRIMARY KEY(bot,id));',
  );
  old
    .prepare('INSERT INTO uploads VALUES(?,?,?,?,?,?,?)')
    .run('mock-alpha', id, name, data.length, sha256, data, 'MOCK-PRE-ORM');
  old.close();
  const store = new Attachments(file);
  try {
    const read = await store.read('mock-alpha', id);
    expect(read.data.equals(data)).toBe(true);
    expect(read.receipt.content).toBe('MOCK-PRE-ORM');
    const page = await store.list('mock-alpha', {});
    expect(page.textBytes).toBe(Buffer.byteLength('MOCK-PRE-ORM'));
    const [entry] = page.items;
    expect(entry.deleted).toBe(false);
    const trashed = await store.trash('mock-alpha', id, entry.version);
    expect((await store.purge('mock-alpha', id, trashed.version, name)).purged).toBe(true);
    const inspect = drizzle({ client: new DatabaseSync(file, { readOnly: true }) });
    expect(inspect.select({ count: count() }).from(uploads).get()!.count).toBe(0);
    expect(inspect.select({ count: count() }).from(purges).get()!.count).toBe(1);
    expect(inspect.select().from(uploads).where(isNull(uploads.version)).all()).toStrictEqual([]);
    inspect.$client.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('raster uploads retain immutable scoped originals without invoking document extraction', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-image-upload-'));
  const store = new Attachments(path.join(root, 'uploads.sqlite'));
  const image = {
    name: 'mock-pixel.png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  };
  let extracted = false;
  try {
    const receipt = await store.upload('mock-alpha', image, async () => {
      extracted = true;
      return 'MUST NOT EXTRACT PIXELS AS DOCUMENT TEXT';
    });
    expect(extracted).toBe(false);
    expect(receipt.content).toMatch(/image\/png/);
    expect((await store.source('mock-alpha', receipt.id)).file).toStrictEqual(image);
    expect((await store.read('mock-alpha', receipt.id)).data).toStrictEqual(
      Buffer.from(image.data, 'base64'),
    );
    await expect(store.read('mock-beta', receipt.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
    });
    await expect(
      store.upload(
        'mock-alpha',
        { name: 'fake.png', data: Buffer.from('<svg/>').toString('base64') },
        async () => 'never',
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_UNREADABLE' });
    const huge = Buffer.from(image.data, 'base64');
    huge.writeUInt32BE(100000, 16);
    await expect(
      store.upload(
        'mock-alpha',
        { name: 'huge.png', data: huge.toString('base64') },
        async () => 'never',
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_LIMIT' });
    await expect(
      store.upload('mock-alpha', { name: 'wrong.jpg', data: image.data }, async () => 'never'),
    ).rejects.toMatchObject({ code: 'IMAGE_UNREADABLE' });
    const entry = (await store.list('mock-alpha', {})).items[0];
    const trashed = await store.trash('mock-alpha', entry.id, entry.version);
    await expect(store.read('mock-alpha', entry.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_TRASHED',
    });
    await store.restore('mock-alpha', entry.id, trashed.version);
    expect((await store.source('mock-alpha', entry.id)).file).toStrictEqual(image);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('health checks attachment database readiness without returning content and reports closed storage unavailable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-attachment-health-'));
  const store = new Attachments(path.join(dir, 'uploads.sqlite'));
  try {
    expect(await store.status()).toStrictEqual({ available: true });
    await store.close();
    expect(await store.status()).toStrictEqual({ available: false });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy uploads migrate without changing bytes and failed purge rolls back both bytes and its receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-legacy-retention-'));
  const file = path.join(root, 'uploads.sqlite');
  let store = new Attachments(file);
  const source = {
    name: 'legacy.pdf',
    data: Buffer.from('synthetic-legacy-source').toString('base64'),
  };
  try {
    const receipt = await store.upload('mock-alpha', source, async () => 'MOCK-LEGACY');
    await store.close();
    let db = new DatabaseSync(file);
    db.exec(
      'DROP TABLE __drizzle_migrations; DROP TABLE purges; ALTER TABLE uploads DROP COLUMN deleted; ALTER TABLE uploads DROP COLUMN version; ALTER TABLE uploads DROP COLUMN previous;',
    );
    db.close();
    store = new Attachments(file);
    expect((await store.read('mock-alpha', receipt.id)).receipt).toStrictEqual(receipt);
    const entry = (await store.list('mock-alpha', {})).items[0];
    const trashed = await store.trash('mock-alpha', entry.id, entry.version);
    db = new DatabaseSync(file);
    db.exec(
      "CREATE TRIGGER reject_purge BEFORE DELETE ON uploads BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END;",
    );
    await expect(
      store.purge('mock-alpha', entry.id, trashed.version, source.name),
    ).rejects.toThrowError();
    expect((await store.source('mock-alpha', entry.id)).file).toStrictEqual(source);
    expect(drizzle({ client: db }).select({ count: count() }).from(purges).get()!.count).toBe(0);
    db.exec('DROP TRIGGER reject_purge');
    db.close();
    expect((await store.purge('mock-alpha', entry.id, trashed.version, source.name)).purged).toBe(
      true,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('attachment trash is recoverable, permanent purge releases quota and stale purge cannot erase a reupload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retention-'));
  const store = new Attachments(path.join(root, 'uploads.sqlite'));
  const file = { name: 'mock.pdf', data: Buffer.from('synthetic-original').toString('base64') };
  try {
    const uploaded = await store.upload('mock-alpha', file, async () => 'MOCK-47');
    const page = await store.list('mock-alpha', {});
    expect(page.items.length).toBe(1);
    const first = page.items[0];
    expect(page.originalBytes).toBe(uploaded.size);
    const removed = await store.trash('mock-alpha', first.id, first.version);
    expect(removed.deleted).toBe(true);
    expect(await store.trash('mock-alpha', first.id, first.version)).toStrictEqual(removed);
    expect((await store.list('mock-alpha', {})).items.length).toBe(0);
    expect((await store.list('mock-alpha', { trash: true })).items.length).toBe(1);
    await expect(store.read('mock-alpha', first.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_TRASHED',
    });
    await expect(
      store.upload('mock-alpha', file, async () => 'must not resurrect'),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TRASHED' });
    expect((await store.source('mock-alpha', first.id)).file).toStrictEqual(file);
    const restored = await store.restore('mock-alpha', first.id, removed.version);
    expect(restored.deleted).toBe(false);
    await expect(store.trash('mock-alpha', first.id, first.version)).rejects.toMatchObject({
      code: 'ATTACHMENT_CONFLICT',
    });
    await expect(
      store.purge('mock-alpha', first.id, restored.version, file.name),
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_TRASHED',
    });
    const trashed = await store.trash('mock-alpha', first.id, restored.version);
    await expect(
      store.purge('mock-other', first.id, trashed.version, file.name),
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
    });
    await expect(
      store.purge('mock-alpha', first.id, trashed.version, 'wrong.pdf'),
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_CONFIRMATION',
    });
    const purged = await store.purge('mock-alpha', first.id, trashed.version, file.name);
    expect(purged.purged).toBe(true);
    expect((await store.purge('mock-alpha', first.id, trashed.version, file.name)).purged).toBe(
      true,
    );
    expect((await store.list('mock-alpha', { trash: true })).originalBytes).toBe(0);
    await expect(store.source('mock-alpha', first.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
    });
    await store.upload('mock-alpha', file, async () => 'MOCK-47');
    const fresh = (await store.list('mock-alpha', {})).items[0];
    expect(fresh.version).not.toBe(first.version);
    await store.trash('mock-alpha', fresh.id, fresh.version);
    await expect(
      store.purge('mock-alpha', fresh.id, trashed.version, file.name),
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_CONFLICT',
    });
    expect((await store.source('mock-alpha', fresh.id)).file).toStrictEqual(file);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retained extracted text is bounded independently of highly compressed originals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-upload-quota-'));
  const store = new Attachments(path.join(root, 'uploads.sqlite'));
  const data = Buffer.from('synthetic compressed source').toString('base64');
  const content = 'x'.repeat(200 * 1024);
  try {
    for (let index = 0; index < 102; index++)
      await store.upload('mock-alpha', { name: `mock-${index}.pdf`, data }, async () => content);
    const first = await store.list('mock-alpha', {});
    const second = await store.list('mock-alpha', { before: first.next });
    const third = await store.list('mock-alpha', { before: second.next });
    expect(first.items.length).toBe(50);
    expect(second.items.length).toBe(50);
    expect(third.items.length).toBe(2);
    expect(third.next).toBe(undefined);
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size,
    ).toBe(102);
    expect((await store.list('mock-alpha', { query: 'mock-1.pdf' })).items.length).toBe(1);
    expect((await store.list('mock-other', {})).items.length).toBe(0);
    await expect(
      store.upload('mock-alpha', { name: 'one-too-many.pdf', data }, async () => content),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_STORAGE_LIMIT' });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('confirmed attachments retain immutable originals and text across restart, deduplicate uploads and enforce Bot scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-uploads-'));
  let store = new Attachments(path.join(root, 'uploads.sqlite'));
  const data = Buffer.from('%PDF-1.7\nsynthetic-original');
  const file = { name: 'mock.pdf', data: data.toString('base64') };
  let parses = 0;
  const extract = async () => {
    parses++;
    return 'MOCK-47';
  };
  try {
    const first = await store.upload('mock-alpha', file, extract);
    expect(first.content).toBe('MOCK-47');
    expect(first.size).toBe(data.length);
    expect((await store.source('mock-alpha', first.id)).file).toStrictEqual(file);
    expect(await store.upload('mock-alpha', file, extract)).toStrictEqual(first);
    expect(parses).toBe(1);
    const beta = await store.upload('mock-beta', file, extract);
    expect(beta.bot).toBe('mock-beta');
    await expect(store.source('mock-other', first.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
    });
    expect((await store.read('mock-alpha', first.id)).data.equals(data)).toBe(true);
    await store.close();
    store = new Attachments(path.join(root, 'uploads.sqlite'));
    expect((await store.read('mock-alpha', first.id)).receipt).toStrictEqual(first);
    expect((await stat(path.join(root, 'uploads.sqlite'))).mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(path.join(root, 'uploads.sqlite'));
    db.prepare('UPDATE uploads SET data=? WHERE bot=? AND id=?').run(
      Buffer.from('synthetic corruption'),
      'mock-alpha',
      first.id,
    );
    db.close();
    await expect(store.source('mock-alpha', first.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_CORRUPT',
    });
    await expect(store.upload('mock-alpha', file, extract)).rejects.toMatchObject({
      code: 'ATTACHMENT_CORRUPT',
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed, empty and cancelled extraction publishes no attachment, and invalid names never reach the parser', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-upload-errors-'));
  const store = new Attachments(path.join(root, 'uploads.sqlite'));
  const file = { name: 'mock.pdf', data: Buffer.from('synthetic').toString('base64') };
  let parses = 0;
  try {
    await expect(
      store.upload('mock-alpha', { ...file, name: '../escape.pdf' }, async () => {
        parses++;
        return 'bad';
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' });
    expect(parses).toBe(0);
    await expect(store.upload('mock-alpha', file, async () => '')).rejects.toMatchObject({
      code: 'DOCUMENT_EMPTY',
    });
    await expect(
      store.upload('mock-alpha', file, async () => {
        throw new Error('synthetic parser failure');
      }),
    ).rejects.toThrowError();
    const abort = new AbortController();
    await expect(
      store.upload(
        'mock-alpha',
        file,
        async () => {
          abort.abort();
          return 'must not commit';
        },
        abort.signal,
      ),
    ).rejects.toThrowError();
    const db = drizzle({ client: new DatabaseSync(path.join(root, 'uploads.sqlite')) });
    expect(db.select({ count: count() }).from(uploads).get()!.count).toBe(0);
    db.$client.close();
    const saved = await store.upload('mock-alpha', file, async () => 'RECOVERED');
    expect((await store.read('mock-alpha', saved.id)).receipt.content).toBe('RECOVERED');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
