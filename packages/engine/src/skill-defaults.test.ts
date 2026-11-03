import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Skills } from './skills.js';

const content =
  '---\nname: mock-default\ndescription: Synthetic default skill\n---\nSynthetic reusable instructions.\n';
const defaults = [
  {
    id: 'builtin-mock-default',
    package: { files: [{ path: 'SKILL.md', data: Buffer.from(content).toString('base64') }] },
  },
];
test('system defaults are present for every Bot, read-only and independently disabled without reseeding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-defaults-'));
  const file = path.join(root, 'skills.sqlite');
  let store = Reflect.construct(Skills, [file, defaults]) as Skills;
  try {
    const a = (await store.list('mock-a')).items[0];
    expect.assert(a, 'DEFAULT_MISSING');
    expect(a.enabled).toBe(true);
    expect((await store.list('mock-b')).items[0].enabled).toBe(true);
    expect((await store.capture('mock-a')).skills[0].name).toBe('mock-default');
    await store.bind('mock-a', {
      id: a.id,
      revision: a.revision,
      bindingRevision: 0,
      enabled: false,
    });
    expect((await store.capture('mock-a')).skills.length).toBe(0);
    expect((await store.list('mock-b')).items[0].enabled).toBe(true);
    await expect(store.update(a.id, a.revision, content + 'Changed')).rejects.toMatchObject({
      code: 'SKILL_SYSTEM_READ_ONLY',
    });
    await expect(store.recycle(a.id, a.revision)).rejects.toMatchObject({
      code: 'SKILL_SYSTEM_READ_ONLY',
    });
    await store.close();
    store = Reflect.construct(Skills, [file, defaults]) as Skills;
    expect((await store.list('mock-a')).items.length).toBe(1);
    expect((await store.list('mock-a')).items[0].enabled).toBe(false);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('adding a system default never overwrites or implicitly enables a user skill of the same name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-default-conflict-'));
  const file = path.join(root, 'skills.sqlite');
  let store = new Skills(file);
  try {
    const user = await store.import(content + 'User authored.');
    await store.close();
    store = Reflect.construct(Skills, [file, defaults]) as Skills;
    const catalog = await store.list('mock-a');
    expect(catalog.items.length).toBe(1);
    expect(catalog.items[0].id).toBe(user.id);
    expect(catalog.items[0].enabled).toBe(false);
    expect((await store.read(user.id)).content).toBe(content + 'User authored.');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('introducing a default does not evict twenty previously enabled user skills', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-default-capacity-'));
  const file = path.join(root, 'skills.sqlite');
  let store = new Skills(file);
  try {
    for (let i = 0; i < 20; i++) {
      const document = await store.import(content.replace('mock-default', `mock-item-${i}`));
      await store.bind('mock-a', {
        id: document.id,
        revision: 1,
        bindingRevision: 0,
        enabled: true,
      });
    }
    await store.close();
    store = new Skills(file, defaults);
    const snapshot = await store.capture('mock-a');
    expect(snapshot.available).toBe(true);
    expect(snapshot.skills.length).toBe(20);
    expect(
      (await store.list('mock-a')).items.find((item) => item.id === defaults[0].id)?.enabled,
    ).toBe(false);
    await store.bind('mock-a', {
      id: defaults[0].id,
      revision: 1,
      bindingRevision: 0,
      enabled: false,
    });
    const user = (await store.list('mock-a')).items.find((item) => item.name === 'mock-item-0')!;
    await store.bind('mock-a', {
      id: user.id,
      revision: user.revision,
      bindingRevision: user.bindingRevision,
      enabled: false,
    });
    expect(
      (await store.capture('mock-a')).skills.some((item) => item.name === 'mock-default'),
    ).toBe(false);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
