import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startPrototype } from './server.js';

test('the authenticated skills API shares instruction documents but isolates enablement by registered logical Bot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skills-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const request = async (action: string, value: unknown, token = app.token) => {
    const response = await fetch(`${app.url}/api/skills/${action}`, {
      method: 'POST',
      headers: { 'x-prototype-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    return { status: response.status, value: await response.json() };
  };
  const content = '---\nname: mock-api-skill\ndescription: 合成 API 技能\n---\n只整理合成内容。\n';
  try {
    assert.ok(app.models);
    for (const id of ['mock-api-a', 'mock-api-b'])
      await app.models.profiles.register({
        id,
        name: id,
        instructions: '',
        memory: '',
        color: 'mint',
      });
    const status = await (
      await fetch(`${app.url}/api/state`, { headers: { 'x-prototype-token': app.token } })
    ).json();
    assert.equal(status.clientProtocol, 33);
    assert.equal(status.skills.available, true);
    assert.deepEqual(status.bots, {});
    assert.equal(
      (await request('list', { bot: 'mock-api-a' }, 'synthetic-wrong-token')).status,
      403,
    );
    assert.equal((await request('import', { bot: 'mock-unregistered', content })).status, 404);
    assert.equal(
      (await request('import', { bot: 'mock-api-a', content, permissions: 'all' })).status,
      400,
    );
    const imported = await request('import', { bot: 'mock-api-a', content });
    assert.equal(imported.status, 200);
    const skill = imported.value;
    assert.equal(skill.content, content);
    assert.equal((await request('import', { bot: 'mock-api-a', content })).value.id, skill.id);
    assert.equal(
      (await request('list', { bot: 'mock-api-b' })).value.catalog.items[0].enabled,
      false,
    );
    const binding = { id: skill.id, revision: skill.revision, bindingRevision: 0, enabled: true };
    assert.equal((await request('bind', { bot: 'mock-api-a', binding })).value.entry.enabled, true);
    assert.equal((await app.models.skills.capture('mock-api-a')).skills.length, 1);
    assert.equal((await app.models.skills.capture('mock-api-b')).skills.length, 0);
    assert.equal(
      (await request('bind', { bot: 'mock-api-a', binding: { ...binding, enabled: false } })).value
        .error,
      'SKILL_BINDING_CONFLICT',
    );
    const updated = (
      await request('update', {
        bot: 'mock-api-a',
        id: skill.id,
        revision: skill.revision,
        content: content.replace('只整理合成内容。', '更新后的合成说明。'),
      })
    ).value;
    assert.equal(updated.revision, 2);
    assert.equal(
      (
        await request('update', {
          bot: 'mock-api-a',
          id: skill.id,
          revision: skill.revision,
          content,
        })
      ).value.error,
      'SKILL_CONFLICT',
    );
    assert.equal(
      (
        await request('bind', {
          bot: 'mock-api-b',
          binding: { ...binding, revision: updated.revision },
        })
      ).value.entry.enabled,
      true,
    );
    const recycled = (
      await request('recycle', { bot: 'mock-api-a', id: skill.id, revision: updated.revision })
    ).value;
    assert.equal(recycled.deleted, true);
    assert.equal((await app.models.skills.capture('mock-api-b')).skills.length, 0);
    const restored = (
      await request('restore', { bot: 'mock-api-a', id: skill.id, revision: recycled.revision })
    ).value;
    assert.equal(restored.deleted, false);
    assert.equal(
      (await request('list', { bot: 'mock-api-a' })).value.catalog.items[0].enabled,
      false,
    );
    assert.equal(
      (await request('list', { bot: 'mock-api-b' })).value.catalog.items[0].enabled,
      false,
    );
    assert.equal(
      (await request('read', { bot: 'mock-api-b', id: skill.id })).value.content,
      updated.content,
    );
    assert.equal(app.runtime.status().items.length, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
