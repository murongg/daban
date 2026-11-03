import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MemoryPage } from '@daban/protocol';
import { expect, test } from 'vitest';
import { BotProfiles, personaKey } from './profiles.js';

const input = {
  id: 'mock-memory',
  name: '合成偏好助手',
  instructions: '合成职责',
  memory: 'SYNTHETIC ORIGINAL',
  color: 'mint' as const,
};
test('legacy preferences get one truthful baseline, distinct saved versions survive reconstruction and ordinary edits do not duplicate them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-memory-versions-'));
  try {
    const legacy = {
      ...input,
      revision: 5,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    };
    const file = path.join(root, `${input.id}.json`);
    const old = JSON.stringify({ version: 1, profile: legacy });
    await writeFile(file, old);
    const profiles = new BotProfiles(root);
    const baseline: MemoryPage = await profiles.history(input.id, {});
    expect(
      baseline.items.map((item) => ({
        revision: item.revision,
        content: item.content,
        source: item.source,
      })),
    ).toStrictEqual([{ revision: 5, content: input.memory, source: 'baseline' }]);
    expect(
      await readFile(file, 'utf8'),
      'history reading must not migrate or rewrite a legacy file',
    ).toBe(old);
    const saved = await profiles.update(input.id, 5, { memory: 'SYNTHETIC NEXT' });
    const renamed = await profiles.update(input.id, saved.revision, { name: '合成新名称' });
    expect(
      (await profiles.update(input.id, renamed.revision, { memory: 'SYNTHETIC NEXT' })).revision,
    ).toBe(renamed.revision);
    const restored = new BotProfiles(root);
    const page: MemoryPage = await restored.history(input.id, {});
    expect(page.profileRevision).toBe(7);
    expect(page.currentRevision).toBe(6);
    expect(page.items.map((item) => item.content)).toStrictEqual([
      'SYNTHETIC NEXT',
      'SYNTHETIC ORIGINAL',
    ]);
    expect(personaKey(saved)).toBe(personaKey(legacy));
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2);
    await expect(
      restored.update(input.id, 5, { memory: 'STALE SYNTHETIC EDIT' }),
    ).rejects.toMatchObject({
      code: 'BOT_PROFILE_CONFLICT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded complete memory pages isolate Bot ownership and retain the newest and prior saved values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-memory-budget-'));
  try {
    const profiles = new BotProfiles(root);
    let current = await profiles.register(input);
    await profiles.register({ ...input, id: 'mock-other', memory: 'SYNTHETIC OTHER' });
    for (let revision = 0; revision < 62; revision++)
      current = await profiles.update(input.id, current.revision, {
        memory: `SYNTHETIC-${revision}`,
      });
    const first: MemoryPage = await profiles.history(input.id, {});
    expect(first.items.length).toBe(5);
    expect(first.limited).toBe(true);
    expect(first.items[0].content).toBe('SYNTHETIC-61');
    expect(first.items[1].content).toBe('SYNTHETIC-60');
    const second: MemoryPage = await profiles.history(input.id, { before: first.nextBefore });
    expect.assert(second.items.every((item) => item.revision < first.items.at(-1)!.revision));
    expect((await profiles.history('mock-other', {})).items[0].content).toBe('SYNTHETIC OTHER');
    const stored = JSON.parse(await readFile(path.join(root, `${input.id}.json`), 'utf8'));
    expect.assert(stored.memoryHistory.items.length <= 50);
    expect.assert(Buffer.byteLength(JSON.stringify(stored.memoryHistory)) <= 384 * 1024);
    for (let revision = 0; revision < 15; revision++)
      current = await profiles.update(input.id, current.revision, {
        memory: `LARGE-SYNTHETIC-${revision}:${'中'.repeat(11960)}`,
      });
    const large = JSON.parse(await readFile(path.join(root, `${input.id}.json`), 'utf8'));
    expect.assert(Buffer.byteLength(JSON.stringify(large.memoryHistory)) <= 384 * 1024);
    expect.assert(large.memoryHistory.items.length >= 2);
    expect(large.profile.memory).toBe(current.memory);
    await expect(profiles.history(input.id, { before: 0 })).rejects.toMatchObject({
      code: 'INVALID_MEMORY_QUERY',
    });
    await expect(profiles.history('missing', {})).rejects.toMatchObject({
      code: 'BOT_PROFILE_NOT_FOUND',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('damaged history keeps current preferences readable but never silently resets or overwrites its saved record', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-memory-damaged-'));
  try {
    const profiles = new BotProfiles(root);
    const profile = await profiles.register(input);
    const file = path.join(root, `${input.id}.json`),
      record = JSON.parse(await readFile(file, 'utf8'));
    record.memoryHistory = {
      items: [
        {
          revision: 999,
          content: 'FORGED SYNTHETIC HISTORY',
          source: 'agent',
          createdAt: profile.createdAt,
        },
      ],
      limited: false,
    };
    record.version = 2;
    const damaged = JSON.stringify(record);
    await writeFile(file, damaged);
    const loaded = new BotProfiles(root);
    expect((await loaded.get(input.id))!.memory).toBe(input.memory);
    expect(await loaded.status()).toStrictEqual({ available: true, corrupt: 1 });
    await expect(loaded.history(input.id, {})).rejects.toMatchObject({
      code: 'MEMORY_HISTORY_CORRUPT',
    });
    await expect(
      loaded.update(input.id, profile.revision, { memory: 'MUST NOT OVERWRITE' }),
    ).rejects.toMatchObject({ code: 'MEMORY_HISTORY_CORRUPT' });
    expect(await readFile(file, 'utf8')).toBe(damaged);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
