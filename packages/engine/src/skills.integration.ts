import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { managedProtocol } from '@daban/protocol';
import type { AgentToolRun } from './agent-tools.js';
import { startPrototype } from './server.js';
import { readSkillZip } from './skill-package.js';

test('built-in Bot and skill workflows save current-Bot records through authenticated APIs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-create-bot-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  try {
    assert(app.models);
    await app.models.profiles.register({
      id: 'mock-creator',
      name: 'Mock creator',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const run: AgentToolRun = {
      id: 'mock-creation-run',
      bot: 'mock-creator',
      sessionId: 'mock-creator-session',
      abort: new AbortController(),
      workdir: '/mock/task',
      canonicalRoot: '/mock/task',
      toolCount: 0,
      limit: 10,
      seen: {},
      trace: [],
      task: { requestId: 'mock-create-request', prompt: 'Create a synthetic helper Bot.' },
      skills: await app.models.skills.capture('mock-creator'),
    };
    const result = await app.models.tools.invoke(run, 'bot_create', {
      name: 'Mock created',
      instructions: 'Organize synthetic examples.',
      color: 'blue',
    });
    assert(!result.isError);
    const item = result.content[0];
    assert(item.type === 'text');
    const receipt = JSON.parse(item.text);
    const state = await (
      await fetch(`${app.url}/api/state`, {
        headers: { 'x-prototype-token': app.token },
      })
    ).json();
    assert.equal(state.profiles.length, 2);
    assert.deepEqual(
      state.profiles.find((profile: { id: string }) => profile.id === receipt.id),
      await app.models.profiles.get(receipt.id),
    );
    assert.equal(state.bots[receipt.id], undefined);
    const snapshot = await app.models.skills.capture(receipt.id);
    assert(snapshot.skills.some((skill) => skill.name === 'bot-manager'));
    assert(snapshot.skills.some((skill) => skill.name === 'skill-creator'));
    assert(
      app.models.tools
        .list(run.bot, undefined, undefined, run)
        .some((tool) => tool.name === 'skill_create'),
    );
    const content =
      '---\nname: mock-authored-api\ndescription: Synthetic authored API skill\n---\nOrganize synthetic examples.\n';
    const authored = await app.models.tools.invoke(run, 'skill_create', { content });
    assert(!authored.isError);
    const preview = authored.content[0];
    assert(preview.type === 'text');
    const installation = app.models.tools.invoke(run, 'skill_install', {
      previewId: JSON.parse(preview.text).previewId,
    });
    let question: Awaited<ReturnType<typeof app.models.interactions.list>>[number] | undefined;
    for (let i = 0; i < 100; i++) {
      question = (await app.models.interactions.list()).find((item) => item.status === 'pending');
      if (question) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert(question);
    const accepted = await fetch(`${app.url}/api/bots/${run.bot}/reply`, {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: question.id,
        runId: run.id,
        reply: { kind: 'answer', answers: [{ id: 'install', selected: ['Install and enable'] }] },
      }),
    });
    assert.equal(accepted.status, 200);
    assert(!(await installation).isError);
    const read = await app.models.tools.invoke(run, 'skill_read', {
      skill: 'mock-authored-api',
      path: 'SKILL.md',
    });
    const text = read.content[0];
    assert(text.type === 'text');
    assert.equal(JSON.parse(text.text).content, content);
    assert(
      !(await app.models.skills.list(receipt.id)).items.some(
        (skill) => skill.name === 'mock-authored-api',
      ),
    );
    app.models.tools.skills?.release(run);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the package API retains all files and binds resource reads and archive export to a revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-package-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const content =
    '---\nname: mock-package-api\ndescription: Synthetic package API\n---\nUse references/data.txt.\n';
  const bundle = {
    files: [
      { path: 'SKILL.md', data: Buffer.from(content).toString('base64') },
      {
        path: 'references/data.txt',
        data: Buffer.from('SYNTHETIC API RESOURCE').toString('base64'),
      },
    ],
  };
  async function request(action: string, body: unknown) {
    const r = await fetch(`${app.url}/api/skills/${action}`, {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  }
  try {
    assert(app.models);
    await app.models.profiles.register({
      id: 'mock-bot',
      name: 'Mock Bot',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const imported = await request('import-package', { bot: 'mock-bot', package: bundle });
    assert.equal(imported.status, 200);
    assert.equal(imported.value.package.fileCount, 2);
    const read = await request('resource', {
      bot: 'mock-bot',
      id: imported.value.id,
      revision: 1,
      path: 'references/data.txt',
    });
    assert.equal(read.status, 200);
    assert.equal(Buffer.from(read.value.data, 'base64').toString(), 'SYNTHETIC API RESOURCE');
    assert.equal(
      (
        await request('resource', {
          bot: 'mock-bot',
          id: imported.value.id,
          revision: 2,
          path: 'references/data.txt',
        })
      ).status,
      409,
    );
    const archive = await request('export-package', {
      bot: 'mock-bot',
      id: imported.value.id,
      revision: 1,
    });
    assert.equal(archive.value.id, imported.value.id);
    assert.equal(readSkillZip(Buffer.from(archive.value.archive.data, 'base64')).files.length, 2);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the authenticated skills API installs per Bot and explicitly copies independent versions', async () => {
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
    assert.equal(status.clientProtocol, managedProtocol);
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
      (await request('list', { bot: 'mock-api-b' })).value.catalog.items.some(
        (item: { id: string }) => item.id === skill.id,
      ),
      false,
    );
    const binding = { id: skill.id, revision: skill.revision, bindingRevision: 0, enabled: true };
    assert.equal((await request('bind', { bot: 'mock-api-a', binding })).value.entry.enabled, true);
    assert.equal(
      (await app.models.skills.capture('mock-api-a')).skills.filter(
        (item) => item.name === skill.name,
      ).length,
      1,
    );
    assert.equal(
      (await app.models.skills.capture('mock-api-b')).skills.filter(
        (item) => item.name === skill.name,
      ).length,
      0,
    );
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
      ).status,
      404,
    );
    const copied = (
      await request('copy', {
        bot: 'mock-api-a',
        id: skill.id,
        revision: updated.revision,
        targetBot: 'mock-api-b',
      })
    ).value;
    assert.notEqual(copied.id, skill.id);
    const recycled = (
      await request('recycle', { bot: 'mock-api-a', id: skill.id, revision: updated.revision })
    ).value;
    assert.equal(recycled.deleted, true);
    assert.equal(
      (await app.models.skills.capture('mock-api-b')).skills.filter(
        (item) => item.name === skill.name,
      ).length,
      1,
    );
    const restored = (
      await request('restore', { bot: 'mock-api-a', id: skill.id, revision: recycled.revision })
    ).value;
    assert.equal(restored.deleted, false);
    assert.equal(
      (await request('list', { bot: 'mock-api-a' })).value.catalog.items.find(
        (item: { id: string }) => item.id === skill.id,
      ).enabled,
      false,
    );
    assert.equal(
      (await request('list', { bot: 'mock-api-b' })).value.catalog.items.find(
        (item: { id: string }) => item.id === copied.id,
      ).enabled,
      true,
    );
    assert.equal((await request('read', { bot: 'mock-api-b', id: skill.id })).status, 404);
    assert.equal(
      (await request('read', { bot: 'mock-api-b', id: copied.id })).value.content,
      updated.content,
    );
    assert.equal(app.runtime.status().items.length, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
