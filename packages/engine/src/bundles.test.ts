import { createHash } from 'node:crypto';
import fs, {
  type FileHandle,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BotBundle, botBundleText, isBotBundle } from '@daban/protocol';
import { expect, type MockInstance, test, vi } from 'vitest';
import { BotBundles, isBundleRecord } from './bundles.js';
import { Fault } from './control.js';
import { Knowledge } from './knowledge.js';
import * as privateFiles from './private-files.js';
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

test.each([
  [{ dev: 1, ino: 47 }, true],
  [{ dev: '1', ino: '18446744073709551615' }, true],
  [{ dev: 1, ino: '18446744073709551616' }, false],
  [{ dev: 1, ino: '01' }, false],
  [{ dev: 1, ino: '-1' }, false],
  [{ dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 }, false],
])('import metadata preserves exact file identity: %j', (payload, valid) => {
  expect(
    isBundleRecord({
      version: 1,
      header: header(bundle()),
      target: 'mock-target',
      state: 'awaiting',
      applying: false,
      payload,
    }),
  ).toBe(valid);
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
  const owners = new Set([transfers]);
  let closing: Promise<unknown> | undefined;
  return {
    root,
    profiles,
    skills,
    knowledge,
    options,
    transfers,
    reopen() {
      if (closing) throw Error('SYNTHETIC_FIXTURE_CLOSED');
      const owner = new BotBundles(options);
      owners.add(owner);
      return owner;
    },
    close() {
      closing ??= (async () => {
        await Promise.all([...owners].map((owner) => owner.close()));
        await skills.close();
        await knowledge.close();
        await rm(root, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}

async function seed(directory: string, signal: AbortSignal) {
  for (let start = 0; start < 4096; start += 128) {
    signal.throwIfAborted();
    const writes = Array.from({ length: 128 }, async (_, index) => {
      const id = `mock-cancel-${start + index}`;
      await writeFile(
        path.join(directory, `${id}.json`),
        JSON.stringify({
          version: 1,
          header: header(bundle(), id),
          target: 'mock-target',
          state: 'cancelled',
          applying: false,
        }),
        { mode: 0o600, flag: 'wx' },
      );
    });
    try {
      await Promise.all(writes);
    } catch (error) {
      // The first rejection must not let teardown remove paths still owned by other writes in this batch.
      await Promise.allSettled(writes);
      throw error;
    }
  }
}

function barrier() {
  let resolve!: (value: undefined) => unknown;
  const promise = new Promise<undefined>((ready) => {
    resolve = ready;
  });
  return { promise, release: () => resolve(undefined) };
}

test('a failed seed batch drains held writes before teardown and preserves its original failure', async () => {
  const f = await fixture();
  await Promise.all([f.transfers.ready, f.skills.ready, f.knowledge.ready]);
  await f.transfers.close();
  const held = barrier();
  const rejected = barrier();
  const release = barrier();
  const firstError = Error('SYNTHETIC_FIRST_SEED_FAILURE');
  const laterError = Error('SYNTHETIC_LATER_SEED_FAILURE');
  const originalWrite = fs.writeFile;
  const originalRemove = fs.rm;
  let started = 0;
  let heldWrote = false;
  let removing = false;
  const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (typeof args[0] === 'string' && path.dirname(args[0]) === f.options.directory) {
      started++;
      if (path.basename(args[0]) === 'mock-cancel-0.json') {
        held.release();
        await release.promise;
        await originalWrite(...args);
        heldWrote = true;
        throw laterError;
      }
      if (path.basename(args[0]) === 'mock-cancel-1.json') {
        rejected.release();
        throw firstError;
      }
    }
    return originalWrite(...args);
  });
  const remove = vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
    if (args[0] === f.root) removing = true;
    return originalRemove(...args);
  });
  syncBuiltinESMExports();
  let seedError: unknown;
  let settled = false;
  const seeding = seed(f.options.directory, new AbortController().signal).catch((error) => {
    seedError = error;
    settled = true;
  });
  const teardown = seeding.then(() => f.close());
  const finished = Promise.allSettled([teardown]);
  try {
    await Promise.all([held.promise, rejected.promise]);
    await new Promise((ready) => setImmediate(ready));
    expect(started).toBe(128);
    expect(removing).toBe(false);
    expect(settled).toBe(false);
    expect((await stat(f.options.directory)).isDirectory()).toBe(true);
    release.release();
    await seeding;
    expect(seedError).toBe(firstError);
    expect(heldWrote).toBe(true);
    expect(started).toBe(128);
    expect((await finished)[0].status).toBe('fulfilled');
    await expect(stat(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release.release();
    await seeding;
    await finished;
    write.mockRestore();
    remove.mockRestore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test('close owns pending directory verification and starts no later initialization IO', async () => {
  const f = await fixture();
  await Promise.all([f.transfers.ready, f.skills.ready, f.knowledge.ready]);
  await f.transfers.close();
  const entered = barrier();
  const release = barrier();
  const original = privateFiles.secureDirectory;
  const secure = vi.spyOn(privateFiles, 'secureDirectory').mockImplementation(async (directory) => {
    if (directory === f.options.directory) {
      entered.release();
      await release.promise;
    }
    return original(directory);
  });
  const metadata = vi.spyOn(privateFiles, 'privateMetadata');
  const read = vi.spyOn(fs, 'readdir');
  syncBuiltinESMExports();
  const reopened = f.reopen();
  let finished = false;
  let closing: Promise<unknown> | undefined;
  try {
    await entered.promise;
    closing = reopened.close().then(() => {
      finished = true;
    });
    // One event-loop turn observes settlement while the gate stays held; no elapsed-time delay is used.
    await new Promise((ready) => setImmediate(ready));
    expect(finished).toBe(false);
    release.release();
    await closing;
    await reopened.close();
    expect(metadata).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await expect(reopened.status('mock-closed')).rejects.toMatchObject({
      code: 'BOT_IMPORT_STORE',
    });
  } finally {
    release.release();
    try {
      await reopened.ready;
      await closing;
    } finally {
      secure.mockRestore();
      metadata.mockRestore();
      read.mockRestore();
      syncBuiltinESMExports();
      await f.close();
    }
  }
});

test.each(['owner close', 'fixture teardown'])(
  '%s drains the current initialization handle without reading it or opening the next record',
  async (mode) => {
    const f = await fixture();
    await Promise.all([f.transfers.ready, f.skills.ready, f.knowledge.ready]);
    await f.transfers.close();
    for (const id of ['mock-load-a', 'mock-load-b'])
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
    const directory = await realpath(f.options.directory);
    const record = (file: string) => path.dirname(file) === directory && file.endsWith('.json');
    const entered = barrier();
    const release = barrier();
    const originalMetadata = privateFiles.privateMetadata;
    let held = false;
    const metadata = vi
      .spyOn(privateFiles, 'privateMetadata')
      .mockImplementation(async (file, info, permission) => {
        if (record(file) && !held) {
          held = true;
          entered.release();
          await release.promise;
        }
        return originalMetadata(file, info, permission);
      });
    const handles: FileHandle[] = [];
    const reads: MockInstance[] = [];
    const originalOpen = fs.open;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (typeof args[0] === 'string' && record(args[0])) {
        handles.push(handle);
        reads.push(vi.spyOn(handle, 'read'));
      }
      return handle;
    });
    syncBuiltinESMExports();
    const reopened = f.reopen();
    let finished = false;
    let closing: Promise<unknown> | undefined;
    try {
      await entered.promise;
      expect(handles).toHaveLength(1);
      expect(handles[0].fd).toBeGreaterThanOrEqual(0);
      closing = (mode === 'owner close' ? reopened.close() : f.close()).then(() => {
        finished = true;
      });
      await new Promise((ready) => setImmediate(ready));
      expect(finished).toBe(false);
      release.release();
      await closing;
      expect(handles).toHaveLength(1);
      expect(handles[0].fd).toBe(-1);
      expect(reads.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      await new Promise((ready) => setImmediate(ready));
      expect(handles).toHaveLength(1);
      await expect(reopened.status('mock-load-a')).rejects.toMatchObject({
        code: 'BOT_IMPORT_STORE',
      });
    } finally {
      release.release();
      try {
        await reopened.ready;
        await closing;
      } finally {
        metadata.mockRestore();
        open.mockRestore();
        for (const spy of reads) spy.mockRestore();
        syncBuiltinESMExports();
        await f.close();
      }
    }
  },
);

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
    expect((await transfers.status(h.id)).state).toBe('complete');
    expect(extracted).toBe(1);
    await transfers.close();
    await transfers.close();
    expect(closed).toBe(0);
    await documents.close();
    expect(closed).toBe(1);
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
    expect(results.filter((result) => result.status === 'fulfilled').length).toBe(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason.code).toBe('BOT_TRANSFER_BUSY');
    release('SYNTHETIC EXTRACTED TEXT');
    await f.transfers.settled;
    expect(validating).toBe(1);
    expect((await f.transfers.status(h.id)).state).toBe('complete');
  } finally {
    release('SYNTHETIC EXTRACTED TEXT');
    await f.close();
  }
});
test('unknown cancellations respect the durable record limit so a later restart can still read it', async (t) => {
  const f = await fixture();
  let reopened: BotBundles | undefined;
  let seeding: Promise<unknown> | undefined;
  let closing: Promise<unknown> | undefined;
  const teardown = () => {
    closing ??= (async () => {
      await reopened?.close();
      await seeding?.catch(() => {});
      await f.close();
    })();
    return closing;
  };
  // The runner can time out before this callback's finally runs; it still owns these stores and writes.
  t.onTestFinished(async () => {
    await teardown();
  });
  try {
    await f.transfers.ready;
    await f.transfers.close();
    t.signal.throwIfAborted();
    seeding = seed(f.options.directory, t.signal);
    await seeding;
    t.signal.throwIfAborted();
    reopened = f.reopen();
    await expect(reopened.cancel(header(bundle(), 'mock-over-limit'))).rejects.toMatchObject({
      code: 'BOT_IMPORT_LIMIT',
    });
    expect((await reopened.status('mock-cancel-0')).state).toBe('cancelled');
    expect((await readdir(f.options.directory)).length).toBe(4096);
  } finally {
    await teardown();
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
    expect(await f.transfers.status(h.id)).toStrictEqual({ id: h.id, state: 'unknown' });
    expect((await f.transfers.begin(h)).state).toBe('awaiting');
    await f.transfers.submit(h.id, value);
    await f.transfers.settled;
    const receipt = await f.transfers.status(h.id);
    expect(receipt.state).toBe('complete');
    const imported = receipt.profile!;
    expect(imported.id).not.toBe(other.id);
    expect(imported.model).toBe(undefined);
    expect(imported.memory).toBe(value.preferences);
    expect(await f.profiles.get(other.id)).toStrictEqual(other);
    expect.assert((await f.skills.list(imported.id)).items.every((item) => !item.enabled));
    const docs = await f.knowledge.list(imported.id);
    expect(docs.length).toBe(2);
    const originalDoc = docs.find((item) => item.source)!;
    expect((await f.knowledge.source(imported.id, originalDoc.id)).file.data).toBe(
      value.knowledge[1].original!.data,
    );
    const edited = await f.profiles.update(imported.id, imported.revision, {
      name: '合成后续编辑',
    });
    expect((await f.transfers.begin(h)).profile?.name).toBe(edited.name);
    expect((await f.transfers.submit(h.id, value)).profile?.name).toBe(edited.name);
    await expect(f.transfers.begin({ ...h, sha256: 'b'.repeat(64) })).rejects.toMatchObject({
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
    expect((await f.transfers.status(h.id)).state).toBe('failed');
    expect(await f.profiles.list()).toStrictEqual([]);
    f.profiles.registerImport = register;
    await f.transfers.close();
    reopened = new BotBundles(f.options);
    await reopened.retry(h.id);
    await reopened.settled;
    const complete = await reopened.status(h.id);
    expect(complete.state).toBe('complete');
    expect((await f.profiles.list()).length).toBe(1);
    expect((await f.skills.list(complete.profile!.id)).items.length).toBe(1);
    expect.assert(
      (await f.knowledge.list(complete.profile!.id)).every((item) => item.revision === 1),
    );
    expect.assert((await readdir(f.options.directory)).includes(`${h.id}.json`));
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
    expect(failed.state).toBe('failed');
    expect(failed.canCancel).toBe(true);
    expect(await f.profiles.list()).toStrictEqual([]);
    expect((await f.skills.list('mock-target')).items).toStrictEqual([]);
    expect((await f.transfers.cancel(h)).state).toBe('cancelled');
    expect((await f.transfers.begin(h)).state).toBe('cancelled');
    await expect(f.transfers.submit(h.id, value)).rejects.toMatchObject({
      code: 'BOT_IMPORT_CANCELLED',
    });
  } finally {
    await f.close();
  }
});
test('cancelling an unknown header leaves a tombstone, so late begin/submit cannot create anything', async () => {
  const f = await fixture(),
    value = bundle(),
    h = header(value);
  try {
    expect((await f.transfers.cancel(h)).state).toBe('cancelled');
    expect((await f.transfers.begin(h)).state).toBe('cancelled');
    await expect(f.transfers.submit(h.id, value)).rejects.toMatchObject({
      code: 'BOT_IMPORT_CANCELLED',
    });
    expect(await f.profiles.list()).toStrictEqual([]);
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
    expect(exported.profile.name).toBe(p.name);
    expect(exported.preferences).toBe(p.memory);
    expect(exported.skills[0].content).toBe(recipe);
    expect(exported.knowledge[0].content).toBe(doc.content);
    expect('id' in exported.profile).toBe(false);
    expect('model' in exported.profile).toBe(false);
    expect('credentials' in exported).toBe(false);
    await expect(
      f.transfers.export({ bot: p.id, revision: 2, memory: true, skills: [], knowledge: [] }),
    ).rejects.toMatchObject({ code: 'BOT_PROFILE_CONFLICT' });
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
    expect(receipt.state).toBe('complete');
    const edited = await f.profiles.update(receipt.profile!.id, 1, { name: '合成后续编辑' });
    const retried = await f.transfers.retry(h.id);
    expect(retried.profile?.name).toBe(edited.name);
    expect((await stat(path.join(f.options.directory, `${h.id}.bundle`))).size).toBe(0);
    expect((await f.profiles.list()).length).toBe(1);
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
    expect((await f.transfers.export(query)).knowledge[0].original).toBe(undefined);
    expect(
      (await f.transfers.export({ ...query, originals: true })).knowledge[0].original,
    ).toStrictEqual(original);
  } finally {
    await f.close();
  }
});

test('complete skill packages survive Bot export and import without changing legacy bundle receipts', async () => {
  const f = await fixture();
  try {
    const profile = await f.profiles.register({
      id: 'mock-package-bot',
      name: 'Synthetic',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const pkg = {
      root: 'mock-outline',
      files: [
        { path: 'SKILL.md', data: Buffer.from(recipe).toString('base64') },
        { path: 'assets/template.bin', data: Buffer.from([0, 255, 1]).toString('base64') },
        {
          path: 'scripts/report.py',
          data: Buffer.from('print("SYNTHETIC")\n').toString('base64'),
          executable: true,
        },
      ],
    };
    const skill = await f.skills.importPackage(pkg);
    await f.skills.bind(profile.id, {
      id: skill.id,
      revision: skill.revision,
      bindingRevision: 0,
      enabled: true,
    });
    const exported = await f.transfers.export({
      bot: profile.id,
      revision: profile.revision,
      memory: false,
      skills: [{ id: skill.id, revision: skill.revision }],
      knowledge: [],
    });
    expect(exported.version).toBe(2);
    expect(isBotBundle(exported)).toBe(true);
    const text = botBundleText(exported);
    expect.assert(text.includes('assets/template.bin'));
    const h = header(exported, 'mock-complete-package');
    await f.transfers.begin(h);
    await f.transfers.submit(h.id, JSON.parse(text));
    await f.transfers.settled;
    expect((await f.transfers.status(h.id)).state).toBe('complete');
    const full = await f.skills.exportPackage(skill.id, skill.revision);
    expect(full.files.find((file) => file.path === 'assets/template.bin')?.data).toStrictEqual(
      pkg.files[1].data,
    );
    const mismatched = JSON.parse(text);
    mismatched.skills[0].content = recipe + 'CHANGED';
    expect(isBotBundle(mismatched)).toBe(false);
    const legacy = bundle();
    expect(JSON.parse(botBundleText(legacy)).version).toBe(1);
    const downgrade = JSON.parse(text);
    downgrade.version = 1;
    expect(isBotBundle(downgrade)).toBe(false);
  } finally {
    await f.close();
  }
});
