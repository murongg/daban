import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isBotCopyReceipt, isBotCopyRequest } from '@daban/protocol';
import { expect, test } from 'vitest';
import { BotProfiles } from './profiles.js';

const source = {
  id: 'mock-source',
  name: '合成原件',
  instructions: 'MOCK-PERSONA',
  memory: 'MOCK-PREFERENCE',
  color: 'violet' as const,
  model: 'deepseek-v4-pro' as const,
};
const request = { id: 'mock-copy', bot: source.id, revision: 1, name: '合成副本', memory: true };

test('copies saved persona/model/preferences into an independent identity and current-only memory baseline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-profile-copy-'));
  try {
    const profiles = new BotProfiles(root);
    const original = await profiles.register(source);
    const before = await readFile(path.join(root, `${source.id}.json`));
    expect(await profiles.copyReceipt(request)).toStrictEqual({ request, state: 'unknown' });
    const ack = await profiles.copy(request);
    expect(ack.state).toBe('complete');
    expect(ack.request).toStrictEqual(request);
    expect(ack.profile).toStrictEqual({
      ...original,
      id: request.id,
      name: request.name,
      revision: 1,
      createdAt: ack.profile.createdAt,
      updatedAt: ack.profile.updatedAt,
    });
    expect(ack.profile.id).not.toBe(original.id);
    expect(ack.profile.archived).toBe(undefined);
    expect(ack.profile.lifecycle).toBe(undefined);
    expect(await readFile(path.join(root, `${source.id}.json`))).toStrictEqual(before);
    const history = await profiles.history(request.id, {});
    expect(history.items.length).toBe(1);
    expect(history.items[0].content).toBe(source.memory);
    expect((await profiles.list()).length).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exact copy replay survives reconstruction and preserves later target edits after source changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-replay-'));
  try {
    let profiles = new BotProfiles(root);
    await profiles.register(source);
    const first = await profiles.copy(request);
    const edited = await profiles.update(request.id, first.profile.revision, {
      name: '合成后续编辑',
      memory: 'MOCK-LATER-PREFERENCE',
      model: null,
    });
    await profiles.update(source.id, 1, { instructions: 'MOCK-CHANGED-SOURCE' });
    profiles = new BotProfiles(root);
    const bytes = await readFile(path.join(root, `${request.id}.json`));
    expect(await profiles.copyReceipt(request)).toStrictEqual({
      request,
      state: 'complete',
      profile: edited,
    });
    expect(await profiles.copy(request)).toStrictEqual({
      request,
      state: 'complete',
      profile: edited,
    });
    expect(await readFile(path.join(root, `${request.id}.json`))).toStrictEqual(bytes);
    expect((await profiles.list()).length).toBe(2);
    await expect(profiles.copy({ ...request, name: '合成不同请求' })).rejects.toMatchObject({
      code: 'BOT_COPY_CONFLICT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects stale or changing source admission and occupied identities without writing a copy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-conflict-'));
  try {
    const profiles = new BotProfiles(root);
    await profiles.register(source);
    await profiles.update(source.id, 1, { instructions: 'MOCK-NEW-ROLE' });
    await expect(profiles.copy(request)).rejects.toMatchObject({ code: 'BOT_PROFILE_CONFLICT' });
    expect(await profiles.get(request.id)).toBe(undefined);
    const release = profiles.reserveLifecycle(source.id);
    await expect(profiles.copy({ ...request, revision: 2 })).rejects.toMatchObject({
      code: 'BOT_CHANGING',
    });
    release();
    await profiles.register({ ...source, id: request.id, name: '合成独立资料' });
    const before = await profiles.get(request.id);
    await expect(profiles.copy({ ...request, revision: 2 })).rejects.toMatchObject({
      code: 'BOT_COPY_CONFLICT',
    });
    await expect(profiles.copyReceipt({ ...request, revision: 2 })).rejects.toMatchObject({
      code: 'BOT_COPY_CONFLICT',
    });
    expect(await profiles.get(request.id)).toStrictEqual(before);
    await expect(profiles.copy({ ...request, id: source.id, revision: 2 })).rejects.toMatchObject({
      code: 'INVALID_BOT_COPY',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('can omit preferences and preserves inherited model policy without copying source history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-inherited-'));
  try {
    const profiles = new BotProfiles(root);
    await profiles.register({ ...source, model: undefined });
    await profiles.update(source.id, 1, { memory: 'MOCK-SECOND-PREFERENCE' });
    const ack = await profiles.copy({ ...request, revision: 2, memory: false });
    expect(ack.profile.memory).toBe('');
    expect(Object.hasOwn(ack.profile, 'model')).toBe(false);
    const history = await profiles.history(request.id, {});
    expect(history.items.map((item) => item.content)).toStrictEqual(['']);
    expect((await profiles.get(source.id))?.memory).toBe('MOCK-SECOND-PREFERENCE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed copy requests before changing any profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-validation-'));
  try {
    const profiles = new BotProfiles(root);
    const original = await profiles.register(source);
    for (const value of [
      { ...request, id: '../mock-outside' },
      { ...request, id: 'research' },
      { ...request, id: 'writer' },
      { ...request, revision: 0 },
      { ...request, name: '   ' },
      { ...request, name: 'x'.repeat(31) },
      { ...request, memory: 'yes' },
      { ...request, runImmediately: true },
    ]) {
      await expect(profiles.copy(value)).rejects.toMatchObject({ code: 'INVALID_BOT_COPY' });
      await expect(profiles.copyReceipt(value)).rejects.toMatchObject({ code: 'INVALID_BOT_COPY' });
    }
    expect(await profiles.list()).toStrictEqual([original]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent exact retries create one target and public receipts reject foreign or extra authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-concurrent-'));
  try {
    const profiles = new BotProfiles(root);
    await profiles.register(source);
    const results = await Promise.all([
      profiles.copy(request),
      profiles.copy(request),
      profiles.copy(request),
    ]);
    expect(results[1]).toStrictEqual(results[0]);
    expect(results[2]).toStrictEqual(results[0]);
    expect((await profiles.list()).length).toBe(2);
    const receipt = results[0];
    expect(isBotCopyRequest(request)).toBe(true);
    expect(isBotCopyReceipt(receipt)).toBe(true);
    expect(isBotCopyReceipt({ request, state: 'unknown' })).toBe(true);
    for (const invalid of [
      { ...receipt, profile: { ...receipt.profile, id: source.id } },
      { ...receipt, profile: { ...receipt.profile, token: 'MOCK-NOT-AUTHORITY' } },
      { ...receipt, allowComputer: true },
      { request, state: 'unknown', profile: receipt.profile },
      { ...receipt, request: { ...request, id: source.id } },
    ])
      expect(isBotCopyReceipt(invalid)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a settled receipt survives source and target archive without restoring either identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-archive-'));
  try {
    let profiles = new BotProfiles(root);
    await profiles.register(source);
    await profiles.copy(request);
    for (const id of [source.id, request.id]) {
      const release = profiles.reserveLifecycle(id);
      await profiles.beginLifecycle({
        id: `mock-archive-${id}`,
        bot: id,
        action: 'archive',
        revision: 1,
      });
      await profiles.finishLifecycle(id, `mock-archive-${id}`);
      release();
    }
    profiles = new BotProfiles(root);
    const archived = await profiles.get(request.id);
    expect(archived?.archived).toBe(true);
    expect((await profiles.copy(request)).profile).toStrictEqual(archived);
    await expect(
      profiles.copy({ ...request, id: 'mock-not-created', revision: 3 }),
    ).rejects.toMatchObject({
      code: 'BOT_ARCHIVED',
    });
    expect(await profiles.get('mock-not-created')).toBe(undefined);
    expect((await profiles.get(source.id))?.archived).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
