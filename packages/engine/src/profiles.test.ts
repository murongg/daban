import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isBotLifecycleRequest, isBotProfile, isBotProfileInput } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { privateMetadata, secureDirectory } from './private-files.js';
import { BotProfiles, personaKey } from './profiles.js';

test('read-only health reports retained corrupt records without exposing their identity or contents', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-profile-health-'));
  try {
    await writeFile(path.join(dir, 'mock-corrupt.json'), 'SYNTHETIC-INVALID-RECORD');
    const profiles = new BotProfiles(dir);
    expect(await profiles.status()).toStrictEqual({ available: true, corrupt: 1 });
    expect(await readFile(path.join(dir, 'mock-corrupt.json'), 'utf8')).toBe(
      'SYNTHETIC-INVALID-RECORD',
    );
    expect(await profiles.list()).toStrictEqual([]);
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
    expect.assert('model' in first);
    expect(first.model).toBe('deepseek-v4-pro');
    expect(Object.hasOwn(other, 'model')).toBe(false);
    expect((await profiles.update(first.id, 1, { model: 'deepseek-v4-pro' })).revision).toBe(1);
    const changed = await profiles.update(first.id, 1, { model: 'deepseek-flash' });
    expect(changed.revision).toBe(2);
    expect(changed.memory).toBe(input.memory);
    expect((await profiles.get(other.id))?.revision).toBe(1);
    await expect(profiles.update(first.id, 1, { model: null })).rejects.toMatchObject({
      code: 'BOT_PROFILE_CONFLICT',
    });
    const cleared = await profiles.update(first.id, 2, { model: null });
    expect(Object.hasOwn(cleared, 'model')).toBe(false);
    expect(cleared.revision).toBe(3);
    expect(cleared.instructions).toBe(input.instructions);
    expect(await new BotProfiles(root).get(first.id)).toStrictEqual(cleared);
    await expect(profiles.update(first.id, 3, { model: 'unknown-model' })).rejects.toMatchObject({
      code: 'INVALID_BOT_PROFILE',
    });
    await expect(
      profiles.register({ ...input, id: 'mock-bad', model: null }),
    ).rejects.toMatchObject({
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
    await expect(pending).rejects.toThrowError();
    expect(await store.get(input.id)).toStrictEqual(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('Bot profiles persist identity and memory, import missing records without overwriting, and serialize revisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-profiles-'));
  try {
    const store = new BotProfiles(root);
    const first = await store.register(input);
    expect(first.revision).toBe(1);
    const changed = await store.update(input.id, 1, { name: '新合成助手', memory: '新的合成偏好' });
    expect(changed.revision).toBe(2);
    expect((await store.register({ ...input, memory: '过时的本地副本' })).memory).toBe(
      '新的合成偏好',
    );
    await expect(store.update(input.id, 1, { name: '过时修改' })).rejects.toMatchObject({
      code: 'BOT_PROFILE_CONFLICT',
    });
    const same = await store.update(input.id, 2, { memory: '新的合成偏好' });
    expect(same.revision).toBe(2);
    const recovered = new BotProfiles(root);
    expect(await recovered.get(input.id)).toStrictEqual(changed);
    expect((await recovered.list()).length).toBe(1);
    await secureDirectory(root);
    const file = path.join(root, `${input.id}.json`);
    expect(await privateMetadata(file, await stat(file), 0o600)).toBe(true);
    expect.assert(
      (await readFile(path.join(root, `${input.id}.json`), 'utf8')).includes('新合成助手'),
    );
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
      await expect(store.register(bad)).rejects.toMatchObject({ code: 'INVALID_BOT_PROFILE' });
    await store.register(input);
    await expect(store.update(input.id, 1, { memory: 'x'.repeat(12001) })).rejects.toMatchObject({
      code: 'INVALID_BOT_PROFILE',
    });
    const file = path.join(root, 'broken.json');
    await writeFile(file, '{ synthetic incomplete');
    const recovered = new BotProfiles(root);
    await expect(recovered.register({ ...input, id: 'broken' })).rejects.toMatchObject({
      code: 'BOT_PROFILE_CORRUPT',
    });
    expect(await readFile(file, 'utf8')).toBe('{ synthetic incomplete');
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
    expect(store.admit('mock-legacy-without-profile')).toBe(true);
    const release = store.reserveLifecycle(input.id);
    try {
      expect(() => store.assertActive(input.id)).toThrowError(
        expect.objectContaining({ code: 'BOT_CHANGING' }),
      );
      const pending = await store.beginLifecycle(request);
      expect(pending.archived).toBe(true);
      expect(pending.lifecycle?.phase).toBe('pending');
      expect(pending.revision).toBe(2);
      expect(store.admit(input.id)).toBe(false);
      expect(store.admit(other.id)).toBe(true);
      expect(await store.register(input)).toStrictEqual(pending);
      await expect(
        store.update(input.id, 2, { memory: '不可覆盖的合成偏好' }),
      ).rejects.toMatchObject({
        code: 'BOT_CHANGING',
      });
      const archived = await store.finishLifecycle(input.id, request.id);
      expect(archived.revision).toBe(3);
      expect(archived.lifecycle?.phase).toBe('complete');
      expect(await store.beginLifecycle(request)).toStrictEqual(archived);
      await expect(store.beginLifecycle({ ...request, action: 'restore' })).rejects.toMatchObject({
        code: 'BOT_REQUEST_ID_REUSED',
      });
      expect(personaKey(archived)).toBe(personaKey(original));
      expect(archived.memory).toBe(original.memory);
      expect(archived.createdAt).toBe(original.createdAt);
    } finally {
      release();
    }
    expect(() => store.assertActive(input.id)).toThrowError(
      expect.objectContaining({ code: 'BOT_ARCHIVED' }),
    );
    store = new BotProfiles(root);
    await store.ready;
    expect(store.admit(input.id)).toBe(false);
    expect((await store.list()).length).toBe(2);
    expect((await store.get(input.id))?.memory).toBe(original.memory);
    const unlock = store.reserveLifecycle(input.id);
    try {
      const restored = await store.beginLifecycle({
        id: 'mock-restore',
        bot: input.id,
        action: 'restore',
        revision: 3,
      });
      expect(restored.archived).toBe(false);
      expect(restored.revision).toBe(4);
      expect(restored.lifecycle?.phase).toBe('complete');
      expect(restored.memory).toBe(original.memory);
      expect(personaKey(restored)).toBe(personaKey(original));
      await expect(store.beginLifecycle(request)).rejects.toMatchObject({
        code: 'BOT_PROFILE_CONFLICT',
      });
    } finally {
      unlock();
    }
    expect(store.admit(input.id)).toBe(true);
    expect(await store.get(other.id)).toStrictEqual(other);
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
      expect((await edit).revision).toBe(2);
      await expect(
        store.beginLifecycle({
          id: 'mock-stale-archive',
          bot: input.id,
          action: 'archive',
          revision: 1,
        }),
      ).rejects.toMatchObject({ code: 'BOT_PROFILE_CONFLICT' });
      await expect(store.update(input.id, 2, { memory: '较晚的合成修改' })).rejects.toMatchObject({
        code: 'BOT_CHANGING',
      });
      expect((await store.get(input.id))?.memory).toBe('合成已排队修改');
      expect((await store.get(input.id))?.archived).toBe(undefined);
    } finally {
      release();
    }
    expect(store.admit(input.id)).toBe(true);
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
    expect(isBotProfile(pending)).toBe(true);
    expect(isBotProfileInput(pending)).toBe(false);
    expect(isBotProfile({ ...pending, archived: false })).toBe(false);
    expect(
      isBotProfile({ ...pending, lifecycle: { ...pending.lifecycle, permissions: 'all' } }),
    ).toBe(false);
    expect(
      isBotLifecycleRequest({ id: 'mock-pending', bot: input.id, action: 'archive', revision: 1 }),
    ).toBe(true);
    expect(
      isBotLifecycleRequest({
        id: 'mock-pending',
        bot: input.id,
        action: 'archive',
        revision: 1,
        eraseFiles: true,
      }),
    ).toBe(false);
    expect(
      isBotLifecycleRequest({
        id: 'mock-max',
        bot: input.id,
        action: 'archive',
        revision: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(false);
    await expect(
      store.beginLifecycle({ id: 'mock-pending', bot: input.id, action: 'archive', revision: 1 }),
    ).rejects.toMatchObject({ code: 'BOT_LIFECYCLE_NOT_RESERVED' });
    const file = path.join(root, 'mock-broken.json');
    const bytes = JSON.stringify({
      version: 1,
      profile: { ...pending, id: 'mock-broken', archived: false },
    });
    await writeFile(file, bytes);
    const recovered = new BotProfiles(root);
    await recovered.ready;
    expect(recovered.admit('mock-broken')).toBe(false);
    expect(recovered.admit(input.id)).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(bytes);
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
    expect(store.admit(input.id)).toBe(false);
    current();
    expect(store.admit(input.id)).toBe(true);
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
    expect(created.model).toBe(undefined);
    const edited = await profiles.update(created.id, created.revision, { name: '合成后续编辑' });
    profiles = new BotProfiles(root);
    expect(await profiles.imported(created.id, origin)).toStrictEqual(edited);
    expect(await profiles.registerImport(input, origin)).toStrictEqual(edited);
    await expect(
      profiles.registerImport(input, { ...origin, sha256: 'b'.repeat(64) }),
    ).rejects.toMatchObject({
      code: 'BOT_IMPORT_CONFLICT',
    });
    await expect(
      profiles.registerImport({ ...input, id: 'mock-model', model: 'deepseek-v4-pro' }, origin),
    ).rejects.toMatchObject({ code: 'INVALID_BOT_IMPORT' });
    await profiles.register({ ...input, id: 'mock-existing' });
    await expect(
      profiles.registerImport({ ...input, id: 'mock-existing' }, origin),
    ).rejects.toMatchObject({
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
  const mocked = vi
    .spyOn(crypto, 'randomBytes')
    .mockImplementation((size: number) => Buffer.alloc(size, 1));
  syncBuiltinESMExports();
  try {
    const profiles = new BotProfiles(root);
    await expect(profiles.register(input)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(file, 'utf8')).toBe('SYNTHETIC PROTECTED FILE');
  } finally {
    mocked.mockRestore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
