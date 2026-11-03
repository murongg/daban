import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { expect, test } from 'vitest';
import { type GroupRunner, Groups } from './groups.js';
import { groupDefs } from './groups-schema.js';

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
    expect(await f.groups.copyReceipt(request)).toStrictEqual({ request, state: 'unknown' });
    const copied = await f.groups.copy(request);
    expect(copied.state).toBe('complete');
    expect(copied.request).toStrictEqual(request);
    expect(copied.group.id).toBe(request.id);
    expect(copied.group.name).toBe(request.name);
    expect(copied.group.revision).toBe(1);
    expect(copied.group.members).toStrictEqual(source.members);
    const page = await f.groups.read(request.id),
      original = await f.groups.read(source.id);
    expect(page.messages).toStrictEqual([]);
    expect(page.deliveries).toStrictEqual([]);
    expect(original.group).toStrictEqual(before.group);
    expect(original.messages).toStrictEqual(before.messages);
    expect(original.deliveries).toStrictEqual(before.deliveries);
    expect(f.starts).toStrictEqual([]);
    copied.group.members.push('mock-gamma');
    const receipt = await f.groups.copyReceipt(request);
    expect.assert(receipt.state === 'complete');
    expect(receipt.group.members).toStrictEqual(source.members);
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
    expect((await f.groups.copy(request)).group).toStrictEqual(archived.group);
    const receipt = await f.groups.copyReceipt(request);
    expect.assert(receipt.state === 'complete');
    expect(receipt.group).toStrictEqual(archived.group);
    expect((await f.groups.status()).items.length).toBe(2);
    expect(f.starts).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('source version, archive, unavailable members and personal identities are checked before a new target is created', async () => {
  const f = await fixture();
  try {
    await expect(f.groups.copy({ ...request, revision: 2 })).rejects.toThrowError(/GROUP_CONFLICT/);
    f.blocked.add('mock-beta');
    await expect(f.groups.copy(request)).rejects.toThrowError(/BOT_UNAVAILABLE/);
    f.blocked.clear();
    f.members.delete('mock-beta');
    await expect(f.groups.copy(request)).rejects.toThrowError(/GROUP_MEMBER_REQUIRED/);
    f.members.add('mock-beta');
    f.members.add(request.id);
    await expect(f.groups.copy(request)).rejects.toThrowError(/GROUP_ID_CONFLICT/);
    f.members.delete(request.id);
    await f.groups.action({
      id: 'mock-source-archived',
      group: source.id,
      action: 'archive',
      revision: 1,
    });
    await expect(f.groups.copy(request)).rejects.toThrowError(/GROUP_ARCHIVED/);
    expect(await f.groups.copyReceipt(request)).toStrictEqual({ request, state: 'unknown' });
    expect((await f.groups.status()).items.length).toBe(1);
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
    await expect(f.groups.copy({ ...request, id: 'mock-foreign-target' })).rejects.toThrowError(
      /GROUP_COPY_CONFLICT/,
    );
    await expect(
      f.groups.copyReceipt({ ...request, id: 'mock-foreign-target' }),
    ).rejects.toThrowError(/GROUP_COPY_CONFLICT/);
    await f.groups.copy(request);
    for (const input of [
      { ...request, name: '合成不同名称' },
      { ...request, revision: 2 },
      { ...request, group: 'mock-other-source' },
    ]) {
      await expect(f.groups.copy(input)).rejects.toThrowError(/GROUP_COPY_CONFLICT/);
      await expect(f.groups.copyReceipt(input)).rejects.toThrowError(/GROUP_COPY_CONFLICT/);
    }
    expect((await f.groups.copyReceipt(request)).request).toStrictEqual(request);
    expect(f.starts).toStrictEqual([]);
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
      await expect(f.groups.copy(input)).rejects.toThrowError(/INVALID_GROUP_COPY/);
      await expect(f.groups.copyReceipt(input)).rejects.toThrowError(/INVALID_GROUP_COPY/);
    }
    const input = { ...request };
    const pending = f.groups.copy(input);
    input.name = 'MOCK MUTATED INPUT';
    const [one, two] = await Promise.all([pending, f.groups.copy(request)]);
    expect(one).toStrictEqual(two);
    expect(one.request).toStrictEqual(request);
    const reading = { ...request };
    const receipt = f.groups.copyReceipt(reading);
    reading.name = 'MOCK MUTATED READ';
    expect(await receipt).toStrictEqual(one);
    expect((await f.groups.status()).items.length).toBe(2);
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
    await expect(f.groups.copy(request)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/MOCK_WRITE_FAILURE/) },
    });
    expect(await f.groups.copyReceipt(request)).toStrictEqual({ request, state: 'unknown' });
    expect((await f.groups.status()).items.length).toBe(1);
    db.exec('DROP TRIGGER mock_abort_copy');
    const accepted = await f.groups.copy(request);
    expect(await f.groups.copyReceipt(request)).toStrictEqual(accepted);
  } finally {
    db.close();
    await f.close();
  }
});

test('copy origins migrate privately from legacy groups and survive ordinary value updates without leaking or forging authority', async () => {
  const f = await fixture(true);
  const client = new DatabaseSync(f.file);
  const db = drizzle({ client });
  try {
    const first = await f.groups.copy(request);
    const edited = {
      ...first.group,
      name: '合成旧读取器编辑',
      revision: 2,
      updatedAt: new Date().toISOString(),
    };
    db.update(groupDefs)
      .set({ value: JSON.stringify(edited) })
      .where(eq(groupDefs.id, request.id))
      .run();
    await f.reopen();
    const receipt = await f.groups.copyReceipt(request);
    expect.assert(receipt.state === 'complete');
    expect(receipt.group).toStrictEqual(edited);
    expect(JSON.stringify(await f.groups.status()).includes('copy_origin')).toBe(false);
    await expect(
      f.groups.register({ ...edited, copy_origin: 'MOCK FORGED ORIGIN' }),
    ).rejects.toThrowError(/INVALID_GROUP/);
    db.update(groupDefs)
      .set({ copyOrigin: 'MOCK CORRUPT ORIGIN' })
      .where(eq(groupDefs.id, request.id))
      .run();
    await expect(f.groups.copyReceipt(request)).rejects.toThrowError(/GROUP_COPY_CONFLICT/);
    expect((await f.groups.read(request.id)).group).toStrictEqual(edited);
  } finally {
    client.close();
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
    expect((await f.groups.status()).items.length).toBe(50);
    await expect(f.groups.copy({ ...request, id: 'mock-over-capacity' })).rejects.toThrowError(
      /GROUP_LIMIT/,
    );
    expect(await f.groups.copyReceipt({ ...request, id: 'mock-over-capacity' })).toStrictEqual({
      request: { ...request, id: 'mock-over-capacity' },
      state: 'unknown',
    });
    expect(await f.groups.copy(request)).toStrictEqual(accepted);
  } finally {
    await f.close();
  }
});

test('creation admission cannot yield to another lifecycle owner before the group row is committed', async () => {
  const f = await fixture();
  const client = new DatabaseSync(f.file);
  const db = drizzle({ client });
  const observed: boolean[] = [];
  let target = request.id;
  try {
    f.runner.admit = (member) => {
      if (member === 'mock-beta') {
        const captured = target;
        queueMicrotask(() =>
          observed.push(
            !!db
              .select({ id: groupDefs.id })
              .from(groupDefs)
              .where(eq(groupDefs.id, captured))
              .get(),
          ),
        );
      }
      return true;
    };
    await f.groups.copy(request);
    target = 'mock-ordinary-creation';
    await f.groups.register({ id: target, name: '合成普通创建', members: source.members });
    expect(observed).toStrictEqual([true, true]);
  } finally {
    client.close();
    await f.close();
  }
});
