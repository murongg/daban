import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
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
    await expect(
      store.importDocument('mock-alpha', upload, 'do not leave text behind'),
    ).rejects.toThrowError();
    expect((await store.list('mock-alpha')).length).toBe(0);
    expect((await store.status()).revision).toBe(0);
    const saved = await store.importDocument(
      'mock-alpha',
      { ...upload, name: 'good.pdf' },
      'preserve text',
    );
    db.prepare('UPDATE sources SET data=? WHERE document=?').run(
      Buffer.from('synthetic corruption'),
      saved.id,
    );
    await expect(store.source('mock-alpha', saved.id)).rejects.toMatchObject({
      code: 'KNOWLEDGE_CORRUPT',
    });
    expect((await store.read('mock-alpha', saved.id)).content).toBe('preserve text');
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
    expect(first.path).toBe('mock.pdf.txt');
    expect(first.source).toStrictEqual({
      name: input.name,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
    expect((await store.source('mock-alpha', first.id)).file).toStrictEqual(input);
    await expect(store.source('mock-beta', first.id)).rejects.toMatchObject({
      code: 'KNOWLEDGE_NOT_FOUND',
    });
    const edited = await store.write('mock-alpha', {
      id: first.id,
      path: 'renamed.txt',
      revision: 1,
      content: 'human edit',
    });
    expect((await store.importDocument('mock-alpha', input, 're-extracted')).id).toStrictEqual(
      first.id,
    );
    expect((await store.read('mock-alpha', first.id)).content).toBe(edited.content);
    await expect(
      store.importDocument(
        'mock-alpha',
        { ...input, data: Buffer.from('different').toString('base64') },
        'different',
      ),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_PATH_EXISTS' });
    await store.remove('mock-alpha', first.id, 2);
    await expect(
      store.importDocument('mock-alpha', input, 'do not resurrect'),
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_PATH_EXISTS',
    });
    const restored = await store.restore('mock-alpha', first.id, 3, 1);
    expect(restored.content).toBe(first.content);
    expect(restored.source).toStrictEqual(first.source);
    await store.close();
    store = new Knowledge(path.join(root, 'knowledge.sqlite'));
    expect((await store.source('mock-alpha', first.id)).file).toStrictEqual(input);
    const plain = await store.write('mock-alpha', {
      path: 'plain.txt',
      revision: 0,
      content: 'plain',
    });
    await expect(store.source('mock-alpha', plain.id)).rejects.toMatchObject({
      code: 'KNOWLEDGE_NOT_FOUND',
    });
    expect((await store.versions('mock-alpha', first.id)).length).toBe(4);
    await expect(
      store.importDocument('mock-alpha', { name: 'bad.pdf', data: 'AA==' }, ''),
    ).rejects.toMatchObject({ code: 'DOCUMENT_EMPTY' });
    expect((await store.list('mock-alpha')).length).toBe(2);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('knowledge commits owned content and history atomically, rejects stale edits and restores without rewriting history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-knowledge-'));
  let store = new Knowledge(path.join(root, 'knowledge.sqlite'));
  try {
    expect((await store.status()).revision).toBe(0);
    const first = await store.write('mock-alpha', {
      path: '项目/规范.md',
      revision: 0,
      content: '保留原文\n代号 MOCK-ORION\n',
    });
    expect(first.revision).toBe(1);
    expect((await store.status()).revision).toBe(1);
    expect(
      await store.write('mock-alpha', { path: first.path, revision: 0, content: first.content }),
    ).toStrictEqual(first);
    const beta = await store.write('mock-beta', {
      path: first.path,
      revision: 0,
      content: '只属于乙的合成资料',
    });
    expect(beta.id).not.toBe(first.id);
    expect((await store.list('mock-alpha')).length).toBe(1);
    await expect(store.read('mock-beta', first.id)).rejects.toMatchObject({
      code: 'KNOWLEDGE_NOT_FOUND',
    });
    await expect(store.remove('mock-beta', first.id, 1)).rejects.toMatchObject({
      code: 'KNOWLEDGE_NOT_FOUND',
    });
    const edited = await store.edit('mock-alpha', first.id, 1, 'MOCK-ORION', 'MOCK-VEGA', {
      kind: 'bot',
      runId: 'mock-run',
    });
    expect(edited.content).toBe('保留原文\n代号 MOCK-VEGA\n');
    expect(edited.revision).toBe(2);
    await expect(store.edit('mock-alpha', first.id, 1, '保留', '不得覆盖')).rejects.toMatchObject({
      code: 'KNOWLEDGE_CONFLICT',
    });
    await expect(store.edit('mock-alpha', first.id, 2, '不存在', '新内容')).rejects.toMatchObject({
      code: 'KNOWLEDGE_EDIT_MISMATCH',
    });
    const renamed = await store.write('mock-alpha', {
      id: first.id,
      path: '项目/新规范.md',
      revision: 2,
      content: edited.content,
    });
    expect(renamed.revision).toBe(3);
    const removed = await store.remove('mock-alpha', first.id, 3);
    expect(removed.deleted).toBe(true);
    expect((await store.list('mock-alpha')).length).toBe(0);
    expect((await store.list('mock-alpha', true)).length).toBe(1);
    expect((await store.read('mock-alpha', first.id, 1)).content).toBe(first.content);
    const restored = await store.restore('mock-alpha', first.id, removed.revision, 1);
    expect(restored.revision).toBe(5);
    expect(restored.content).toBe(first.content);
    expect(restored.path).toBe(first.path);
    const versions = await store.versions('mock-alpha', first.id);
    expect(versions.length).toBe(5);
    expect(versions.find((value) => value.revision === 2)!.actor).toBe('bot');
    expect(versions.find((value) => value.revision === 4)!.deleted).toBe(true);
    expect((await store.search('mock-alpha', 'MOCK-ORION')).length).toBe(1);
    expect((await store.read('mock-beta', beta.id)).content).toBe(beta.content);
    await store.close();
    store = new Knowledge(path.join(root, 'knowledge.sqlite'));
    expect(await store.read('mock-alpha', first.id)).toStrictEqual(restored);
    expect((await stat(path.join(root, 'knowledge.sqlite'))).mode & 0o777).toBe(0o600);
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
      await expect(
        store.write('mock-alpha', { path: name, revision: 0, content: '合成' }),
      ).rejects.toMatchObject({ code: 'INVALID_KNOWLEDGE' });
    await expect(
      store.write('mock-alpha', { path: 'large.md', revision: 0, content: '甲'.repeat(70000) }),
    ).rejects.toMatchObject({ code: 'INVALID_KNOWLEDGE' });
    await expect(
      store.write('mock-alpha', { path: 'bad.md', revision: 0, content: 'bad\0text' }),
    ).rejects.toMatchObject({ code: 'INVALID_KNOWLEDGE' });
    const first = await store.write('mock-alpha', {
      path: 'note.md',
      revision: 0,
      content: '保留 保留',
    });
    await expect(
      store.edit('mock-alpha', first.id, 1, '保留', '不能猜测哪一处'),
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_EDIT_AMBIGUOUS',
    });
    const abort = new AbortController();
    const pending = store.write(
      'mock-alpha',
      { id: first.id, path: first.path, revision: 1, content: '不得保存' },
      { kind: 'bot', runId: 'mock-run', signal: abort.signal },
    );
    abort.abort();
    await expect(pending).rejects.toThrowError();
    expect((await store.read('mock-alpha', first.id)).content).toBe(first.content);
    expect((await store.versions('mock-alpha', first.id)).length).toBe(1);
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
    await expect(store.importBundle('mock-target', digest, documents)).rejects.toThrowError();
    expect(await store.list('mock-target')).toStrictEqual([]);
    db.exec('DROP TRIGGER mock_import_failure');
    db.close();
    const copied = await store.importBundle('mock-target', digest, documents);
    expect(copied.length).toBe(2);
    expect((await store.source('mock-target', copied[1].id)).file.data).toBe(
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
    expect(retry.find((item) => item.id === edited.id)?.content).toBe(edited.content);
    await expect(
      store.importBundle('mock-target', 'b'.repeat(64), documents),
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_IMPORT_CONFLICT',
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
