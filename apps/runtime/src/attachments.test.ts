import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Attachments } from './attachments.js';

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
    assert.equal(extracted, false);
    assert.match(receipt.content, /image\/png/);
    assert.deepEqual((await store.source('mock-alpha', receipt.id)).file, image);
    assert.deepEqual(
      (await store.read('mock-alpha', receipt.id)).data,
      Buffer.from(image.data, 'base64'),
    );
    await assert.rejects(store.read('mock-beta', receipt.id), { code: 'ATTACHMENT_NOT_FOUND' });
    await assert.rejects(
      store.upload(
        'mock-alpha',
        { name: 'fake.png', data: Buffer.from('<svg/>').toString('base64') },
        async () => 'never',
      ),
      { code: 'IMAGE_UNREADABLE' },
    );
    const huge = Buffer.from(image.data, 'base64');
    huge.writeUInt32BE(100000, 16);
    await assert.rejects(
      store.upload(
        'mock-alpha',
        { name: 'huge.png', data: huge.toString('base64') },
        async () => 'never',
      ),
      { code: 'IMAGE_LIMIT' },
    );
    await assert.rejects(
      store.upload('mock-alpha', { name: 'wrong.jpg', data: image.data }, async () => 'never'),
      { code: 'IMAGE_UNREADABLE' },
    );
    const entry = (await store.list('mock-alpha', {})).items[0];
    const trashed = await store.trash('mock-alpha', entry.id, entry.version);
    await assert.rejects(store.read('mock-alpha', entry.id), { code: 'ATTACHMENT_TRASHED' });
    await store.restore('mock-alpha', entry.id, trashed.version);
    assert.deepEqual((await store.source('mock-alpha', entry.id)).file, image);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('health checks attachment database readiness without returning content and reports closed storage unavailable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-attachment-health-'));
  const store = new Attachments(path.join(dir, 'uploads.sqlite'));
  try {
    assert.deepEqual(await store.status(), { available: true });
    await store.close();
    assert.deepEqual(await store.status(), { available: false });
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
      'DROP TABLE purges; ALTER TABLE uploads DROP COLUMN deleted; ALTER TABLE uploads DROP COLUMN version; ALTER TABLE uploads DROP COLUMN previous;',
    );
    db.close();
    store = new Attachments(file);
    assert.deepEqual((await store.read('mock-alpha', receipt.id)).receipt, receipt);
    const entry = (await store.list('mock-alpha', {})).items[0];
    const trashed = await store.trash('mock-alpha', entry.id, entry.version);
    db = new DatabaseSync(file);
    db.exec(
      "CREATE TRIGGER reject_purge BEFORE DELETE ON uploads BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END;",
    );
    await assert.rejects(store.purge('mock-alpha', entry.id, trashed.version, source.name));
    assert.deepEqual((await store.source('mock-alpha', entry.id)).file, source);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purges').get()!.count, 0);
    db.exec('DROP TRIGGER reject_purge');
    db.close();
    assert.equal(
      (await store.purge('mock-alpha', entry.id, trashed.version, source.name)).purged,
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
    assert.equal(page.items.length, 1);
    const first = page.items[0];
    assert.equal(page.originalBytes, uploaded.size);
    const removed = await store.trash('mock-alpha', first.id, first.version);
    assert.equal(removed.deleted, true);
    assert.deepEqual(await store.trash('mock-alpha', first.id, first.version), removed);
    assert.equal((await store.list('mock-alpha', {})).items.length, 0);
    assert.equal((await store.list('mock-alpha', { trash: true })).items.length, 1);
    await assert.rejects(store.read('mock-alpha', first.id), { code: 'ATTACHMENT_TRASHED' });
    await assert.rejects(
      store.upload('mock-alpha', file, async () => 'must not resurrect'),
      { code: 'ATTACHMENT_TRASHED' },
    );
    assert.deepEqual((await store.source('mock-alpha', first.id)).file, file);
    const restored = await store.restore('mock-alpha', first.id, removed.version);
    assert.equal(restored.deleted, false);
    await assert.rejects(store.trash('mock-alpha', first.id, first.version), {
      code: 'ATTACHMENT_CONFLICT',
    });
    await assert.rejects(store.purge('mock-alpha', first.id, restored.version, file.name), {
      code: 'ATTACHMENT_NOT_TRASHED',
    });
    const trashed = await store.trash('mock-alpha', first.id, restored.version);
    await assert.rejects(store.purge('mock-other', first.id, trashed.version, file.name), {
      code: 'ATTACHMENT_NOT_FOUND',
    });
    await assert.rejects(store.purge('mock-alpha', first.id, trashed.version, 'wrong.pdf'), {
      code: 'ATTACHMENT_CONFIRMATION',
    });
    const purged = await store.purge('mock-alpha', first.id, trashed.version, file.name);
    assert.equal(purged.purged, true);
    assert.equal(
      (await store.purge('mock-alpha', first.id, trashed.version, file.name)).purged,
      true,
    );
    assert.equal((await store.list('mock-alpha', { trash: true })).originalBytes, 0);
    await assert.rejects(store.source('mock-alpha', first.id), { code: 'ATTACHMENT_NOT_FOUND' });
    await store.upload('mock-alpha', file, async () => 'MOCK-47');
    const fresh = (await store.list('mock-alpha', {})).items[0];
    assert.notEqual(fresh.version, first.version);
    await store.trash('mock-alpha', fresh.id, fresh.version);
    await assert.rejects(store.purge('mock-alpha', fresh.id, trashed.version, file.name), {
      code: 'ATTACHMENT_CONFLICT',
    });
    assert.deepEqual((await store.source('mock-alpha', fresh.id)).file, file);
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
    assert.equal(first.items.length, 50);
    assert.equal(second.items.length, 50);
    assert.equal(third.items.length, 2);
    assert.equal(third.next, undefined);
    assert.equal(
      new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size,
      102,
    );
    assert.equal((await store.list('mock-alpha', { query: 'mock-1.pdf' })).items.length, 1);
    assert.equal((await store.list('mock-other', {})).items.length, 0);
    await assert.rejects(
      store.upload('mock-alpha', { name: 'one-too-many.pdf', data }, async () => content),
      { code: 'ATTACHMENT_STORAGE_LIMIT' },
    );
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
    assert.equal(first.content, 'MOCK-47');
    assert.equal(first.size, data.length);
    assert.deepEqual((await store.source('mock-alpha', first.id)).file, file);
    assert.deepEqual(await store.upload('mock-alpha', file, extract), first);
    assert.equal(parses, 1);
    const beta = await store.upload('mock-beta', file, extract);
    assert.equal(beta.bot, 'mock-beta');
    await assert.rejects(store.source('mock-other', first.id), { code: 'ATTACHMENT_NOT_FOUND' });
    assert.equal((await store.read('mock-alpha', first.id)).data.equals(data), true);
    await store.close();
    store = new Attachments(path.join(root, 'uploads.sqlite'));
    assert.deepEqual((await store.read('mock-alpha', first.id)).receipt, first);
    assert.equal((await stat(path.join(root, 'uploads.sqlite'))).mode & 0o777, 0o600);
    const db = new DatabaseSync(path.join(root, 'uploads.sqlite'));
    db.prepare('UPDATE uploads SET data=? WHERE bot=? AND id=?').run(
      Buffer.from('synthetic corruption'),
      'mock-alpha',
      first.id,
    );
    db.close();
    await assert.rejects(store.source('mock-alpha', first.id), { code: 'ATTACHMENT_CORRUPT' });
    await assert.rejects(store.upload('mock-alpha', file, extract), { code: 'ATTACHMENT_CORRUPT' });
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
    await assert.rejects(
      store.upload('mock-alpha', { ...file, name: '../escape.pdf' }, async () => {
        parses++;
        return 'bad';
      }),
      { code: 'INVALID_ATTACHMENT' },
    );
    assert.equal(parses, 0);
    await assert.rejects(
      store.upload('mock-alpha', file, async () => ''),
      { code: 'DOCUMENT_EMPTY' },
    );
    await assert.rejects(
      store.upload('mock-alpha', file, async () => {
        throw new Error('synthetic parser failure');
      }),
    );
    const abort = new AbortController();
    await assert.rejects(
      store.upload(
        'mock-alpha',
        file,
        async () => {
          abort.abort();
          return 'must not commit';
        },
        abort.signal,
      ),
    );
    const db = new DatabaseSync(path.join(root, 'uploads.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM uploads').get()!.count, 0);
    db.close();
    const saved = await store.upload('mock-alpha', file, async () => 'RECOVERED');
    assert.equal((await store.read('mock-alpha', saved.id)).receipt.content, 'RECOVERED');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
