import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { type GroupRunner, Groups } from './groups.js';

const source = {
  id: 'mock-source-group',
  name: '合成原群聊',
  members: ['mock-alpha', 'mock-beta'],
};
const request = { id: 'mock-copied-group', group: source.id, revision: 1, name: '合成群聊副本' };

async function fixture(legacy = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-group-copy-'));
  const file = path.join(root, 'groups.sqlite');
  if (legacy) {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE group_defs(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare('INSERT INTO group_defs(id,value) VALUES(?,?)').run(
      source.id,
      JSON.stringify({
        ...source,
        revision: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
    db.close();
  }
  const members = new Set(['mock-alpha', 'mock-beta', 'mock-gamma']);
  const blocked = new Set<string>();
  const starts: string[] = [];
  const runner: GroupRunner = {
    member: async (id) => (members.has(id) ? { id, name: `合成 ${id}` } : undefined),
    running: () => false,
    groupRunning: () => false,
    admit: (id) => !blocked.has(id),
    findRequest: () => undefined,
    start: async (bot) => {
      starts.push(bot);
      throw new Error('MOCK_UNEXPECTED_DISPATCH');
    },
    stopRequest: async () => {
      throw new Error('MOCK_UNEXPECTED_STOP');
    },
  };
  let groups = new Groups(file, runner);
  await groups.register(source);
  return {
    file,
    members,
    blocked,
    starts,
    runner,
    get groups() {
      return groups;
    },
    async reopen() {
      await groups.close();
      groups = new Groups(file, runner);
      await groups.ready;
    },
    async close() {
      await groups.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('copies membership into an independent empty group while the source collaboration remains untouched', async () => {
  const f = await fixture();
  try {
    await f.groups.send({
      id: 'mock-existing-turn',
      group: source.id,
      prompt: 'MOCK EXISTING REQUEST',
      recipients: source.members,
    });
    f.runner.groupRunning = () => true;
    const before = await f.groups.read(source.id);
    assert.deepEqual(await f.groups.copyReceipt(request), { request, state: 'unknown' });
    const copied = await f.groups.copy(request);
    assert.equal(copied.state, 'complete');
    assert.deepEqual(copied.request, request);
    assert.equal(copied.group.id, request.id);
    assert.equal(copied.group.name, request.name);
    assert.equal(copied.group.revision, 1);
    assert.deepEqual(copied.group.members, source.members);
    const page = await f.groups.read(request.id),
      original = await f.groups.read(source.id);
    assert.deepEqual(page.messages, []);
    assert.deepEqual(page.deliveries, []);
    assert.deepEqual(original.group, before.group);
    assert.deepEqual(original.messages, before.messages);
    assert.deepEqual(original.deliveries, before.deliveries);
    assert.deepEqual(f.starts, []);
    copied.group.members.push('mock-gamma');
    const receipt = await f.groups.copyReceipt(request);
    assert.ok(receipt.state === 'complete');
    assert.deepEqual(receipt.group.members, source.members);
  } finally {
    await f.close();
  }
});

test('exact replay returns current target state after edits, archive and restart without needing the old source or active members', async () => {
  const f = await fixture();
  try {
    const first = await f.groups.copy(request);
    const edited = await f.groups.update(request.id, first.group.revision, {
      name: '合成后续名称',
      members: ['mock-beta', 'mock-gamma'],
    });
    const archived = await f.groups.action({
      id: 'mock-archive-copy',
      group: request.id,
      action: 'archive',
      revision: edited.revision,
    });
    await f.groups.action({
      id: 'mock-archive-source',
      group: source.id,
      action: 'archive',
      revision: 1,
    });
    await f.reopen();
    f.members.clear();
    assert.deepEqual((await f.groups.copy(request)).group, archived.group);
    const receipt = await f.groups.copyReceipt(request);
    assert.ok(receipt.state === 'complete');
    assert.deepEqual(receipt.group, archived.group);
    assert.equal((await f.groups.status()).items.length, 2);
    assert.deepEqual(f.starts, []);
  } finally {
    await f.close();
  }
});

test('source version, archive, unavailable members and personal identities are checked before a new target is created', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.groups.copy({ ...request, revision: 2 }), /GROUP_CONFLICT/);
    f.blocked.add('mock-beta');
    await assert.rejects(f.groups.copy(request), /BOT_UNAVAILABLE/);
    f.blocked.clear();
    f.members.delete('mock-beta');
    await assert.rejects(f.groups.copy(request), /GROUP_MEMBER_REQUIRED/);
    f.members.add('mock-beta');
    f.members.add(request.id);
    await assert.rejects(f.groups.copy(request), /GROUP_ID_CONFLICT/);
    f.members.delete(request.id);
    await f.groups.action({
      id: 'mock-source-archived',
      group: source.id,
      action: 'archive',
      revision: 1,
    });
    await assert.rejects(f.groups.copy(request), /GROUP_ARCHIVED/);
    assert.deepEqual(await f.groups.copyReceipt(request), { request, state: 'unknown' });
    assert.equal((await f.groups.status()).items.length, 1);
  } finally {
    await f.close();
  }
});

test('foreign targets and changed payloads cannot be claimed as a copy receipt', async () => {
  const f = await fixture();
  try {
    await f.groups.register({
      id: 'mock-foreign-target',
      name: '合成既有群聊',
      members: source.members,
    });
    await assert.rejects(
      f.groups.copy({ ...request, id: 'mock-foreign-target' }),
      /GROUP_COPY_CONFLICT/,
    );
    await assert.rejects(
      f.groups.copyReceipt({ ...request, id: 'mock-foreign-target' }),
      /GROUP_COPY_CONFLICT/,
    );
    await f.groups.copy(request);
    for (const input of [
      { ...request, name: '合成不同名称' },
      { ...request, revision: 2 },
      { ...request, group: 'mock-other-source' },
    ]) {
      await assert.rejects(f.groups.copy(input), /GROUP_COPY_CONFLICT/);
      await assert.rejects(f.groups.copyReceipt(input), /GROUP_COPY_CONFLICT/);
    }
    assert.deepEqual((await f.groups.copyReceipt(request)).request, request);
    assert.deepEqual(f.starts, []);
  } finally {
    await f.close();
  }
});

test('closed copy inputs are captured before queueing and concurrent retries create exactly one group', async () => {
  const f = await fixture();
  try {
    const invalid = [
      null,
      {},
      { ...request, id: 'research' },
      { ...request, id: 'writer' },
      { ...request, id: source.id },
      { ...request, revision: 0 },
      { ...request, revision: 1.5 },
      { ...request, name: '' },
      { ...request, name: 'x'.repeat(31) },
      { ...request, name: 'mock\0name' },
      { ...request, members: source.members },
    ];
    for (const input of invalid) {
      await assert.rejects(f.groups.copy(input), /INVALID_GROUP_COPY/);
      await assert.rejects(f.groups.copyReceipt(input), /INVALID_GROUP_COPY/);
    }
    const input = { ...request };
    const pending = f.groups.copy(input);
    input.name = 'MOCK MUTATED INPUT';
    const [one, two] = await Promise.all([pending, f.groups.copy(request)]);
    assert.deepEqual(one, two);
    assert.deepEqual(one.request, request);
    const reading = { ...request };
    const receipt = f.groups.copyReceipt(reading);
    reading.name = 'MOCK MUTATED READ';
    assert.deepEqual(await receipt, one);
    assert.equal((await f.groups.status()).items.length, 2);
  } finally {
    await f.close();
  }
});

test('the definition and private receipt roll back together if the SQLite transaction cannot commit', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.file);
  try {
    db.exec(
      "CREATE TRIGGER mock_abort_copy BEFORE UPDATE ON group_meta BEGIN SELECT RAISE(ABORT,'MOCK_WRITE_FAILURE'); END",
    );
    await assert.rejects(f.groups.copy(request), /MOCK_WRITE_FAILURE/);
    assert.deepEqual(await f.groups.copyReceipt(request), { request, state: 'unknown' });
    assert.equal((await f.groups.status()).items.length, 1);
    db.exec('DROP TRIGGER mock_abort_copy');
    const accepted = await f.groups.copy(request);
    assert.deepEqual(await f.groups.copyReceipt(request), accepted);
  } finally {
    db.close();
    await f.close();
  }
});

test('copy origins migrate privately from legacy groups and survive ordinary value updates without leaking or forging authority', async () => {
  const f = await fixture(true);
  const db = new DatabaseSync(f.file);
  try {
    const first = await f.groups.copy(request);
    const edited = {
      ...first.group,
      name: '合成旧读取器编辑',
      revision: 2,
      updatedAt: new Date().toISOString(),
    };
    db.prepare('UPDATE group_defs SET value=? WHERE id=?').run(JSON.stringify(edited), request.id);
    await f.reopen();
    const receipt = await f.groups.copyReceipt(request);
    assert.ok(receipt.state === 'complete');
    assert.deepEqual(receipt.group, edited);
    assert.equal(JSON.stringify(await f.groups.status()).includes('copy_origin'), false);
    await assert.rejects(
      f.groups.register({ ...edited, copy_origin: 'MOCK FORGED ORIGIN' }),
      /INVALID_GROUP/,
    );
    db.prepare('UPDATE group_defs SET copy_origin=? WHERE id=?').run(
      'MOCK CORRUPT ORIGIN',
      request.id,
    );
    await assert.rejects(f.groups.copyReceipt(request), /GROUP_COPY_CONFLICT/);
    assert.deepEqual((await f.groups.read(request.id)).group, edited);
  } finally {
    db.close();
    await f.close();
  }
});

test('copies respect the existing retained-group capacity while accepted receipts remain readable at capacity', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 48; index++)
      await f.groups.register({
        id: `mock-capacity-${index}`,
        name: `合成容量 ${index}`,
        members: source.members,
      });
    const accepted = await f.groups.copy(request);
    assert.equal((await f.groups.status()).items.length, 50);
    await assert.rejects(f.groups.copy({ ...request, id: 'mock-over-capacity' }), /GROUP_LIMIT/);
    assert.deepEqual(await f.groups.copyReceipt({ ...request, id: 'mock-over-capacity' }), {
      request: { ...request, id: 'mock-over-capacity' },
      state: 'unknown',
    });
    assert.deepEqual(await f.groups.copy(request), accepted);
  } finally {
    await f.close();
  }
});

test('creation admission cannot yield to another lifecycle owner before the group row is committed', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.file);
  const observed: boolean[] = [];
  let target = request.id;
  try {
    f.runner.admit = (member) => {
      if (member === 'mock-beta') {
        const captured = target;
        queueMicrotask(() =>
          observed.push(!!db.prepare('SELECT id FROM group_defs WHERE id=?').get(captured)),
        );
      }
      return true;
    };
    await f.groups.copy(request);
    target = 'mock-ordinary-creation';
    await f.groups.register({ id: target, name: '合成普通创建', members: source.members });
    assert.deepEqual(observed, [true, true]);
  } finally {
    db.close();
    await f.close();
  }
});
