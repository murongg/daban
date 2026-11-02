import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Integrations } from './integrations.js';
import { Skills } from './skills.js';

const content = (version: string) =>
  `---\nname: synthetic-recipe\ndescription: Synthetic scoped recipe\n---\n${version}\n`;
const bundle = (version: string) => ({
  files: [
    { path: 'SKILL.md', data: Buffer.from(content(version)).toString('base64') },
    {
      path: 'references/example.txt',
      data: Buffer.from('SYNTHETIC SHARED RESOURCE').toString('base64'),
    },
  ],
});

test('Bot installations have independent names, versions and lifecycle while package bytes are shared', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bot-skills-'));
  const file = path.join(root, 'skills.sqlite');
  let store = new Skills(file);
  try {
    const first = await store.importPackage(bundle('SYNTHETIC ALPHA'), 'mock-alpha');
    assert.deepEqual((await store.list('mock-beta')).items, []);
    await assert.rejects(store.read(first.id, 'mock-beta'), /SKILL_NOT_FOUND/);
    const second = await store.importPackage(bundle('SYNTHETIC BETA'), 'mock-beta');
    assert.notEqual(first.id, second.id);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM skill_packages').get()!.count, 1);
    } finally {
      db.close();
    }
    const before = await store.capture('mock-alpha');
    await store.update(first.id, first.revision, content('SYNTHETIC ALPHA EDIT'), 'mock-alpha');
    assert.equal((await store.read(second.id, 'mock-beta')).content, content('SYNTHETIC BETA'));
    await assert.rejects(
      store.bind('mock-beta', {
        id: first.id,
        revision: first.revision,
        bindingRevision: 0,
        enabled: true,
      }),
      /SKILL_NOT_FOUND/,
    );
    await store.recycle(first.id, first.revision + 1, 'mock-alpha');
    assert.equal((await store.list('mock-alpha')).items.length, 0);
    assert.equal((await store.list('mock-beta')).items[0].id, second.id);
    store.release(before);
    await store.close();
    store = new Skills(file);
    assert.equal((await store.read(second.id, 'mock-beta')).content, content('SYNTHETIC BETA'));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('adding a skill to another Bot creates an independent installation rather than a shared edit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-skill-copy-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  try {
    const original = await store.importPackage(bundle('SYNTHETIC INITIAL'), 'mock-alpha');
    const copied = await store.copy('mock-alpha', original.id, original.revision, 'mock-beta');
    assert.notEqual(copied.id, original.id);
    assert.equal((await store.list('mock-beta')).items[0].enabled, true);
    await store.update(original.id, original.revision, content('SYNTHETIC CHANGED'), 'mock-alpha');
    assert.equal((await store.read(copied.id, 'mock-beta')).content, content('SYNTHETIC INITIAL'));
    await assert.rejects(store.copy('mock-beta', original.id, 2, 'mock-alpha'), /SKILL_NOT_FOUND/);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP connections and credentials belong to their Bot and cannot be granted or edited across Bots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bot-mcp-'));
  const file = path.join(root, 'integrations.sqlite');
  let store = new Integrations(file);
  const input = (id: string, key: string) => ({
    requestId: `request-${id}`,
    id,
    revision: 0,
    name: 'Synthetic service',
    endpoint: 'https://mcp.example.test/mcp',
    bearer: key,
  });
  try {
    const first = await store.save(input('connection-alpha', 'SYNTHETIC-ALPHA-KEY'), 'mock-alpha');
    assert.equal((await store.list(false, 'mock-beta')).items.length, 0);
    await store.save(input('connection-beta', 'SYNTHETIC-BETA-KEY'), 'mock-beta');
    assert.equal((await store.assignments('mock-beta')).items.length, 1);
    await assert.rejects(store.read(first.current.id, 'mock-beta'), /MCP_NOT_FOUND/);
    await assert.rejects(
      store.save(
        {
          ...input('connection-alpha', 'SYNTHETIC-CHANGED'),
          requestId: 'request-foreign',
          revision: 1,
        },
        'mock-beta',
      ),
      /MCP_NOT_FOUND/,
    );
    await assert.rejects(
      store.bind('mock-beta', {
        connection: first.current.id,
        configRevision: 1,
        bindingRevision: 0,
        tools: ['synthetic_echo'],
        enabled: true,
      }),
      /MCP_NOT_FOUND/,
    );
    await assert.rejects(store.archive(first.current.id, 1, 'mock-beta'), /MCP_NOT_FOUND/);
    assert.equal((await store.privateConfig('connection-alpha')).bearer, 'SYNTHETIC-ALPHA-KEY');
    assert.equal((await store.privateConfig('connection-beta')).bearer, 'SYNTHETIC-BETA-KEY');
    await store.close();
    store = new Integrations(file);
    assert.equal((await store.list(false, 'mock-alpha')).items[0].id, 'connection-alpha');
    assert.equal((await store.list(false, 'mock-beta')).items[0].id, 'connection-beta');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP imports and MCP saves bind ownership to the explicit Bot and reject guessed foreign IDs', async () => {
  const { startPrototype } = await import('./server.js');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bot-capabilities-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const post = async (route: string, body: object) => {
    const response = await fetch(`${app.url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-prototype-token': app.token },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.ok(app.models);
    for (const id of ['mock-alpha', 'mock-beta'])
      await app.models.profiles.register({
        id,
        name: id,
        instructions: '',
        memory: '',
        color: 'mint',
      });
    const installed = await post('/api/skills/import-package', {
      bot: 'mock-alpha',
      package: bundle('SYNTHETIC API SKILL'),
    });
    assert.equal(installed.status, 200);
    assert.equal(installed.value.ownerBot, 'mock-alpha');
    assert.equal(
      (await post('/api/skills/list', { bot: 'mock-beta' })).value.catalog.items.some(
        (entry: { id: string }) => entry.id === installed.value.id,
      ),
      false,
    );
    assert.equal(
      (await post('/api/skills/read', { bot: 'mock-beta', id: installed.value.id })).status,
      404,
    );
    const connection = await post('/api/mcp/save', {
      type: 'mcp.save',
      bot: 'mock-alpha',
      input: {
        requestId: 'mock-save',
        id: 'mock-private-mcp',
        revision: 0,
        name: 'Synthetic MCP',
        endpoint: 'https://mcp.example.test/mcp',
        bearer: 'SYNTHETIC-KEY',
      },
    });
    assert.equal(connection.status, 200);
    assert.equal(connection.value.current.ownerBot, 'mock-alpha');
    assert.equal(
      (
        await post('/api/mcp/catalog', {
          type: 'mcp.catalog',
          bot: 'mock-beta',
          id: 'mock-private-mcp',
        })
      ).status,
      404,
    );
    assert.equal(
      (await post('/api/mcp/list', { type: 'mcp.list', bot: 'mock-beta' })).value.items.length,
      0,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a confirmed install extends only that task snapshot and does not pull in unrelated later grants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-installed-snapshot-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  try {
    const before = await store.capture('mock-alpha');
    const unrelated = await store.import(
      content('SYNTHETIC UNRELATED').replace('synthetic-recipe', 'synthetic-other'),
      'mock-alpha',
    );
    await store.bind('mock-alpha', {
      id: unrelated.id,
      revision: 1,
      bindingRevision: 0,
      enabled: true,
    });
    const installed = await store.importPackage(bundle('SYNTHETIC APPROVED'), 'mock-alpha');
    await store.bind('mock-alpha', {
      id: installed.id,
      revision: 1,
      bindingRevision: 0,
      enabled: true,
    });
    const after = await store.extend('mock-alpha', before, installed.id, 1);
    assert.deepEqual(before.skills, []);
    assert.deepEqual(
      after.skills.map((item) => item.name),
      ['synthetic-recipe'],
    );
    assert.equal(
      (await store.readCaptured(after, 'synthetic-recipe', 'references/example.txt')).data,
      Buffer.from('SYNTHETIC SHARED RESOURCE').toString('base64'),
    );
    await assert.rejects(store.extend('mock-beta', before, installed.id, 1), /SKILL_NOT_FOUND/);
    store.release(before);
    store.release(after);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('preparing an approved replacement never reuses files staged for an older same-name recipe', async () => {
  const { SkillTools } = await import('./skill-tools.js');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-skill-staging-version-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  try {
    const old = await store.importPackage(bundle('SYNTHETIC OLD'));
    await store.bind('mock-alpha', { id: old.id, revision: 1, bindingRevision: 0, enabled: true });
    const before = await store.capture('mock-alpha');
    const run: import('./agent-tools.js').AgentToolRun = {
      bot: 'mock-alpha',
      id: 'mock-run',
      abort: new AbortController(),
      toolCount: 0,
      limit: 10,
      seen: {},
      trace: [],
      workdir: '/synthetic',
      canonicalRoot: '/synthetic',
      skills: before,
    };
    let count = 0;
    const tools = new SkillTools(store, async () => ({
      directory: `/synthetic/staged-${++count}`,
      execution: 'linux-workspace',
    }));
    const firstBlock = (await tools.invoke(run, 'skill_prepare', { skill: 'synthetic-recipe' }))
      .content[0];
    assert.ok(firstBlock.type === 'text');
    const first = JSON.parse(firstBlock.text);
    const unrelated = await store.import(
      content('SYNTHETIC OTHER').replace('synthetic-recipe', 'synthetic-unrelated'),
      'mock-alpha',
    );
    await store.bind('mock-alpha', {
      id: unrelated.id,
      revision: 1,
      bindingRevision: 0,
      enabled: true,
    });
    const withOther = await store.extend('mock-alpha', before, unrelated.id, 1);
    run.skills = withOther;
    const sameBlock = (await tools.invoke(run, 'skill_prepare', { skill: 'synthetic-recipe' }))
      .content[0];
    assert.ok(sameBlock.type === 'text');
    assert.equal(
      JSON.parse(sameBlock.text).directory,
      first.directory,
      'An unrelated installation must not reset an existing prepared working directory',
    );
    const next = await store.importPackage(bundle('SYNTHETIC APPROVED'), 'mock-alpha');
    await store.bind('mock-alpha', { id: next.id, revision: 1, bindingRevision: 0, enabled: true });
    const after = await store.extend('mock-alpha', withOther, next.id, 1);
    run.skills = after;
    const secondBlock = (await tools.invoke(run, 'skill_prepare', { skill: 'synthetic-recipe' }))
      .content[0];
    assert.ok(secondBlock.type === 'text');
    const second = JSON.parse(secondBlock.text);
    assert.notEqual(first.directory, second.directory);
    assert.equal(count, 2);
    store.release(before);
    store.release(withOther);
    store.release(after);
    tools.release(run);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('copying a legacy shared skill preserves other Bots and cannot resurrect it after private uninstall', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-shared-skill-copy-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  try {
    const shared = await store.import(content('SYNTHETIC LEGACY'));
    for (const bot of ['mock-alpha', 'mock-beta'])
      await store.bind(bot, { id: shared.id, revision: 1, bindingRevision: 0, enabled: true });
    await assert.rejects(
      store.update(shared.id, 1, content('SYNTHETIC WRONG SHARED EDIT'), 'mock-alpha'),
      /SKILL_SHARED_READ_ONLY/,
    );
    const own = await store.copy('mock-alpha', shared.id, 1, 'mock-alpha');
    assert.notEqual(own.id, shared.id);
    await store.recycle(own.id, 1, 'mock-alpha');
    assert.equal((await store.capture('mock-alpha')).skills.length, 0);
    assert.equal((await store.capture('mock-beta')).skills[0].content, 'SYNTHETIC LEGACY');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('known built-in updates retain Bot opt-outs and never replace an unknown user-authored package', async () => {
  const { inspectSkillPackage } = await import('./skill-package.js');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-default-upgrade-'));
  const file = path.join(root, 'skills.sqlite');
  const previous = bundle('SYNTHETIC BUILTIN OLD');
  const current = bundle('SYNTHETIC BUILTIN CURRENT');
  let store = new Skills(file, [{ id: 'mock-builtin', package: previous }]);
  try {
    const entry = (await store.list('mock-alpha')).items[0];
    await store.bind('mock-alpha', {
      id: entry.id,
      revision: entry.revision,
      bindingRevision: 0,
      enabled: false,
    });
    await store.close();
    const nextDefault = {
      id: 'mock-builtin',
      package: current,
      previousDigests: [inspectSkillPackage(previous).digest],
    };
    store = new Skills(file, [nextDefault]);
    const updated = (await store.list('mock-alpha')).items[0];
    assert.equal(updated.revision, 2);
    assert.equal(updated.enabled, false);
    assert.equal(updated.bindingRevision, 1);
    assert.equal((await store.list('mock-beta')).items[0].enabled, true);
    assert.equal((await store.read('mock-builtin')).content, content('SYNTHETIC BUILTIN CURRENT'));
    await store.close();
    const tampered = content('SYNTHETIC UNKNOWN REVISION');
    const db = new DatabaseSync(file);
    db.prepare('UPDATE skills SET content=? WHERE id=?').run(tampered, 'mock-builtin');
    db.close();
    const expectedDefault = {
      id: 'mock-builtin',
      package: current,
      previousDigests: [inspectSkillPackage(previous).digest],
    };
    store = new Skills(file, [expectedDefault]);
    assert.equal((await store.status()).available, false);
    const retained = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        retained.prepare('SELECT content FROM skills WHERE id=?').get('mock-builtin')!.content,
        tampered,
      );
    } finally {
      retained.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
