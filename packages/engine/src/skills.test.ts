import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { parseSkill, Skills } from './skills.js';

const markdown = (name = 'mock-summary', body = '只整理用户提供的合成记录。') =>
  `---\nname: ${name}\ndescription: 合成记录汇总工作流\nmetadata:\n  synthetic: true\n---\n\n${body}\n`;

test('SKILL.md parsing keeps the original document and native invocation policy without granting tools', () => {
  const content = markdown().replace(
    'description:',
    'disable-model-invocation: yes\nuser-invocable: true\nallowed-tools: shell\ndescription:',
  );
  const parsed = parseSkill(content);
  expect(parsed.name).toBe('mock-summary');
  expect(parsed.description).toBe('合成记录汇总工作流');
  expect(parsed.content).toBe(content);
  expect(parsed.body).toBe('只整理用户提供的合成记录。');
  expect(parsed.invocation.modelInvocable).toBe(false);
  expect(parsed.invocation.userInvocable).toBe(true);
  expect('allowedTools' in parsed).toBe(false);
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
    expect(() => parseSkill(invalid)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SKILL' }),
    );
});

test('import is disabled, content-preserving and idempotent; edits are CAS and never overwrite a conflicting name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skills-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  try {
    const first = await store.import(markdown());
    expect(first.revision).toBe(1);
    expect((await store.import(markdown())).id).toBe(first.id);
    expect((await store.list('mock-a')).items[0].enabled).toBe(false);
    expect((await store.list('mock-a')).items[0].bindingRevision).toBe(0);
    expect((await store.capture('mock-a')).key).toBe('');
    await expect(store.import(markdown('mock-summary', '不同的合成正文'))).rejects.toMatchObject({
      code: 'SKILL_NAME_CONFLICT',
    });
    const changed = await store.update(
      first.id,
      first.revision,
      markdown('mock-summary', '新的合成说明'),
    );
    expect(changed.revision).toBe(2);
    await expect(store.update(first.id, first.revision, markdown())).rejects.toMatchObject({
      code: 'SKILL_CONFLICT',
    });
    const other = await store.import(markdown('mock-other'));
    await expect(store.update(other.id, other.revision, markdown())).rejects.toMatchObject({
      code: 'SKILL_NAME_CONFLICT',
    });
    expect((await store.read(first.id)).content).toBe(changed.content);
    expect((await stat(path.join(root, 'skills.sqlite'))).mode & 0o777).toBe(0o600);
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
    expect(captured.available).toBe(true);
    expect(captured.key).not.toBe('');
    expect(captured.skills.map((item) => item.name)).toStrictEqual(['mock-summary']);
    expect((await store.capture('mock-b')).skills.length).toBe(0);
    await expect(store.bind('mock-a', { ...input, enabled: false })).rejects.toMatchObject({
      code: 'SKILL_BINDING_CONFLICT',
    });
    const edited = await store.update(
      skill.id,
      skill.revision,
      markdown('mock-summary', '修改后说明'),
    );
    await expect(store.bind('mock-b', input)).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    expect((await store.capture('mock-a')).key).not.toBe(captured.key);
    expect(captured.skills[0].content).toBe('只整理用户提供的合成记录。');
    const recycled = await store.recycle(skill.id, edited.revision);
    expect((await store.list('mock-a')).items.length).toBe(0);
    expect((await store.list('mock-a', true)).items[0].deleted).toBe(true);
    expect((await store.capture('mock-a')).key).toBe('');
    const restored = await store.restore(skill.id, recycled.revision);
    expect((await store.list('mock-a')).items[0].enabled).toBe(false);
    await expect(
      store.bind('mock-a', { ...input, revision: restored.revision }),
    ).rejects.toMatchObject({
      code: 'SKILL_BINDING_CONFLICT',
    });
    await store.close();
    store = new Skills(file);
    expect((await store.read(skill.id)).content).toBe(edited.content);
    expect((await store.capture('mock-a')).skills.length).toBe(0);
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
    expect((await store.status()).available).toBe(false);
    expect((await store.capture('mock-a')).available).toBe(false);
    expect((await store.capture('mock-a')).skills.length).toBe(0);
    await expect(store.import(markdown())).rejects.toMatchObject({ code: 'SKILLS_UNAVAILABLE' });
    expect(await readFile(file)).toStrictEqual(raw);
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
      expect((await store.status()).available, sql).toBe(false);
      expect((await store.capture('mock-a')).available).toBe(false);
      await expect(store.import(markdown())).rejects.toMatchObject({ code: 'SKILLS_UNAVAILABLE' });
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
    await expect(
      store.importBatch([markdown('mock-new'), markdown('mock-existing', 'SYNTHETIC CONFLICT')]),
    ).rejects.toMatchObject({ code: 'SKILL_NAME_CONFLICT' });
    expect((await store.list('mock-target')).items.length).toBe(1);
    expect(await store.status()).toStrictEqual(before);
    const created = await store.importBatch([markdown('mock-existing'), markdown('mock-new')]);
    expect(created[0].id).toBe(original.id);
    expect.assert(
      (await store.list('mock-target')).items.every(
        (item) => !item.enabled && item.bindingRevision === 0,
      ),
    );
    const complete = await store.status();
    expect(
      await store.importBatch([markdown('mock-existing'), markdown('mock-new')]),
    ).toStrictEqual(created);
    expect(await store.status()).toStrictEqual(complete);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
