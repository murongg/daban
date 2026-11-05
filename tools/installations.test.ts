import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Installations } from '../packages/engine/src/installations.js';
import { ReleaseStore } from '../packages/engine/src/releases.js';
import { syntheticRelease } from './testing/releases.js';

test('installations commit complete snapshots, rebase conflicts and replay after restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-release-store-'));
  let store = new ReleaseStore(dir);
  try {
    await store.ready;
    let installs = new Installations(store);
    const original = await store.save(syntheticRelease());
    const installed = await installs.install('mock-install', original.digest);
    expect((await installs.install('mock-install', original.digest)).botId).toBe(installed.botId);
    expect((await installs.install('mock-second-install', original.digest)).botId).not.toBe(
      installed.botId,
    );
    const pinned = installs.capture(installed.botId)!;
    const local = structuredClone(pinned.definition);
    local.profile.instructions = 'SYNTHETIC LOCAL';
    installs.edit(installed.botId, installed.revision, local, 'mock-edit');
    const next = syntheticRelease('1.1.0');
    next.definition.profile.instructions = 'SYNTHETIC UPSTREAM';
    const saved = await store.save(next);
    const plan = await installs.prepare(installed.botId, saved.digest);
    expect(plan.conflicts).toEqual(['instructions']);
    expect(() => installs.commit(plan.id, {}, 'mock-upgrade')).toThrow('INSTALLATION_CONFLICT');
    const upgraded = installs.commit(plan.id, { instructions: 'local' }, 'mock-upgrade');
    expect(upgraded.releaseVersion).toBe('1.1.0');
    expect(installs.capture(installed.botId)!.definition.profile.instructions).toBe(
      'SYNTHETIC LOCAL',
    );
    expect(pinned.definition.profile.instructions).toBe('仅处理用户提供的合成输入。');
    store.close();
    store = new ReleaseStore(dir);
    await store.ready;
    installs = new Installations(store);
    expect(installs.receipt('mock-upgrade')).toEqual(upgraded);
    const rollback = await installs.prepareRollback(installed.botId, installed.revision);
    const restored = installs.commit(rollback.id, {}, 'mock-rollback');
    expect(restored.revision).toBeGreaterThan(upgraded.revision);
    expect(restored.releaseVersion).toBe('1.0.0');
    const stale = await installs.prepare(installed.botId, saved.digest);
    installs.edit(installed.botId, restored.revision, local, 'mock-edit-again');
    expect(() => installs.commit(stale.id, {}, 'mock-stale')).toThrow('INSTALLATION_CONFLICT');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
