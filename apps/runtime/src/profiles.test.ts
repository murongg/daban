import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { isBotLifecycleRequest, isBotProfile, isBotProfileInput } from '@daban/protocol';
import { BotProfiles, personaKey } from './profiles.js';

test('read-only health reports retained corrupt records without exposing their identity or contents', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-profile-health-'));
  try {
    await writeFile(path.join(dir, 'mock-corrupt.json'), 'SYNTHETIC-INVALID-RECORD');
    const profiles = new BotProfiles(dir);
    assert.deepEqual(await profiles.status(), { available: true, corrupt: 1 });
    assert.equal(
      await readFile(path.join(dir, 'mock-corrupt.json'), 'utf8'),
      'SYNTHETIC-INVALID-RECORD',
    );
    assert.deepEqual(await profiles.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const input = {
  id: 'mock-persona',
  name: '合成助手',
  instructions: '先给结论，使用简洁中文。',
  memory: '合成偏好：使用编号。',
  color: 'violet' as const,
};
test('model overrides persist independently, clear back to inheritance, and share profile CAS without changing memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-profile-models-'));
  try {
    const profiles = new BotProfiles(root);
    await profiles.ready;
    const first = await profiles.register({ ...input, model: 'deepseek-v4-pro' });
    const other = await profiles.register({ ...input, id: 'mock-other' });
    assert.ok('model' in first);
    assert.equal(first.model, 'deepseek-v4-pro');
    assert.equal(Object.hasOwn(other, 'model'), false);
    assert.equal((await profiles.update(first.id, 1, { model: 'deepseek-v4-pro' })).revision, 1);
    const changed = await profiles.update(first.id, 1, { model: 'deepseek-flash' });
    assert.equal(changed.revision, 2);
    assert.equal(changed.memory, input.memory);
    assert.equal((await profiles.get(other.id))?.revision, 1);
    await assert.rejects(profiles.update(first.id, 1, { model: null }), {
      code: 'BOT_PROFILE_CONFLICT',
    });
    const cleared = await profiles.update(first.id, 2, { model: null });
    assert.equal(Object.hasOwn(cleared, 'model'), false);
    assert.equal(cleared.revision, 3);
    assert.equal(cleared.instructions, input.instructions);
    assert.deepEqual(await new BotProfiles(root).get(first.id), cleared);
    await assert.rejects(profiles.update(first.id, 3, { model: 'unknown-model' }), {
      code: 'INVALID_BOT_PROFILE',
    });
    await assert.rejects(profiles.register({ ...input, id: 'mock-bad', model: null }), {
      code: 'INVALID_BOT_PROFILE',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('cancelled queued memory edits never replace the durable profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-memory-cancel-'));
  try {
    const store = new BotProfiles(root);
    const original = await store.register(input);
    const abort = new AbortController();
    const pending = store.update(input.id, 1, { memory: '不得保存的合成偏好' }, abort.signal);
    abort.abort();
    await assert.rejects(pending);
    assert.deepEqual(await store.get(input.id), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('Bot profiles persist identity and memory, import missing records without overwriting, and serialize revisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-profiles-'));
  try {
    const store = new BotProfiles(root);
    const first = await store.register(input);
    assert.equal(first.revision, 1);
    const changed = await store.update(input.id, 1, { name: '新合成助手', memory: '新的合成偏好' });
    assert.equal(changed.revision, 2);
    assert.equal(
      (await store.register({ ...input, memory: '过时的本地副本' })).memory,
      '新的合成偏好',
    );
    await assert.rejects(store.update(input.id, 1, { name: '过时修改' }), {
      code: 'BOT_PROFILE_CONFLICT',
    });
    const same = await store.update(input.id, 2, { memory: '新的合成偏好' });
    assert.equal(same.revision, 2);
    const recovered = new BotProfiles(root);
    assert.deepEqual(await recovered.get(input.id), changed);
    assert.equal((await recovered.list()).length, 1);
    assert.equal((await stat(path.join(root, `${input.id}.json`))).mode & 0o777, 0o600);
    assert.ok((await readFile(path.join(root, `${input.id}.json`), 'utf8')).includes('新合成助手'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('profile boundary rejects unknown fields, invalid IDs and corrupt records without destroying them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-profile-validation-'));
  try {
    const store = new BotProfiles(root);
    for (const bad of [
      { ...input, id: '../escape' },
      { ...input, name: '' },
      { ...input, color: 'unknown' },
      { ...input, instructions: 'x'.repeat(4001) },
      { ...input, apiKey: 'synthetic-never-accepted' },
    ])
      await assert.rejects(store.register(bad), { code: 'INVALID_BOT_PROFILE' });
    await store.register(input);
    await assert.rejects(store.update(input.id, 1, { memory: 'x'.repeat(12001) }), {
      code: 'INVALID_BOT_PROFILE',
    });
    const file = path.join(root, 'broken.json');
    await writeFile(file, '{ synthetic incomplete');
    const recovered = new BotProfiles(root);
    await assert.rejects(recovered.register({ ...input, id: 'broken' }), {
      code: 'BOT_PROFILE_CORRUPT',
    });
    assert.equal(await readFile(file, 'utf8'), '{ synthetic incomplete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive intent persists before cleanup, fences admission and preserves identity through an exact restore', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-profile-lifecycle-'));
  try {
    let store = new BotProfiles(root);
    const original = await store.register(input);
    const other = await store.register({ ...input, id: 'constructor' });
    const request = { id: 'mock-archive', bot: input.id, action: 'archive' as const, revision: 1 };
    assert.equal(store.admit('mock-legacy-without-profile'), true);
    const release = store.reserveLifecycle(input.id);
    try {
      assert.throws(() => store.assertActive(input.id), { code: 'BOT_CHANGING' });
      const pending = await store.beginLifecycle(request);
      assert.equal(pending.archived, true);
      assert.equal(pending.lifecycle?.phase, 'pending');
      assert.equal(pending.revision, 2);
      assert.equal(store.admit(input.id), false);
      assert.equal(store.admit(other.id), true);
      assert.deepEqual(await store.register(input), pending);
      await assert.rejects(store.update(input.id, 2, { memory: '不可覆盖的合成偏好' }), {
        code: 'BOT_CHANGING',
      });
      const archived = await store.finishLifecycle(input.id, request.id);
      assert.equal(archived.revision, 3);
      assert.equal(archived.lifecycle?.phase, 'complete');
      assert.deepEqual(await store.beginLifecycle(request), archived);
      await assert.rejects(store.beginLifecycle({ ...request, action: 'restore' }), {
        code: 'BOT_REQUEST_ID_REUSED',
      });
      assert.equal(personaKey(archived), personaKey(original));
      assert.equal(archived.memory, original.memory);
      assert.equal(archived.createdAt, original.createdAt);
    } finally {
      release();
    }
    assert.throws(() => store.assertActive(input.id), { code: 'BOT_ARCHIVED' });
    store = new BotProfiles(root);
    await store.ready;
    assert.equal(store.admit(input.id), false);
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.get(input.id))?.memory, original.memory);
    const unlock = store.reserveLifecycle(input.id);
    try {
      const restored = await store.beginLifecycle({
        id: 'mock-restore',
        bot: input.id,
        action: 'restore',
        revision: 3,
      });
      assert.equal(restored.archived, false);
      assert.equal(restored.revision, 4);
      assert.equal(restored.lifecycle?.phase, 'complete');
      assert.equal(restored.memory, original.memory);
      assert.equal(personaKey(restored), personaKey(original));
      await assert.rejects(store.beginLifecycle(request), { code: 'BOT_PROFILE_CONFLICT' });
    } finally {
      unlock();
    }
    assert.equal(store.admit(input.id), true);
    assert.deepEqual(await store.get(other.id), other);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a profile edit queued first wins over stale archive, while later edits are fenced', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-profile-order-'));
  try {
    const store = new BotProfiles(root);
    await store.register(input);
    const edit = store.update(input.id, 1, { memory: '合成已排队修改' });
    const release = store.reserveLifecycle(input.id);
    try {
      assert.equal((await edit).revision, 2);
      await assert.rejects(
        store.beginLifecycle({
          id: 'mock-stale-archive',
          bot: input.id,
          action: 'archive',
          revision: 1,
        }),
        { code: 'BOT_PROFILE_CONFLICT' },
      );
      await assert.rejects(store.update(input.id, 2, { memory: '较晚的合成修改' }), {
        code: 'BOT_CHANGING',
      });
      assert.equal((await store.get(input.id))?.memory, '合成已排队修改');
      assert.equal((await store.get(input.id))?.archived, undefined);
    } finally {
      release();
    }
    assert.equal(store.admit(input.id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lifecycle metadata is closed and read-only; corrupt transitions are retained without reviving the Bot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-profile-transition-'));
  try {
    const store = new BotProfiles(root);
    const original = await store.register(input);
    const pending = {
      ...original,
      revision: 2,
      archived: true,
      lifecycle: { id: 'mock-pending', action: 'archive', phase: 'pending', baseRevision: 1 },
    };
    assert.equal(isBotProfile(pending), true);
    assert.equal(isBotProfileInput(pending), false);
    assert.equal(isBotProfile({ ...pending, archived: false }), false);
    assert.equal(
      isBotProfile({ ...pending, lifecycle: { ...pending.lifecycle, permissions: 'all' } }),
      false,
    );
    assert.equal(
      isBotLifecycleRequest({ id: 'mock-pending', bot: input.id, action: 'archive', revision: 1 }),
      true,
    );
    assert.equal(
      isBotLifecycleRequest({
        id: 'mock-pending',
        bot: input.id,
        action: 'archive',
        revision: 1,
        eraseFiles: true,
      }),
      false,
    );
    assert.equal(
      isBotLifecycleRequest({
        id: 'mock-max',
        bot: input.id,
        action: 'archive',
        revision: Number.MAX_SAFE_INTEGER,
      }),
      false,
    );
    await assert.rejects(
      store.beginLifecycle({ id: 'mock-pending', bot: input.id, action: 'archive', revision: 1 }),
      { code: 'BOT_LIFECYCLE_NOT_RESERVED' },
    );
    const file = path.join(root, 'mock-broken.json');
    const bytes = JSON.stringify({
      version: 1,
      profile: { ...pending, id: 'mock-broken', archived: false },
    });
    await writeFile(file, bytes);
    const recovered = new BotProfiles(root);
    await recovered.ready;
    assert.equal(recovered.admit('mock-broken'), false);
    assert.equal(recovered.admit(input.id), true);
    assert.equal(await readFile(file, 'utf8'), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a repeated reservation release cannot unlock a newer lifecycle operation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-profile-reservation-'));
  try {
    const store = new BotProfiles(root);
    await store.register(input);
    const old = store.reserveLifecycle(input.id);
    old();
    const current = store.reserveLifecycle(input.id);
    old();
    assert.equal(store.admit(input.id), false);
    current();
    assert.equal(store.admit(input.id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('portable creation retains an origin receipt across restart/edits, never replaces an existing identity and inherits the workspace model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-profile-import-'));
  const origin = { id: 'mock-import', sha256: 'a'.repeat(64) };
  try {
    let profiles = new BotProfiles(root);
    const created = await profiles.registerImport(input, origin);
    assert.equal(created.model, undefined);
    const edited = await profiles.update(created.id, created.revision, { name: '合成后续编辑' });
    profiles = new BotProfiles(root);
    assert.deepEqual(await profiles.imported(created.id, origin), edited);
    assert.deepEqual(await profiles.registerImport(input, origin), edited);
    await assert.rejects(profiles.registerImport(input, { ...origin, sha256: 'b'.repeat(64) }), {
      code: 'BOT_IMPORT_CONFLICT',
    });
    await assert.rejects(
      profiles.registerImport({ ...input, id: 'mock-model', model: 'deepseek-v4-pro' }, origin),
      { code: 'INVALID_BOT_IMPORT' },
    );
    await profiles.register({ ...input, id: 'mock-existing' });
    await assert.rejects(profiles.registerImport({ ...input, id: 'mock-existing' }, origin), {
      code: 'BOT_IMPORT_CONFLICT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile commits do not remove an unclaimed colliding temporary file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-profile-collision-'));
  const file = path.join(root, `${input.id}.json.${'01'.repeat(8)}.tmp`);
  await writeFile(file, 'SYNTHETIC PROTECTED FILE');
  const mocked = mock.method(crypto, 'randomBytes', (size: number) => Buffer.alloc(size, 1));
  syncBuiltinESMExports();
  try {
    const profiles = new BotProfiles(root);
    await assert.rejects(profiles.register(input), { code: 'EEXIST' });
    assert.equal(await readFile(file, 'utf8'), 'SYNTHETIC PROTECTED FILE');
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
