import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBotCopyReceipt, isBotCopyRequest } from '@daban/protocol';
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
    assert.deepEqual(await profiles.copyReceipt(request), { request, state: 'unknown' });
    const ack = await profiles.copy(request);
    assert.equal(ack.state, 'complete');
    assert.deepEqual(ack.request, request);
    assert.deepEqual(ack.profile, {
      ...original,
      id: request.id,
      name: request.name,
      revision: 1,
      createdAt: ack.profile.createdAt,
      updatedAt: ack.profile.updatedAt,
    });
    assert.notEqual(ack.profile.id, original.id);
    assert.equal(ack.profile.archived, undefined);
    assert.equal(ack.profile.lifecycle, undefined);
    assert.deepEqual(await readFile(path.join(root, `${source.id}.json`)), before);
    const history = await profiles.history(request.id, {});
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].content, source.memory);
    assert.equal((await profiles.list()).length, 2);
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
    assert.deepEqual(await profiles.copyReceipt(request), {
      request,
      state: 'complete',
      profile: edited,
    });
    assert.deepEqual(await profiles.copy(request), { request, state: 'complete', profile: edited });
    assert.deepEqual(await readFile(path.join(root, `${request.id}.json`)), bytes);
    assert.equal((await profiles.list()).length, 2);
    await assert.rejects(profiles.copy({ ...request, name: '合成不同请求' }), {
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
    await assert.rejects(profiles.copy(request), { code: 'BOT_PROFILE_CONFLICT' });
    assert.equal(await profiles.get(request.id), undefined);
    const release = profiles.reserveLifecycle(source.id);
    await assert.rejects(profiles.copy({ ...request, revision: 2 }), { code: 'BOT_CHANGING' });
    release();
    await profiles.register({ ...source, id: request.id, name: '合成独立资料' });
    const before = await profiles.get(request.id);
    await assert.rejects(profiles.copy({ ...request, revision: 2 }), { code: 'BOT_COPY_CONFLICT' });
    await assert.rejects(profiles.copyReceipt({ ...request, revision: 2 }), {
      code: 'BOT_COPY_CONFLICT',
    });
    assert.deepEqual(await profiles.get(request.id), before);
    await assert.rejects(profiles.copy({ ...request, id: source.id, revision: 2 }), {
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
    assert.equal(ack.profile.memory, '');
    assert.equal(Object.hasOwn(ack.profile, 'model'), false);
    const history = await profiles.history(request.id, {});
    assert.deepEqual(
      history.items.map((item) => item.content),
      [''],
    );
    assert.equal((await profiles.get(source.id))?.memory, 'MOCK-SECOND-PREFERENCE');
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
      await assert.rejects(profiles.copy(value), { code: 'INVALID_BOT_COPY' });
      await assert.rejects(profiles.copyReceipt(value), { code: 'INVALID_BOT_COPY' });
    }
    assert.deepEqual(await profiles.list(), [original]);
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
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
    assert.equal((await profiles.list()).length, 2);
    const receipt = results[0];
    assert.equal(isBotCopyRequest(request), true);
    assert.equal(isBotCopyReceipt(receipt), true);
    assert.equal(isBotCopyReceipt({ request, state: 'unknown' }), true);
    for (const invalid of [
      { ...receipt, profile: { ...receipt.profile, id: source.id } },
      { ...receipt, profile: { ...receipt.profile, token: 'MOCK-NOT-AUTHORITY' } },
      { ...receipt, allowComputer: true },
      { request, state: 'unknown', profile: receipt.profile },
      { ...receipt, request: { ...request, id: source.id } },
    ])
      assert.equal(isBotCopyReceipt(invalid), false);
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
    assert.equal(archived?.archived, true);
    assert.deepEqual((await profiles.copy(request)).profile, archived);
    await assert.rejects(profiles.copy({ ...request, id: 'mock-not-created', revision: 3 }), {
      code: 'BOT_ARCHIVED',
    });
    assert.equal(await profiles.get('mock-not-created'), undefined);
    assert.equal((await profiles.get(source.id))?.archived, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
