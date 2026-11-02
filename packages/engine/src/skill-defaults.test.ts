import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
    assert(a, 'DEFAULT_MISSING');
    assert.equal(a.enabled, true);
    assert.equal((await store.list('mock-b')).items[0].enabled, true);
    assert.equal((await store.capture('mock-a')).skills[0].name, 'mock-default');
    await store.bind('mock-a', {
      id: a.id,
      revision: a.revision,
      bindingRevision: 0,
      enabled: false,
    });
    assert.equal((await store.capture('mock-a')).skills.length, 0);
    assert.equal((await store.list('mock-b')).items[0].enabled, true);
    await assert.rejects(store.update(a.id, a.revision, content + 'Changed'), {
      code: 'SKILL_SYSTEM_READ_ONLY',
    });
    await assert.rejects(store.recycle(a.id, a.revision), { code: 'SKILL_SYSTEM_READ_ONLY' });
    await store.close();
    store = Reflect.construct(Skills, [file, defaults]) as Skills;
    assert.equal((await store.list('mock-a')).items.length, 1);
    assert.equal((await store.list('mock-a')).items[0].enabled, false);
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
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.items[0].id, user.id);
    assert.equal(catalog.items[0].enabled, false);
    assert.equal((await store.read(user.id)).content, content + 'User authored.');
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
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.skills.length, 20);
    assert.equal(
      (await store.list('mock-a')).items.find((item) => item.id === defaults[0].id)?.enabled,
      false,
    );
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
    assert.equal(
      (await store.capture('mock-a')).skills.some((item) => item.name === 'mock-default'),
      false,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
