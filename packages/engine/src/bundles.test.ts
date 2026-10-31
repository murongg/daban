import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type BotBundle, botBundleText } from '@daban/protocol';
import { BotBundles } from './bundles.js';
import { Fault } from './control.js';
import { Knowledge } from './knowledge.js';
import { BotProfiles } from './profiles.js';
import { Skills } from './skills.js';

const recipe =
  '---\nname: mock-outline\ndescription: Synthetic outline\n---\nWrite a synthetic outline.';
const bundle = (): BotBundle => ({
  format: 'daban.bot',
  version: 1,
  profile: { name: '合成迁移助手', instructions: '只处理合成输入', color: 'violet' },
  preferences: '合成偏好',
  skills: [{ name: 'mock-outline', content: recipe }],
  knowledge: [
    { path: 'mock/notes.md', content: 'SYNTHETIC NOTES' },
    {
      path: 'mock/document.md',
      content: 'SYNTHETIC EDITED TEXT',
      original: { name: 'mock.pdf', data: Buffer.from('SYNTHETIC ORIGINAL').toString('base64') },
    },
  ],
});
const header = (value: BotBundle, id = 'mock-operation') => ({
  id,
  sha256: createHash('sha256').update(botBundleText(value)).digest('hex'),
  size: Buffer.byteLength(botBundleText(value)),
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bot-bundles-'));
  const profiles = new BotProfiles(path.join(root, 'bots'));
  const skills = new Skills(path.join(root, 'skills.sqlite'));
  const knowledge = new Knowledge(path.join(root, 'knowledge.sqlite'));
  const options = {
    directory: path.join(root, 'imports'),
    profiles,
    skills,
    knowledge,
    extract: async () => 'SYNTHETIC EXTRACTED TEXT',
  };
  const transfers = new BotBundles(options);
  return {
    root,
    profiles,
    skills,
    knowledge,
    options,
    transfers,
    async close() {
      await transfers.close();
      await skills.close();
      await knowledge.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('a shared document port validates imports without acquiring or closing its ownership', async () => {
  const f = await fixture();
  await f.transfers.close();
  const { extract: _localExtract, ...options } = f.options;
  let extracted = 0;
  let closed = 0;
  const documents = {
    async extract() {
      extracted++;
      return 'SYNTHETIC REMOTE EXTRACTION';
    },
    async close() {
      closed++;
    },
  };
  const transfers = new BotBundles({ ...options, documents });
  try {
    const value = bundle();
    const h = header(value, 'mock-remote-documents');
    await transfers.begin(h);
    await transfers.submit(h.id, value);
    await transfers.settled;
    assert.equal((await transfers.status(h.id)).state, 'complete');
    assert.equal(extracted, 1);
    await transfers.close();
    await transfers.close();
    assert.equal(closed, 0);
    await documents.close();
    assert.equal(closed, 1);
  } finally {
    await transfers.close();
    await f.close();
  }
});
test('concurrent retries admit only one validation worker', async () => {
  const f = await fixture(),
    value = bundle(),
    h = header(value);
  let validating = 0;
  let release = (_value: string) => {};
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  try {
    f.options.extract = async () => {
      throw new Fault('SYNTHETIC_INTERRUPTION');
    };
    await f.transfers.begin(h);
    await f.transfers.submit(h.id, value);
    await f.transfers.settled;
    f.options.extract = async () => {
      validating++;
      return gate;
    };
    const results = await Promise.allSettled([f.transfers.retry(h.id), f.transfers.retry(h.id)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.reason.code, 'BOT_TRANSFER_BUSY');
    release('SYNTHETIC EXTRACTED TEXT');
    await f.transfers.settled;
    assert.equal(validating, 1);
    assert.equal((await f.transfers.status(h.id)).state, 'complete');
  } finally {
    release('SYNTHETIC EXTRACTED TEXT');
    await f.close();
  }
});
test('unknown cancellations respect the durable record limit so a later restart can still read it', async () => {
  const f = await fixture();
  let reopened: BotBundles | undefined;
  try {
    await f.transfers.ready;
    await f.transfers.close();
    for (let start = 0; start < 4096; start += 128)
      await Promise.all(
        Array.from({ length: 128 }, async (_, index) => {
          const id = `mock-cancel-${start + index}`;
          await writeFile(
            path.join(f.options.directory, `${id}.json`),
            JSON.stringify({
              version: 1,
              header: header(bundle(), id),
              target: 'mock-target',
              state: 'cancelled',
              applying: false,
            }),
            { mode: 0o600, flag: 'wx' },
          );
        }),
      );
    reopened = new BotBundles(f.options);
    await assert.rejects(reopened.cancel(header(bundle(), 'mock-over-limit')), {
      code: 'BOT_IMPORT_LIMIT',
    });
    assert.equal((await reopened.status('mock-cancel-0')).state, 'cancelled');
    assert.equal((await readdir(f.options.directory)).length, 4096);
  } finally {
    await reopened?.close();
    await f.close();
  }
});
test('portable import uses a fresh identity, disabled recipes, immutable originals and an origin receipt that survives edits', async () => {
  const f = await fixture(),
    value = bundle(),
    h = header(value);
  try {
    const other = await f.profiles.register({
      id: 'mock-existing',
      name: '原合成助手',
      instructions: 'keep',
      memory: 'keep',
      color: 'blue',
      model: 'deepseek-v4-pro',
    });
    assert.deepEqual(await f.transfers.status(h.id), { id: h.id, state: 'unknown' });
    assert.equal((await f.transfers.begin(h)).state, 'awaiting');
    await f.transfers.submit(h.id, value);
    await f.transfers.settled;
    const receipt = await f.transfers.status(h.id);
    assert.equal(receipt.state, 'complete');
    const imported = receipt.profile!;
    assert.notEqual(imported.id, other.id);
    assert.equal(imported.model, undefined);
    assert.equal(imported.memory, value.preferences);
    assert.deepEqual(await f.profiles.get(other.id), other);
    assert.ok((await f.skills.list(imported.id)).items.every((item) => !item.enabled));
    const docs = await f.knowledge.list(imported.id);
    assert.equal(docs.length, 2);
    const originalDoc = docs.find((item) => item.source)!;
    assert.equal(
      (await f.knowledge.source(imported.id, originalDoc.id)).file.data,
      value.knowledge[1].original!.data,
    );
    const edited = await f.profiles.update(imported.id, imported.revision, {
      name: '合成后续编辑',
    });
    assert.equal((await f.transfers.begin(h)).profile?.name, edited.name);
    assert.equal((await f.transfers.submit(h.id, value)).profile?.name, edited.name);
    await assert.rejects(f.transfers.begin({ ...h, sha256: 'b'.repeat(64) }), {
      code: 'BOT_IMPORT_ID_REUSED',
    });
  } finally {
    await f.close();
  }
});
test('reconstruction finishes committed data without creating another Bot, recipe or knowledge revision', async () => {
  const f = await fixture(),
    value = bundle(),
    h = header(value);
  let reopened: BotBundles | undefined;
  const register = f.profiles.registerImport.bind(f.profiles);
  f.profiles.registerImport = async () => {
    throw new Fault('SYNTHETIC_STORAGE_INTERRUPTED');
  };
  try {
    await f.transfers.begin(h);
    await f.transfers.submit(h.id, value);
    await f.transfers.settled;
    assert.equal((await f.transfers.status(h.id)).state, 'failed');
    assert.deepEqual(await f.profiles.list(), []);
    f.profiles.registerImport = register;
    await f.transfers.close();
    reopened = new BotBundles(f.options);
    await reopened.retry(h.id);
    await reopened.settled;
    const complete = await reopened.status(h.id);
    assert.equal(complete.state, 'complete');
    assert.equal((await f.profiles.list()).length, 1);
    assert.equal((await f.skills.list(complete.profile!.id)).items.length, 1);
    assert.ok((await f.knowledge.list(complete.profile!.id)).every((item) => item.revision === 1));
    assert.ok((await readdir(f.options.directory)).includes(`${h.id}.json`));
  } finally {
    await reopened?.close();
    await f.close();
  }
});
test('bad recipes or document validation fail before shared writes and remain cancellable', async () => {
  const f = await fixture(),
    value = bundle(),
    h = header(value);
  f.options.extract = async () => {
    throw new Fault('INVALID_DOCUMENT');
  };
  try {
    await f.transfers.begin(h);
    await f.transfers.submit(h.id, value);
    await f.transfers.settled;
    const failed = await f.transfers.status(h.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.canCancel, true);
    assert.deepEqual(await f.profiles.list(), []);
    assert.deepEqual((await f.skills.list('mock-target')).items, []);
    assert.equal((await f.transfers.cancel(h)).state, 'cancelled');
    assert.equal((await f.transfers.begin(h)).state, 'cancelled');
    await assert.rejects(f.transfers.submit(h.id, value), { code: 'BOT_IMPORT_CANCELLED' });
  } finally {
    await f.close();
  }
});
test('cancelling an unknown header leaves a tombstone, so late begin/submit cannot create anything', async () => {
  const f = await fixture(),
    value = bundle(),
    h = header(value);
  try {
    assert.equal((await f.transfers.cancel(h)).state, 'cancelled');
    assert.equal((await f.transfers.begin(h)).state, 'cancelled');
    await assert.rejects(f.transfers.submit(h.id, value), { code: 'BOT_IMPORT_CANCELLED' });
    assert.deepEqual(await f.profiles.list(), []);
  } finally {
    await f.close();
  }
});
test('export uses authoritative requested content and never includes identities, routes, grants or source history', async () => {
  const f = await fixture();
  try {
    const p = await f.profiles.register({
      id: 'mock-source',
      name: '合成导出',
      instructions: 'SYNTHETIC ROLE',
      memory: 'SYNTHETIC PREF',
      color: 'blue',
      model: 'deepseek-v4-pro',
    });
    const skill = await f.skills.import(recipe);
    await f.skills.bind(p.id, { id: skill.id, revision: 1, bindingRevision: 0, enabled: true });
    const doc = await f.knowledge.write(p.id, {
      path: 'mock.md',
      content: 'SYNTHETIC DOC',
      revision: 0,
    });
    const exported = await f.transfers.export({
      bot: p.id,
      revision: p.revision,
      memory: true,
      skills: [{ id: skill.id, revision: 1 }],
      knowledge: [{ id: doc.id, revision: 1 }],
    });
    assert.equal(exported.profile.name, p.name);
    assert.equal(exported.preferences, p.memory);
    assert.equal(exported.skills[0].content, recipe);
    assert.equal(exported.knowledge[0].content, doc.content);
    assert.equal('id' in exported.profile, false);
    assert.equal('model' in exported.profile, false);
    assert.equal('credentials' in exported, false);
    await assert.rejects(
      f.transfers.export({ bot: p.id, revision: 2, memory: true, skills: [], knowledge: [] }),
      { code: 'BOT_PROFILE_CONFLICT' },
    );
  } finally {
    await f.close();
  }
});

test('an acknowledgement lost after profile creation is reconciled without replay and releases the staged copy', async () => {
  const f = await fixture(),
    value = bundle(),
    h = header(value);
  const register = f.profiles.registerImport.bind(f.profiles);
  f.profiles.registerImport = async (input, origin) => {
    await register(input, origin);
    throw new Fault('SYNTHETIC_ACK_LOST');
  };
  try {
    await f.transfers.begin(h);
    await f.transfers.submit(h.id, value);
    await f.transfers.settled;
    const receipt = await f.transfers.status(h.id);
    assert.equal(receipt.state, 'complete');
    const edited = await f.profiles.update(receipt.profile!.id, 1, { name: '合成后续编辑' });
    const retried = await f.transfers.retry(h.id);
    assert.equal(retried.profile?.name, edited.name);
    assert.equal((await stat(path.join(f.options.directory, `${h.id}.bundle`))).size, 0);
    assert.equal((await f.profiles.list()).length, 1);
  } finally {
    await f.close();
  }
});

test('original documents are an explicit export choice and cannot be included through hidden fields', async () => {
  const f = await fixture();
  try {
    const p = await f.profiles.register({
      id: 'mock-originals',
      name: '合成原件',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const original = {
      name: 'mock.pdf',
      data: Buffer.from('SYNTHETIC ORIGINAL').toString('base64'),
    };
    const doc = await f.knowledge.importDocument(p.id, original, 'SYNTHETIC EXTRACTED');
    const query = {
      bot: p.id,
      revision: 1,
      memory: false,
      skills: [],
      knowledge: [{ id: doc.id, revision: 1 }],
    };
    assert.equal((await f.transfers.export(query)).knowledge[0].original, undefined);
    assert.deepEqual(
      (await f.transfers.export({ ...query, originals: true })).knowledge[0].original,
      original,
    );
  } finally {
    await f.close();
  }
});
