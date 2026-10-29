import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseSkill, Skills } from './skills.js';

const markdown = (name = 'mock-summary', body = '只整理用户提供的合成记录。') =>
  `---\nname: ${name}\ndescription: 合成记录汇总工作流\nmetadata:\n  synthetic: true\n---\n\n${body}\n`;

test('SKILL.md parsing keeps the original document and native invocation policy without granting tools', () => {
  const content = markdown().replace(
    'description:',
    'disable-model-invocation: yes\nuser-invocable: true\nallowed-tools: shell\ndescription:',
  );
  const parsed = parseSkill(content);
  assert.equal(parsed.name, 'mock-summary');
  assert.equal(parsed.description, '合成记录汇总工作流');
  assert.equal(parsed.content, content);
  assert.equal(parsed.body, '只整理用户提供的合成记录。');
  assert.equal(parsed.invocation.modelInvocable, false);
  assert.equal(parsed.invocation.userInvocable, true);
  assert.equal('allowedTools' in parsed, false);
  for (const invalid of [
    'missing frontmatter',
    markdown('../escape'),
    markdown('Mock-Uppercase'),
    markdown().replace('description:', 'name: duplicate\ndescription:'),
    markdown().replace('description:', 'user-invocable: perhaps\ndescription:'),
    markdown().replace('description:', 'modelInvocable: true\ndescription:'),
    markdown('mock-empty', ''),
    markdown('mock-large', 'x'.repeat(100001)),
  ])
    assert.throws(() => parseSkill(invalid), { code: 'INVALID_SKILL' });
});

test('import is disabled, content-preserving and idempotent; edits are CAS and never overwrite a conflicting name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skills-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  try {
    const first = await store.import(markdown());
    assert.equal(first.revision, 1);
    assert.equal((await store.import(markdown())).id, first.id);
    assert.equal((await store.list('mock-a')).items[0].enabled, false);
    assert.equal((await store.list('mock-a')).items[0].bindingRevision, 0);
    assert.equal((await store.capture('mock-a')).key, '');
    await assert.rejects(store.import(markdown('mock-summary', '不同的合成正文')), {
      code: 'SKILL_NAME_CONFLICT',
    });
    const changed = await store.update(
      first.id,
      first.revision,
      markdown('mock-summary', '新的合成说明'),
    );
    assert.equal(changed.revision, 2);
    await assert.rejects(store.update(first.id, first.revision, markdown()), {
      code: 'SKILL_CONFLICT',
    });
    const other = await store.import(markdown('mock-other'));
    await assert.rejects(store.update(other.id, other.revision, markdown()), {
      code: 'SKILL_NAME_CONFLICT',
    });
    assert.equal((await store.read(first.id)).content, changed.content);
    assert.equal((await stat(path.join(root, 'skills.sqlite'))).mode & 0o777, 0o600);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Bot bindings are independent, revision-bound and captured immutably; recycle/restore does not resurrect enablement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-bindings-'));
  const file = path.join(root, 'skills.sqlite');
  let store = new Skills(file);
  try {
    const skill = await store.import(markdown());
    const input = { id: skill.id, revision: skill.revision, bindingRevision: 0, enabled: true };
    await store.bind('mock-a', input);
    const captured = await store.capture('mock-a');
    assert.equal(captured.available, true);
    assert.notEqual(captured.key, '');
    assert.deepEqual(
      captured.skills.map((item) => item.name),
      ['mock-summary'],
    );
    assert.equal((await store.capture('mock-b')).skills.length, 0);
    await assert.rejects(store.bind('mock-a', { ...input, enabled: false }), {
      code: 'SKILL_BINDING_CONFLICT',
    });
    const edited = await store.update(
      skill.id,
      skill.revision,
      markdown('mock-summary', '修改后说明'),
    );
    await assert.rejects(store.bind('mock-b', input), { code: 'SKILL_CONFLICT' });
    assert.notEqual((await store.capture('mock-a')).key, captured.key);
    assert.equal(captured.skills[0].content, '只整理用户提供的合成记录。');
    const recycled = await store.recycle(skill.id, edited.revision);
    assert.equal((await store.list('mock-a')).items.length, 0);
    assert.equal((await store.list('mock-a', true)).items[0].deleted, true);
    assert.equal((await store.capture('mock-a')).key, '');
    const restored = await store.restore(skill.id, recycled.revision);
    assert.equal((await store.list('mock-a')).items[0].enabled, false);
    await assert.rejects(store.bind('mock-a', { ...input, revision: restored.revision }), {
      code: 'SKILL_BINDING_CONFLICT',
    });
    await store.close();
    store = new Skills(file);
    assert.equal((await store.read(skill.id)).content, edited.content);
    assert.equal((await store.capture('mock-a')).skills.length, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt skill storage is retained and reports a missing capability instead of silently resetting content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-corrupt-'));
  const file = path.join(root, 'skills.sqlite');
  const raw = Buffer.from('SYNTHETIC-CORRUPT-SKILLS');
  await writeFile(file, raw, { mode: 0o600 });
  const store = new Skills(file);
  try {
    assert.equal((await store.status()).available, false);
    assert.equal((await store.capture('mock-a')).available, false);
    assert.equal((await store.capture('mock-a')).skills.length, 0);
    await assert.rejects(store.import(markdown()), { code: 'SKILLS_UNAVAILABLE' });
    assert.deepEqual(await readFile(file), raw);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid persisted bindings or catalog versions disable skills rather than silently changing enablement', async () => {
  for (const sql of [
    'UPDATE skill_bindings SET enabled=2',
    'UPDATE skill_meta SET revision=-1',
    'DELETE FROM skill_meta',
    "UPDATE skill_bindings SET skill='mock-missing-skill'",
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-schema-'));
    const file = path.join(root, 'skills.sqlite');
    let store = new Skills(file);
    try {
      const skill = await store.import(markdown());
      await store.bind('mock-a', {
        id: skill.id,
        revision: skill.revision,
        bindingRevision: 0,
        enabled: true,
      });
      await store.close();
      const db = new DatabaseSync(file);
      db.exec(sql);
      db.close();
      store = new Skills(file);
      assert.equal((await store.status()).available, false, sql);
      assert.equal((await store.capture('mock-a')).available, false);
      await assert.rejects(store.import(markdown()), { code: 'SKILLS_UNAVAILABLE' });
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('portable recipe batches are atomic, idempotent and disabled without modifying other Bots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-skills-batch-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  try {
    const original = await store.import(markdown('mock-existing'));
    const before = await store.status();
    await assert.rejects(
      store.importBatch([markdown('mock-new'), markdown('mock-existing', 'SYNTHETIC CONFLICT')]),
      { code: 'SKILL_NAME_CONFLICT' },
    );
    assert.equal((await store.list('mock-target')).items.length, 1);
    assert.deepEqual(await store.status(), before);
    const created = await store.importBatch([markdown('mock-existing'), markdown('mock-new')]);
    assert.equal(created[0].id, original.id);
    assert.ok(
      (await store.list('mock-target')).items.every(
        (item) => !item.enabled && item.bindingRevision === 0,
      ),
    );
    const complete = await store.status();
    assert.deepEqual(
      await store.importBatch([markdown('mock-existing'), markdown('mock-new')]),
      created,
    );
    assert.deepEqual(await store.status(), complete);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
