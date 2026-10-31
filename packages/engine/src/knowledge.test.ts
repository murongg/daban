import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Knowledge } from './knowledge.js';

test('a failed original insert rolls back its text revision and corrupted originals are never served', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-import-atomic-'));
  const file = path.join(root, 'knowledge.sqlite');
  const store = new Knowledge(file);
  await store.ready;
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "CREATE TRIGGER reject_synthetic BEFORE INSERT ON sources WHEN new.name='fail.pdf' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    const upload = { name: 'fail.pdf', data: Buffer.from('synthetic original').toString('base64') };
    await assert.rejects(store.importDocument('mock-alpha', upload, 'do not leave text behind'));
    assert.equal((await store.list('mock-alpha')).length, 0);
    assert.equal((await store.status()).revision, 0);
    const saved = await store.importDocument(
      'mock-alpha',
      { ...upload, name: 'good.pdf' },
      'preserve text',
    );
    db.prepare('UPDATE sources SET data=? WHERE document=?').run(
      Buffer.from('synthetic corruption'),
      saved.id,
    );
    await assert.rejects(store.source('mock-alpha', saved.id), { code: 'KNOWLEDGE_CORRUPT' });
    assert.equal((await store.read('mock-alpha', saved.id)).content, 'preserve text');
  } finally {
    db.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('imports retain immutable originals through edits, trash, restore and restart with scoped exact retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-import-'));
  let store = new Knowledge(path.join(root, 'knowledge.sqlite'));
  const data = Buffer.from('%PDF-1.7\nsynthetic-original');
  try {
    const input = { name: 'mock.pdf', data: data.toString('base64') };
    const first = await store.importDocument('mock-alpha', input, 'MOCK-PDF-47');
    assert.equal(first.path, 'mock.pdf.txt');
    assert.deepEqual(first.source, {
      name: input.name,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
    assert.deepEqual((await store.source('mock-alpha', first.id)).file, input);
    await assert.rejects(store.source('mock-beta', first.id), { code: 'KNOWLEDGE_NOT_FOUND' });
    const edited = await store.write('mock-alpha', {
      id: first.id,
      path: 'renamed.txt',
      revision: 1,
      content: 'human edit',
    });
    assert.deepEqual(
      (await store.importDocument('mock-alpha', input, 're-extracted')).id,
      first.id,
    );
    assert.equal((await store.read('mock-alpha', first.id)).content, edited.content);
    await assert.rejects(
      store.importDocument(
        'mock-alpha',
        { ...input, data: Buffer.from('different').toString('base64') },
        'different',
      ),
      { code: 'KNOWLEDGE_PATH_EXISTS' },
    );
    await store.remove('mock-alpha', first.id, 2);
    await assert.rejects(store.importDocument('mock-alpha', input, 'do not resurrect'), {
      code: 'KNOWLEDGE_PATH_EXISTS',
    });
    const restored = await store.restore('mock-alpha', first.id, 3, 1);
    assert.equal(restored.content, first.content);
    assert.deepEqual(restored.source, first.source);
    await store.close();
    store = new Knowledge(path.join(root, 'knowledge.sqlite'));
    assert.deepEqual((await store.source('mock-alpha', first.id)).file, input);
    const plain = await store.write('mock-alpha', {
      path: 'plain.txt',
      revision: 0,
      content: 'plain',
    });
    await assert.rejects(store.source('mock-alpha', plain.id), { code: 'KNOWLEDGE_NOT_FOUND' });
    assert.equal((await store.versions('mock-alpha', first.id)).length, 4);
    await assert.rejects(
      store.importDocument('mock-alpha', { name: 'bad.pdf', data: 'AA==' }, ''),
      { code: 'DOCUMENT_EMPTY' },
    );
    assert.equal((await store.list('mock-alpha')).length, 2);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('knowledge commits owned content and history atomically, rejects stale edits and restores without rewriting history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-knowledge-'));
  let store = new Knowledge(path.join(root, 'knowledge.sqlite'));
  try {
    assert.equal((await store.status()).revision, 0);
    const first = await store.write('mock-alpha', {
      path: '项目/规范.md',
      revision: 0,
      content: '保留原文\n代号 MOCK-ORION\n',
    });
    assert.equal(first.revision, 1);
    assert.equal((await store.status()).revision, 1);
    assert.deepEqual(
      await store.write('mock-alpha', { path: first.path, revision: 0, content: first.content }),
      first,
    );
    const beta = await store.write('mock-beta', {
      path: first.path,
      revision: 0,
      content: '只属于乙的合成资料',
    });
    assert.notEqual(beta.id, first.id);
    assert.equal((await store.list('mock-alpha')).length, 1);
    await assert.rejects(store.read('mock-beta', first.id), { code: 'KNOWLEDGE_NOT_FOUND' });
    await assert.rejects(store.remove('mock-beta', first.id, 1), { code: 'KNOWLEDGE_NOT_FOUND' });
    const edited = await store.edit('mock-alpha', first.id, 1, 'MOCK-ORION', 'MOCK-VEGA', {
      kind: 'bot',
      runId: 'mock-run',
    });
    assert.equal(edited.content, '保留原文\n代号 MOCK-VEGA\n');
    assert.equal(edited.revision, 2);
    await assert.rejects(store.edit('mock-alpha', first.id, 1, '保留', '不得覆盖'), {
      code: 'KNOWLEDGE_CONFLICT',
    });
    await assert.rejects(store.edit('mock-alpha', first.id, 2, '不存在', '新内容'), {
      code: 'KNOWLEDGE_EDIT_MISMATCH',
    });
    const renamed = await store.write('mock-alpha', {
      id: first.id,
      path: '项目/新规范.md',
      revision: 2,
      content: edited.content,
    });
    assert.equal(renamed.revision, 3);
    const removed = await store.remove('mock-alpha', first.id, 3);
    assert.equal(removed.deleted, true);
    assert.equal((await store.list('mock-alpha')).length, 0);
    assert.equal((await store.list('mock-alpha', true)).length, 1);
    assert.equal((await store.read('mock-alpha', first.id, 1)).content, first.content);
    const restored = await store.restore('mock-alpha', first.id, removed.revision, 1);
    assert.equal(restored.revision, 5);
    assert.equal(restored.content, first.content);
    assert.equal(restored.path, first.path);
    const versions = await store.versions('mock-alpha', first.id);
    assert.equal(versions.length, 5);
    assert.equal(versions.find((value) => value.revision === 2)!.actor, 'bot');
    assert.equal(versions.find((value) => value.revision === 4)!.deleted, true);
    assert.equal((await store.search('mock-alpha', 'MOCK-ORION')).length, 1);
    assert.equal((await store.read('mock-beta', beta.id)).content, beta.content);
    await store.close();
    store = new Knowledge(path.join(root, 'knowledge.sqlite'));
    assert.deepEqual(await store.read('mock-alpha', first.id), restored);
    assert.equal((await stat(path.join(root, 'knowledge.sqlite'))).mode & 0o777, 0o600);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('knowledge rejects unsafe paths, oversized data and cancelled mutations without destroying content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-knowledge-boundaries-'));
  const store = new Knowledge(path.join(root, 'knowledge.sqlite'));
  try {
    for (const name of [
      '   ',
      'a/ /b.md',
      '../escape.md',
      '/absolute.md',
      '.git/config',
      'a\\b.md',
      'a/../b.md',
      'a//b.md',
    ])
      await assert.rejects(
        store.write('mock-alpha', { path: name, revision: 0, content: '合成' }),
        { code: 'INVALID_KNOWLEDGE' },
      );
    await assert.rejects(
      store.write('mock-alpha', { path: 'large.md', revision: 0, content: '甲'.repeat(70000) }),
      { code: 'INVALID_KNOWLEDGE' },
    );
    await assert.rejects(
      store.write('mock-alpha', { path: 'bad.md', revision: 0, content: 'bad\0text' }),
      { code: 'INVALID_KNOWLEDGE' },
    );
    const first = await store.write('mock-alpha', {
      path: 'note.md',
      revision: 0,
      content: '保留 保留',
    });
    await assert.rejects(store.edit('mock-alpha', first.id, 1, '保留', '不能猜测哪一处'), {
      code: 'KNOWLEDGE_EDIT_AMBIGUOUS',
    });
    const abort = new AbortController();
    const pending = store.write(
      'mock-alpha',
      { id: first.id, path: first.path, revision: 1, content: '不得保存' },
      { kind: 'bot', runId: 'mock-run', signal: abort.signal },
    );
    abort.abort();
    await assert.rejects(pending);
    assert.equal((await store.read('mock-alpha', first.id)).content, first.content);
    assert.equal((await store.versions('mock-alpha', first.id)).length, 1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('portable knowledge snapshots atomically copy current text and originals and never replay over later edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-knowledge-bundle-'));
  const file = path.join(root, 'knowledge.sqlite');
  let store = new Knowledge(file);
  const digest = 'a'.repeat(64);
  const documents = [
    { path: 'mock/notes.md', content: 'SYNTHETIC TEXT' },
    {
      path: 'mock/edited.md',
      content: 'SYNTHETIC EDITED TEXT',
      original: { name: 'mock.pdf', data: Buffer.from('SYNTHETIC ORIGINAL').toString('base64') },
    },
  ];
  try {
    await store.ready;
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TRIGGER mock_import_failure BEFORE INSERT ON sources BEGIN SELECT RAISE(ABORT,'SYNTHETIC FAIL'); END;",
    );
    await assert.rejects(store.importBundle('mock-target', digest, documents));
    assert.deepEqual(await store.list('mock-target'), []);
    db.exec('DROP TRIGGER mock_import_failure');
    db.close();
    const copied = await store.importBundle('mock-target', digest, documents);
    assert.equal(copied.length, 2);
    assert.equal(
      (await store.source('mock-target', copied[1].id)).file.data,
      documents[1].original!.data,
    );
    const edited = await store.write('mock-target', {
      id: copied[0].id,
      revision: 1,
      path: copied[0].path,
      content: 'SYNTHETIC LATER EDIT',
    });
    await store.close();
    store = new Knowledge(file);
    const retry = await store.importBundle('mock-target', digest, documents);
    assert.equal(retry.find((item) => item.id === edited.id)?.content, edited.content);
    await assert.rejects(store.importBundle('mock-target', 'b'.repeat(64), documents), {
      code: 'KNOWLEDGE_IMPORT_CONFLICT',
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
