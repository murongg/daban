import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Group,
  type GroupActionAck,
  type GroupActionReceipt,
  type GroupCopyAck,
  type GroupCopyReceipt,
  type GroupCopyRequest,
  type GroupDelivery,
  type GroupMessage,
  type GroupPage,
  type GroupSend,
  groupCopyKey,
  isGroup,
  isGroupActionReceipt,
  isGroupActionRequest,
  isGroupCopyRequest,
  isGroupInput,
  isGroupSend,
  isTaskFile,
  isTaskFileName,
  type ModelId,
  type RuntimeFile,
  type RuntimeNotice,
  replyLimit,
  type TaskFile,
  type TaskRequest,
  validAgentId,
} from '@daban/protocol';
import type { Attachments } from './attachments.js';
import { errorCode, Fault } from './control.js';
import type { ConversationScope, RunReceipt } from './tasks.js';

export type GroupReceipt = RunReceipt;
export interface GroupRunner {
  member(bot: string): Promise<{ id: string; name: string; instructions?: string } | undefined>;
  directory?(): Promise<{ id: string; name: string; instructions?: string }[]>;
  source?(bot: string, runId: string): { intentId: string } | undefined;
  running(bot: string): boolean;
  groupRunning?(group: string): boolean;
  admit?(bot: string): boolean;
  findRequest(bot: string, requestId: string): GroupReceipt | undefined;
  start(bot: string, task: TaskRequest, scope: ConversationScope): Promise<unknown>;
  stopRequest(bot: string, requestId: string, conversationId: string): Promise<unknown>;
}
export interface GroupSource {
  bot: string;
  runId: string;
  group: string;
  signal?: AbortSignal;
}
interface CollaborationSource {
  bot: string;
  runId: string;
  signal?: AbortSignal;
}
type Row = Record<string, unknown>;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);
const activeStates = new Set(['pending', 'claimed', 'running']);
const terminal = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const requestId = (delivery: Row) => `group-${delivery.id}`;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export class Groups {
  // shortcut: one local service owns this database; acquire a process lease before supporting multiple dispatchers.
  readonly ready: Promise<unknown>;
  private db!: DatabaseSync;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private failure = '';
  private preparing = new Map<string, Set<string>>();
  constructor(
    readonly file: string,
    readonly runner: GroupRunner,
    readonly uploads?: Attachments,
  ) {
    this.ready = this.load();
    this.ready.catch(() => {
      this.failure = 'GROUP_UNAVAILABLE';
    });
  }
  private async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.close();
    await chmod(this.file, 0o600);
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS group_defs(id TEXT PRIMARY KEY,value TEXT NOT NULL,copy_origin TEXT);
      CREATE TABLE IF NOT EXISTS group_actions(id TEXT PRIMARY KEY,grp TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS group_actions_owner ON group_actions(grp);
      CREATE TABLE IF NOT EXISTS group_turns(grp TEXT NOT NULL,id TEXT NOT NULL,prompt TEXT NOT NULL,recipients TEXT NOT NULL,signature TEXT NOT NULL,seq INTEGER,created TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(grp,id));
      CREATE TABLE IF NOT EXISTS group_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,grp TEXT NOT NULL,source TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,created TEXT NOT NULL,author TEXT,name TEXT,phase TEXT,model TEXT,files TEXT,UNIQUE(grp,id));
      CREATE INDEX IF NOT EXISTS group_messages_page ON group_messages(grp,seq);
      CREATE TABLE IF NOT EXISTS group_deliveries(id TEXT PRIMARY KEY,grp TEXT NOT NULL,source TEXT NOT NULL,bot TEXT NOT NULL,position INTEGER NOT NULL,state TEXT NOT NULL,run TEXT,context TEXT,name TEXT,error TEXT);
      CREATE INDEX IF NOT EXISTS group_deliveries_queue ON group_deliveries(grp,source,position);
      CREATE TABLE IF NOT EXISTS group_handoffs(source TEXT PRIMARY KEY,signature TEXT NOT NULL,target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_collaborations(source TEXT PRIMARY KEY,grp TEXT NOT NULL,turn TEXT NOT NULL,signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO group_meta(id,revision) VALUES(1,0);`);
    if (
      !this.db
        .prepare('PRAGMA table_info(group_defs)')
        .all()
        .some((row) => row.name === 'copy_origin')
    )
      this.db.exec('ALTER TABLE group_defs ADD COLUMN copy_origin TEXT');
    if (
      !this.db
        .prepare('PRAGMA table_info(group_turns)')
        .all()
        .some((row) => row.name === 'inputs')
    )
      this.db.exec("ALTER TABLE group_turns ADD COLUMN inputs TEXT NOT NULL DEFAULT '[]'");
    if (
      !this.db
        .prepare('PRAGMA table_info(group_messages)')
        .all()
        .some((row) => row.name === 'run')
    )
      this.db.exec('ALTER TABLE group_messages ADD COLUMN run TEXT');
    for (const row of this.db.prepare('SELECT * FROM group_defs').all()) this.definition(row);
    for (const row of this.db
      .prepare("SELECT * FROM group_deliveries WHERE state IN ('claimed','running')")
      .all())
      this.reconcile(row, true);
  }
  private exclusive<T>(operation: () => T | Promise<T>) {
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        await this.ready;
        if (this.closed) throw new Fault('GROUP_UNAVAILABLE', 503);
        return operation();
      });
    this.chain = next;
    return next;
  }
  private transaction<T>(operation: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private changed() {
    this.db.exec('UPDATE group_meta SET revision=revision+1 WHERE id=1');
  }
  private revision() {
    return Number(this.db.prepare('SELECT revision FROM group_meta WHERE id=1').get()!.revision);
  }
  private accepted(group: string, source: string): GroupPage {
    const row = this.db
      .prepare("SELECT * FROM group_messages WHERE grp=? AND id=? AND role='user'")
      .get(group, source);
    if (!row) throw new Fault('GROUP_CORRUPT');
    return { ...this.page(group), accepted: this.message(row) };
  }
  private definition(row: Row): Group {
    let value: unknown;
    try {
      value = JSON.parse(String(row.value));
    } catch {
      throw new Fault('GROUP_CORRUPT');
    }
    if (!isGroup(value) || value.id !== row.id) throw new Fault('GROUP_CORRUPT');
    return value;
  }
  private group(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_GROUP', 400);
    const row = this.db.prepare('SELECT * FROM group_defs WHERE id=?').get(id);
    if (!row) throw new Fault('GROUP_NOT_FOUND', 404);
    return this.definition(row);
  }
  private actionRecord(id: string): GroupActionReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM group_actions WHERE id=?').get(id);
    if (!row) return undefined;
    let value: unknown;
    try {
      if (typeof row.value !== 'string' || row.value.length > 16384)
        throw new Error('invalid receipt');
      value = JSON.parse(row.value);
    } catch {
      throw new Fault('GROUP_ACTION_CORRUPT');
    }
    if (!isGroupActionReceipt(value) || value.request.id !== id || value.request.group !== row.grp)
      throw new Fault('GROUP_ACTION_CORRUPT');
    return value;
  }
  private busy(id: string) {
    return (
      !!this.db
        .prepare(
          "SELECT id FROM group_deliveries WHERE grp=? AND state IN ('pending','claimed','running') LIMIT 1",
        )
        .get(id) || this.runner.groupRunning?.(id) === true
    );
  }
  action(input: unknown): Promise<GroupActionAck> {
    if (!isGroupActionRequest(input)) return Promise.reject(new Fault('INVALID_GROUP_ACTION', 400));
    const request = {
      id: input.id,
      group: input.group,
      action: input.action,
      revision: input.revision,
    };
    return this.exclusive(() =>
      this.transaction(() => {
        const prior = this.actionRecord(request.id);
        if (prior) {
          if (JSON.stringify(prior.request) !== JSON.stringify(request))
            throw new Fault('GROUP_ACTION_ID_REUSED');
          return { receipt: prior, group: this.group(request.group) };
        }
        const current = this.group(request.group);
        if (current.revision !== request.revision) throw new Fault('GROUP_CONFLICT');
        if (typeof this.runner.groupRunning !== 'function')
          throw new Fault('GROUP_LIFECYCLE_UNAVAILABLE', 503);
        if (this.busy(request.group)) throw new Fault('GROUP_BUSY');
        if (!!current.archived === (request.action === 'archive'))
          throw new Fault('GROUP_STATE_CONFLICT');
        if (
          Number(this.db.prepare('SELECT count(*) AS count FROM group_actions').get()!.count) >=
          10000
        )
          throw new Fault('GROUP_ACTION_LIMIT');
        const now = new Date().toISOString(),
          group: Group = { ...current, revision: current.revision + 1, updatedAt: now };
        if (request.action === 'archive') group.archived = true;
        else delete group.archived;
        const receipt: GroupActionReceipt = { request, revision: group.revision, completedAt: now };
        // The receipt and state move together; a replay only returns current state, never reapplies intent.
        this.db
          .prepare('UPDATE group_defs SET value=? WHERE id=?')
          .run(JSON.stringify(group), group.id);
        this.db
          .prepare('INSERT INTO group_actions(id,grp,value) VALUES(?,?,?)')
          .run(request.id, group.id, JSON.stringify(receipt));
        this.changed();
        return { receipt, group };
      }),
    );
  }
  actionReceipt(group: string, id: string): Promise<GroupActionAck> {
    if (!validAgentId(group) || !validAgentId(id))
      return Promise.reject(new Fault('INVALID_GROUP_ACTION', 400));
    return this.exclusive(() => {
      const receipt = this.actionRecord(id);
      if (!receipt || receipt.request.group !== group)
        throw new Fault('GROUP_ACTION_NOT_FOUND', 404);
      return { receipt, group: this.group(group) };
    });
  }
  private delivery(row: Row): GroupDelivery {
    return {
      requestId: requestId(row),
      id: String(row.id),
      group: String(row.grp),
      sourceId: String(row.source),
      bot: String(row.bot),
      position: Number(row.position),
      state: row.state as GroupDelivery['state'],
      ...(row.run ? { runId: String(row.run) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
    };
  }
  private message(row: Row): GroupMessage {
    const inputs =
      row.role === 'user'
        ? this.inputs(String(row.grp), String(row.source)).map((file) => file.name)
        : [];
    return {
      ...(row.run ? { runId: String(row.run) } : {}),
      ...(inputs.length ? { inputNames: inputs } : {}),
      id: String(row.id),
      group: String(row.grp),
      sequence: Number(row.seq),
      sourceId: String(row.source),
      role: row.role as GroupMessage['role'],
      text: String(row.text),
      createdAt: String(row.created),
      ...(row.author ? { author: String(row.author) } : {}),
      ...(row.name ? { name: String(row.name) } : {}),
      ...(row.phase ? { phase: row.phase as GroupMessage['phase'] } : {}),
      ...(row.model ? { model: row.model as ModelId } : {}),
      ...(row.files ? { files: JSON.parse(String(row.files)) as RuntimeFile[] } : {}),
    };
  }
  private page(id: string, before?: number, limit = 40): GroupPage {
    const group = this.group(id);
    if (
      (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 40
    )
      throw new Fault('INVALID_GROUP_QUERY', 400);
    const rows = this.db
      .prepare('SELECT * FROM group_messages WHERE grp=? AND seq<? ORDER BY seq DESC LIMIT ?')
      .all(id, before || Number.MAX_SAFE_INTEGER, limit + 1);
    const messages = rows
      .slice(0, limit)
      .reverse()
      .map((row) => this.message(row));
    return {
      group,
      revision: this.revision(),
      messages,
      deliveries: this.db
        .prepare('SELECT * FROM group_deliveries WHERE grp=? ORDER BY rowid DESC LIMIT 160')
        .all(id)
        .reverse()
        .map((row) => this.delivery(row)),
      ...(rows.length > limit ? { nextBefore: messages[0].sequence } : {}),
    };
  }
  read(id: string, before?: number, limit?: number) {
    return this.exclusive(() => this.page(id, before, limit));
  }
  async status() {
    try {
      return await this.exclusive(() => ({
        available: !this.failure,
        revision: this.revision(),
        items: this.db
          .prepare('SELECT * FROM group_defs ORDER BY id')
          .all()
          .map((row) => this.definition(row)),
        ...(this.failure ? { error: this.failure } : {}),
      }));
    } catch {
      return {
        available: false,
        revision: 0,
        items: [] as Group[],
        error: this.failure || 'GROUP_UNAVAILABLE',
      };
    }
  }
  notices(): Promise<RuntimeNotice[]> {
    return this.exclusive(() =>
      this.db
        .prepare(
          "SELECT grp,id,state FROM group_turns WHERE state IN ('completed','failed','interrupted') ORDER BY rowid DESC LIMIT 1000",
        )
        .all()
        .reverse()
        .map((row) => ({
          kind: 'group',
          id: String(row.id),
          group: String(row.grp),
          phase: row.state as 'completed' | 'failed' | 'interrupted',
        })),
    );
  }
  private async creationMembers(id: string, members: string[]) {
    if (await this.runner.member(id)) throw new Fault('GROUP_ID_CONFLICT');
    for (const member of members)
      if (!(await this.runner.member(member))) throw new Fault('GROUP_MEMBER_REQUIRED');
  }
  private admitCreation(members: string[]) {
    // Directory awaits must finish first; commit in this same turn before lifecycle permission can change.
    if (members.some((member) => this.runner.admit?.(member) === false))
      throw new Fault('BOT_UNAVAILABLE');
    if (Number(this.db.prepare('SELECT count(*) AS count FROM group_defs').get()!.count) >= 50)
      throw new Fault('GROUP_LIMIT');
  }
  private collaborationSource(source: CollaborationSource) {
    source.signal?.throwIfAborted();
    const task = this.runner.source?.(source.bot, source.runId);
    if (!task || !validAgentId(task.intentId) || this.runner.admit?.(source.bot) === false)
      throw new Fault('GROUP_SOURCE_CLOSED');
    return digest([source.bot, task.intentId]);
  }
  directory(source: CollaborationSource, args: Record<string, unknown>) {
    return this.exclusive(async () => {
      const identity = this.collaborationSource(source);
      if (
        Object.keys(args).some((key) => !['offset', 'limit'].includes(key)) ||
        (args.offset !== undefined &&
          (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)) ||
        (args.limit !== undefined &&
          (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20))
      )
        throw new Fault('INVALID_GROUP_QUERY', 400);
      if (!this.runner.directory) throw new Fault('GROUP_UNAVAILABLE', 503);
      const members = await this.runner.directory();
      if (this.collaborationSource(source) !== identity) throw new Fault('GROUP_SOURCE_CLOSED');
      const eligible = members
        .filter((member) => member.id !== source.bot && this.runner.admit?.(member.id) !== false)
        .sort((a, b) => a.id.localeCompare(b.id));
      const offset = Number(args.offset ?? 0),
        limit = Number(args.limit ?? 20);
      return {
        untrusted: true,
        items: eligible.slice(offset, offset + limit).map(({ id, name, instructions }) => ({
          id,
          name,
          role: Array.from(instructions || '')
            .slice(0, 240)
            .join(''),
          ...(Array.from(instructions || '').length > 240 ? { roleTruncated: true } : {}),
        })),
        ...(offset + limit < eligible.length ? { nextOffset: offset + limit } : {}),
      };
    });
  }
  collaborate(source: CollaborationSource, input: unknown) {
    if (
      !object(input) ||
      Object.keys(input).some((key) => !['name', 'members', 'message'].includes(key)) ||
      !Array.isArray(input.members) ||
      input.members.includes(source.bot) ||
      !isGroupInput({
        id: source.bot,
        name: input.name,
        members: [source.bot, ...input.members],
      }) ||
      typeof input.message !== 'string' ||
      !input.message.trim() ||
      input.message.length > 12000 ||
      input.message.includes('\0')
    )
      return Promise.reject(new Fault('INVALID_GROUP', 400));
    const value = {
      name: String(input.name).trim(),
      members: [...input.members] as string[],
      message: input.message.trim(),
    };
    return this.exclusive(async () => {
      const identity = this.collaborationSource(source);
      const signature = JSON.stringify(value);
      const prior = this.db
        .prepare('SELECT * FROM group_collaborations WHERE source=?')
        .get(identity);
      if (prior) {
        if (prior.signature !== signature) throw new Fault('GROUP_COLLABORATION_CONFLICT');
        return { group: this.group(String(prior.grp)), sourceId: String(prior.turn), reused: true };
      }
      const id = `group-${identity}`,
        sourceId = `task-${identity}`;
      if (this.db.prepare('SELECT id FROM group_defs WHERE id=?').get(id))
        throw new Fault('GROUP_ID_CONFLICT');
      const members = [source.bot, ...value.members];
      await this.creationMembers(id, members);
      const author = await this.runner.member(source.bot);
      // Directory reads yield; task identity and lifecycle eligibility must still match at commit.
      if (this.collaborationSource(source) !== identity || !author)
        throw new Fault('GROUP_SOURCE_CLOSED');
      this.admitCreation(members);
      const now = new Date().toISOString();
      const group: Group = {
        id,
        name: value.name,
        members,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return this.transaction(() => {
        this.db
          .prepare('INSERT INTO group_defs(id,value) VALUES(?,?)')
          .run(id, JSON.stringify(group));
        this.enqueue(
          {
            id: sourceId,
            group: id,
            // Bot authorship is metadata; a prompt prefix would overflow valid summaries at the task limit.
            prompt: value.message,
            recipients: [...value.members, source.bot],
          },
          { bot: source.bot, name: author.name },
        );
        // The group, initial dispatch and durable origin are one effect, including after a crash or retry.
        this.db
          .prepare('INSERT INTO group_collaborations(source,grp,turn,signature) VALUES(?,?,?,?)')
          .run(identity, id, sourceId, signature);
        return { group, sourceId, reused: false };
      });
    });
  }
  private copied(request: GroupCopyRequest): GroupCopyAck | undefined {
    const row = this.db.prepare('SELECT * FROM group_defs WHERE id=?').get(request.id);
    if (!row) return undefined;
    const origin = createHash('sha256').update(groupCopyKey(request)).digest('hex');
    if (row.copy_origin !== origin) throw new Fault('GROUP_COPY_CONFLICT');
    return { request, state: 'complete', group: this.definition(row) };
  }
  copyReceipt(input: unknown): Promise<GroupCopyReceipt> {
    if (!isGroupCopyRequest(input)) return Promise.reject(new Fault('INVALID_GROUP_COPY', 400));
    const request = structuredClone(input);
    return this.exclusive<GroupCopyReceipt>(
      () => this.copied(request) ?? { request, state: 'unknown' },
    );
  }
  copy(input: unknown): Promise<GroupCopyAck> {
    if (!isGroupCopyRequest(input)) return Promise.reject(new Fault('INVALID_GROUP_COPY', 400));
    const request = structuredClone(input);
    return this.exclusive<GroupCopyAck>(async () => {
      // An accepted copy belongs to the target: later source changes must not reapply the old intent.
      const prior = this.copied(request);
      if (prior) return prior;
      const source = this.group(request.group);
      if (source.archived) throw new Fault('GROUP_ARCHIVED');
      if (source.revision !== request.revision) throw new Fault('GROUP_CONFLICT');
      await this.creationMembers(request.id, source.members);
      this.admitCreation(source.members);
      const now = new Date().toISOString();
      const group: Group = {
        id: request.id,
        name: request.name.trim(),
        members: [...source.members],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return this.transaction(() => {
        this.db
          .prepare('INSERT INTO group_defs(id,value,copy_origin) VALUES(?,?,?)')
          .run(
            group.id,
            JSON.stringify(group),
            createHash('sha256').update(groupCopyKey(request)).digest('hex'),
          );
        this.changed();
        return { request, state: 'complete', group };
      });
    });
  }
  register(input: unknown) {
    if (!isGroupInput(input)) return Promise.reject(new Fault('INVALID_GROUP', 400));
    const value = structuredClone(input);
    return this.exclusive(async () => {
      const prior = this.db.prepare('SELECT * FROM group_defs WHERE id=?').get(value.id);
      if (prior) return this.definition(prior);
      await this.creationMembers(value.id, value.members);
      this.admitCreation(value.members);
      const now = new Date().toISOString();
      const group: Group = {
        ...value,
        name: value.name.trim(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return this.transaction(() => {
        this.db
          .prepare('INSERT INTO group_defs(id,value) VALUES(?,?)')
          .run(group.id, JSON.stringify(group));
        this.changed();
        return group;
      });
    });
  }
  update(id: string, revision: number, patch: unknown) {
    if (
      !object(patch) ||
      Object.keys(patch).some((key) => !['name', 'members'].includes(key)) ||
      !isGroupInput({ id, ...patch }) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      return Promise.reject(new Fault('INVALID_GROUP', 400));
    const value = structuredClone(patch) as { name: string; members: string[] };
    return this.exclusive(async () => {
      const current = this.group(id);
      if (current.archived) throw new Fault('GROUP_ARCHIVED');
      if (current.revision !== revision) throw new Fault('GROUP_CONFLICT');
      if (this.busy(id)) throw new Fault('GROUP_BUSY');
      for (const member of value.members)
        if (!(await this.runner.member(member))) throw new Fault('GROUP_MEMBER_REQUIRED');
      if (
        value.members.some(
          (member) => !current.members.includes(member) && this.runner.admit?.(member) === false,
        )
      )
        throw new Fault('BOT_UNAVAILABLE');
      if (
        current.name === value.name.trim() &&
        JSON.stringify(current.members) === JSON.stringify(value.members)
      )
        return current;
      const group = {
        ...current,
        ...value,
        name: value.name.trim(),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      return this.transaction(() => {
        this.db.prepare('UPDATE group_defs SET value=? WHERE id=?').run(JSON.stringify(group), id);
        this.changed();
        return group;
      });
    });
  }
  send(input: unknown) {
    if (!isGroupSend(input)) return Promise.reject(new Fault('INVALID_GROUP_MESSAGE', 400));
    const value = structuredClone(input);
    return this.exclusive(async () => {
      this.group(value.group);
      if (
        this.db
          .prepare('SELECT id FROM group_turns WHERE grp=? AND id=?')
          .get(value.group, value.id)
      )
        return this.commitSend(value);
      if (this.group(value.group).archived) throw new Fault('GROUP_ARCHIVED');
      this.preparing.set(
        value.group,
        new Set(
          (value.files || []).flatMap((file) => (file.attachmentId ? [file.attachmentId] : [])),
        ),
      );
      try {
        for (const file of value.files || [])
          if (file.attachmentId) {
            if (!this.uploads) throw new Fault('GROUP_ATTACHMENT_UNAVAILABLE', 503);
            await this.uploads.read(value.group, file.attachmentId);
          }
        return this.commitSend(value);
      } finally {
        this.preparing.delete(value.group);
      }
    });
  }
  private inputs(group: string, source: string): TaskFile[] {
    const row = this.db
      .prepare('SELECT inputs FROM group_turns WHERE grp=? AND id=?')
      .get(group, source);
    if (!row) throw new Fault('GROUP_MESSAGE_NOT_FOUND', 404);
    let files: unknown;
    try {
      files = JSON.parse(String(row.inputs));
    } catch {
      throw new Fault('GROUP_CORRUPT');
    }
    if (!Array.isArray(files) || files.length > 4 || !files.every(isTaskFile))
      throw new Fault('GROUP_CORRUPT');
    return files;
  }
  inputBusy(owner: string, id: string) {
    if (this.preparing.get(owner)?.has(id)) return true;
    if (!this.db || this.closed || this.failure) throw new Fault('GROUP_UNAVAILABLE', 503);
    return !!this.db
      .prepare(
        "SELECT t.id FROM group_turns t,json_each(t.inputs) f WHERE t.grp=? AND t.state IN ('pending','running') AND json_extract(f.value,'$.attachmentId')=? LIMIT 1",
      )
      .get(owner, id);
  }
  inputSource(group: string, source: string, name: string) {
    if (!validAgentId(source) || !isTaskFileName(name))
      return Promise.reject(new Fault('INVALID_GROUP_QUERY', 400));
    return this.exclusive(() => {
      this.group(group);
      const file = this.inputs(group, source).find((file) => file.name === name);
      if (!file) throw new Fault('GROUP_INPUT_NOT_FOUND', 404);
      return structuredClone(file);
    });
  }
  private commitSend(value: GroupSend) {
    return this.transaction(() => this.enqueue(value));
  }
  private enqueue(value: GroupSend, author?: { bot: string; name: string }) {
    const group = this.group(value.group),
      signature = JSON.stringify([
        value.prompt,
        value.recipients,
        value.files || [],
        ...(value.revision === undefined ? [] : [value.revision]),
        ...(author ? [{ author: author.bot }] : []),
      ]);
    const prior = this.db
      .prepare('SELECT * FROM group_turns WHERE grp=? AND id=?')
      .get(group.id, value.id);
    if (prior) {
      if (prior.signature !== signature) throw new Fault('GROUP_REQUEST_ID_REUSED');
      return author ? this.page(group.id) : this.accepted(group.id, value.id);
    }
    if (group.archived) throw new Fault('GROUP_ARCHIVED');
    // Restoring a group cannot revive an unaccepted request sent before its archive boundary.
    if (
      value.revision === undefined &&
      this.db.prepare('SELECT id FROM group_actions WHERE grp=? LIMIT 1').get(group.id)
    )
      throw new Fault('GROUP_REVISION_REQUIRED');
    if (value.revision !== undefined && value.revision !== group.revision)
      throw new Fault('GROUP_CONFLICT');
    if (value.recipients.some((bot) => !group.members.includes(bot)))
      throw new Fault('GROUP_MEMBER_REQUIRED');
    if (value.recipients.some((bot) => this.runner.admit?.(bot) === false))
      throw new Fault('BOT_UNAVAILABLE');
    if (
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS count FROM group_turns WHERE grp=? AND state IN ('pending','running')",
          )
          .get(group.id)!.count,
      ) >= 20
    )
      throw new Fault('GROUP_QUEUE_LIMIT');
    if (
      Number(
        this.db
          .prepare(
            `SELECT
                (SELECT coalesce(sum(length(CAST(text AS BLOB))),0) FROM group_messages WHERE grp=?) +
                (SELECT coalesce(sum(length(CAST(prompt || signature || inputs AS BLOB))),0) FROM group_turns WHERE grp=?) +
                (SELECT coalesce(sum(length(CAST(context AS BLOB))),0) FROM group_deliveries WHERE grp=?) AS size`,
          )
          .get(group.id, group.id, group.id)!.size,
      ) +
        Buffer.byteLength(JSON.stringify([value.prompt, signature, value.files || []])) >
      50 * 1024 * 1024
    )
      throw new Fault('GROUP_STORAGE_LIMIT');
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO group_messages(id,grp,source,role,text,created,author,name) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        value.id,
        group.id,
        value.id,
        author ? 'bot' : 'user',
        value.prompt,
        now,
        author?.bot ?? null,
        author?.name ?? null,
      );
    const seq = this.db.prepare('SELECT last_insert_rowid() AS seq').get()!.seq;
    this.db
      .prepare(
        "INSERT INTO group_turns(grp,id,prompt,recipients,signature,seq,created,state,inputs) VALUES(?,?,?,?,?,?,?,'pending',?)",
      )
      .run(
        group.id,
        value.id,
        value.prompt,
        JSON.stringify(value.recipients),
        signature,
        seq,
        now,
        JSON.stringify(value.files || []),
      );
    value.recipients.forEach((bot, position) => {
      this.db
        .prepare(
          "INSERT INTO group_deliveries(id,grp,source,bot,position,state) VALUES(?,?,?,?,?,'pending')",
        )
        .run(digest([group.id, value.id, position, bot]), group.id, value.id, bot, position);
    });
    this.changed();
    return author ? this.page(group.id) : this.accepted(group.id, value.id);
  }
  private appendResult(row: Row, receipt: GroupReceipt) {
    const text = receipt.result || receipt.response?.text || receipt.error || 'GROUP_RESULT_EMPTY';
    if (text.length > replyLimit) throw new Fault('GROUP_RESULT_INVALID');
    this.db
      .prepare(
        'INSERT OR IGNORE INTO group_messages(id,grp,source,role,text,created,author,name,phase,model,files,run) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `reply-${row.id}`,
        String(row.grp),
        String(row.source),
        receipt.result || receipt.response?.text ? 'bot' : 'notice',
        text,
        new Date().toISOString(),
        String(row.bot),
        String(row.name || row.bot),
        receipt.phase,
        receipt.model || null,
        receipt.files?.length
          ? JSON.stringify(
              receipt.files
                .slice(0, 20)
                .map(({ path, name, size, modified }) => ({ path, name, size, modified })),
            )
          : null,
        receipt.runId,
      );
  }
  private finishRound(group: string, source: string, state: string, error?: string) {
    this.db
      .prepare('UPDATE group_turns SET state=? WHERE grp=? AND id=?')
      .run(state, group, source);
    if (state !== 'completed')
      this.db
        .prepare(
          "UPDATE group_deliveries SET state='cancelled',error=? WHERE grp=? AND source=? AND state='pending'",
        )
        .run(error || null, group, source);
  }
  private reconcile(row: Row, recovering = false) {
    const receipt = this.runner.findRequest(String(row.bot), requestId(row));
    if (!receipt && !recovering && row.state === 'claimed') return;
    this.transaction(() => {
      if (
        !receipt ||
        receipt.conversationId !== row.grp ||
        (row.run && row.run !== receipt.runId)
      ) {
        this.db
          .prepare(
            "UPDATE group_deliveries SET state='interrupted',error='GROUP_OUTCOME_UNKNOWN' WHERE id=?",
          )
          .run(String(row.id));
        this.finishRound(
          String(row.grp),
          String(row.source),
          'interrupted',
          'GROUP_OUTCOME_UNKNOWN',
        );
        this.changed();
        return;
      }
      if (terminal.has(receipt.phase)) {
        const state =
          receipt.phase === 'completed'
            ? 'completed'
            : receipt.phase === 'failed'
              ? 'failed'
              : 'interrupted';
        this.db
          .prepare('UPDATE group_deliveries SET state=?,run=?,error=? WHERE id=?')
          .run(state, receipt.runId, receipt.error || null, String(row.id));
        this.appendResult(row, receipt);
        if (state !== 'completed')
          this.finishRound(String(row.grp), String(row.source), state, receipt.error);
        else if (
          !this.db
            .prepare(
              "SELECT id FROM group_deliveries WHERE grp=? AND source=? AND state IN ('pending','claimed','running') LIMIT 1",
            )
            .get(String(row.grp), String(row.source))
        )
          this.finishRound(String(row.grp), String(row.source), 'completed');
        this.changed();
      } else if (row.state !== 'running' || row.run !== receipt.runId) {
        this.db
          .prepare("UPDATE group_deliveries SET state='running',run=? WHERE id=?")
          .run(receipt.runId, String(row.id));
        this.changed();
      }
    });
  }
  private context(
    row: Row,
    group: Group,
    members: { id: string; name: string; role?: string; available: boolean }[],
  ): string {
    const turn = this.db
      .prepare('SELECT * FROM group_turns WHERE grp=? AND id=?')
      .get(group.id, String(row.source))!;
    // Include earlier turns even if their replies arrived later, but never a newer human request.
    const messages = this.db
      .prepare(
        'SELECT m.* FROM group_messages m JOIN group_turns t ON t.grp=m.grp AND t.id=m.source WHERE m.grp=? AND t.seq<=? ORDER BY m.seq DESC LIMIT 12',
      )
      .all(group.id, Number(turn.seq))
      .reverse()
      .map((value) => {
        const message = this.message(value),
          chars = Array.from(message.text);
        return {
          id: message.id,
          role: message.role,
          author: message.author,
          name: message.name,
          text: chars.slice(0, 400).join(''),
          truncated: chars.length > 400,
          phase: message.phase,
          files: message.files?.slice(0, 2).map((file) => file.path),
        };
      });
    return JSON.stringify({
      group: { id: group.id, name: group.name, members },
      recipient: String(row.bot),
      messages,
      untrusted: true,
    });
  }
  tick() {
    return this.exclusive(async () => {
      for (const row of this.db
        .prepare("SELECT * FROM group_deliveries WHERE state IN ('claimed','running')")
        .all())
        this.reconcile(row);
      for (const definition of this.db.prepare('SELECT * FROM group_defs ORDER BY id').all()) {
        if (
          Number(
            this.db
              .prepare(
                "SELECT count(*) AS count FROM group_deliveries WHERE state IN ('claimed','running')",
              )
              .get()!.count,
          ) >= 2
        )
          break;
        const group = this.definition(definition);
        if (group.archived) continue;
        const turn = this.db
          .prepare(
            "SELECT * FROM group_turns WHERE grp=? AND state IN ('pending','running') ORDER BY seq LIMIT 1",
          )
          .get(group.id);
        if (!turn) continue;
        const stages = this.db
          .prepare('SELECT * FROM group_deliveries WHERE grp=? AND source=? ORDER BY position')
          .all(group.id, String(turn.id));
        if (
          stages.some((stage) => activeStates.has(String(stage.state)) && stage.state !== 'pending')
        )
          continue;
        const row = stages.find((stage) => stage.state === 'pending');
        if (
          !row ||
          this.runner.running(String(row.bot)) ||
          this.runner.admit?.(String(row.bot)) === false
        )
          continue;
        const member = await this.runner.member(String(row.bot));
        if (!member) {
          this.transaction(() => {
            this.db
              .prepare(
                "UPDATE group_deliveries SET state='failed',error='GROUP_MEMBER_REQUIRED' WHERE id=?",
              )
              .run(String(row.id));
            this.finishRound(group.id, String(turn.id), 'failed', 'GROUP_MEMBER_REQUIRED');
            this.changed();
          });
          continue;
        }
        const directory = await Promise.all(
          group.members.map(async (id) => {
            const value = id === member.id ? member : await this.runner.member(id);
            return {
              id,
              name: value?.name || id,
              role: value?.instructions?.slice(0, 120),
              available: !!value && this.runner.admit?.(id) !== false,
            };
          }),
        );
        const context = row.context ? String(row.context) : this.context(row, group, directory);
        // Directory reads yield; recheck eligibility in the same turn that claims the delivery.
        if (this.runner.admit?.(String(row.bot)) === false) continue;
        this.transaction(() => {
          this.db
            .prepare(
              "UPDATE group_deliveries SET state='claimed',context=?,name=? WHERE id=? AND state='pending'",
            )
            .run(context, member.name, String(row.id));
          this.db
            .prepare("UPDATE group_turns SET state='running' WHERE grp=? AND id=?")
            .run(group.id, String(turn.id));
          this.changed();
        });
        row.context = context;
        row.name = member.name;
        row.state = 'claimed';
        try {
          await this.runner.start(
            String(row.bot),
            {
              requestId: requestId(row),
              prompt: String(turn.prompt),
              files: this.inputs(group.id, String(turn.id)),
            },
            { id: group.id, context },
          );
          this.reconcile(row, true);
        } catch (error) {
          if (this.runner.findRequest(String(row.bot), requestId(row))) this.reconcile(row, true);
          // Definite admission refusals issued no model effect, so retain the original queue identity.
          else if (
            ['MODEL_ALREADY_RUNNING', 'BOT_CHANGING', 'RUNTIME_RECOVERY_PENDING'].includes(
              errorCode(error) || '',
            )
          )
            this.transaction(() => {
              this.db
                .prepare("UPDATE group_deliveries SET state='pending' WHERE id=?")
                .run(String(row.id));
              this.changed();
            });
          else
            this.transaction(() => {
              this.db
                .prepare("UPDATE group_deliveries SET state='interrupted',error=? WHERE id=?")
                .run(errorCode(error) || 'GROUP_OUTCOME_UNKNOWN', String(row.id));
              this.finishRound(group.id, String(turn.id), 'interrupted', errorCode(error));
              this.changed();
            });
        }
      }
      this.failure = '';
    });
  }
  async cancel(group: string, sourceId: string) {
    if (!validAgentId(sourceId)) throw new Fault('INVALID_GROUP_MESSAGE', 400);
    const active = await this.exclusive(() =>
      this.transaction(() => {
        this.group(group);
        const rows = this.db
          .prepare('SELECT * FROM group_deliveries WHERE grp=? AND source=?')
          .all(group, sourceId);
        if (!rows.length) throw new Fault('GROUP_MESSAGE_NOT_FOUND', 404);
        const active = rows.filter((row) => row.state === 'claimed' || row.state === 'running');
        this.db
          .prepare(
            "UPDATE group_deliveries SET state='cancelled' WHERE grp=? AND source=? AND state IN ('pending','claimed','running')",
          )
          .run(group, sourceId);
        this.db
          .prepare(
            "UPDATE group_turns SET state='cancelled' WHERE grp=? AND id=? AND state IN ('pending','running')",
          )
          .run(group, sourceId);
        this.changed();
        return active;
      }),
    );
    // Stop outside the database owner: a model may itself be awaiting a queued group tool.
    await Promise.all(
      active.map((row) => this.runner.stopRequest(String(row.bot), requestId(row), group)),
    );
    return this.exclusive(() => {
      for (const row of active) {
        const receipt = this.runner.findRequest(String(row.bot), requestId(row));
        if (receipt?.conversationId === group && terminal.has(receipt.phase))
          this.transaction(() => {
            this.appendResult(row, receipt);
            this.changed();
          });
      }
      return { ...this.page(group), cancelledSource: sourceId };
    });
  }
  hasPendingBot(bot: string) {
    if (!validAgentId(bot)) return Promise.reject(new Fault('INVALID_GROUP_QUERY', 400));
    return this.exclusive(
      () =>
        !!this.db
          .prepare(
            "SELECT id FROM group_deliveries WHERE bot=? AND state IN ('pending','claimed','running') LIMIT 1",
          )
          .get(bot),
    );
  }
  private activeSource(source: GroupSource) {
    source.signal?.throwIfAborted();
    const group = this.group(source.group);
    if (group.archived) throw new Fault('GROUP_ARCHIVED');
    if (!group.members.includes(source.bot)) throw new Fault('GROUP_SOURCE_CLOSED');
    const row = this.db
      .prepare(
        "SELECT * FROM group_deliveries WHERE grp=? AND bot=? AND state IN ('claimed','running') ORDER BY position LIMIT 1",
      )
      .get(group.id, source.bot);
    const receipt = row ? this.runner.findRequest(source.bot, requestId(row)) : undefined;
    if (
      !row ||
      !receipt ||
      receipt.runId !== source.runId ||
      receipt.conversationId !== group.id ||
      !this.runner.running(source.bot) ||
      terminal.has(receipt.phase)
    )
      throw new Fault('GROUP_SOURCE_CLOSED');
    return { group, row };
  }
  history(source: GroupSource, args: Record<string, unknown>) {
    const number = (value: unknown, fallback: number, min: number, max: number) => {
      if (value === undefined) return fallback;
      if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
        throw new Fault('INVALID_GROUP_QUERY', 400);
      return Number(value);
    };
    return this.exclusive(() => {
      const { group, row } = this.activeSource(source);
      if (
        Object.keys(args).some((key) => !['messageId', 'offset', 'limit', 'before'].includes(key))
      )
        throw new Fault('INVALID_GROUP_QUERY', 400);
      const turn = this.db
        .prepare('SELECT * FROM group_turns WHERE grp=? AND id=?')
        .get(group.id, String(row.source))!;
      if (args.messageId !== undefined) {
        if (!validAgentId(args.messageId) || args.before !== undefined)
          throw new Fault('INVALID_GROUP_QUERY', 400);
        const target = this.db
          .prepare(
            'SELECT m.* FROM group_messages m JOIN group_turns t ON t.grp=m.grp AND t.id=m.source WHERE m.grp=? AND m.id=? AND t.seq<=?',
          )
          .get(group.id, args.messageId, Number(turn.seq));
        if (!target) throw new Fault('GROUP_MESSAGE_NOT_FOUND', 404);
        const message = this.message(target),
          chars = Array.from(message.text),
          offset = number(args.offset, 0, 0, 1000000),
          limit = number(args.limit, 1000, 1, 2000);
        if (offset > chars.length) throw new Fault('INVALID_GROUP_QUERY', 400);
        return {
          untrusted: true,
          id: message.id,
          role: message.role,
          author: message.author,
          name: message.name,
          phase: message.phase,
          content: chars.slice(offset, offset + limit).join(''),
          offset,
          total: chars.length,
          files: message.files,
          ...(offset + limit < chars.length ? { nextOffset: offset + limit } : {}),
        };
      }
      if (args.offset !== undefined) throw new Fault('INVALID_GROUP_QUERY', 400);
      const limit = number(args.limit, 10, 1, 20),
        before = number(args.before, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
      const messages = this.db
        .prepare(
          'SELECT m.* FROM group_messages m JOIN group_turns t ON t.grp=m.grp AND t.id=m.source WHERE m.grp=? AND t.seq<=? AND m.seq<? ORDER BY m.seq DESC LIMIT ?',
        )
        .all(group.id, Number(turn.seq), before, limit + 1);
      const entries = messages.slice(0, limit).map((value) => {
        const message = this.message(value),
          chars = Array.from(message.text);
        return {
          id: message.id,
          sequence: message.sequence,
          role: message.role,
          author: message.author,
          name: message.name,
          phase: message.phase,
          preview: chars.slice(0, 240).join(''),
          truncated: chars.length > 240,
        };
      });
      return {
        untrusted: true,
        messages: entries,
        ...(messages.length > limit ? { nextBefore: entries.at(-1)!.sequence } : {}),
      };
    });
  }
  handoff(source: GroupSource, input: unknown) {
    if (
      !object(input) ||
      Object.keys(input).some((key) => !['bot', 'message'].includes(key)) ||
      !validAgentId(input.bot) ||
      typeof input.message !== 'string' ||
      !input.message.trim() ||
      input.message.length > 12000 ||
      input.message.includes('\0')
    )
      return Promise.reject(new Fault('INVALID_GROUP_HANDOFF', 400));
    const value = { bot: input.bot, message: input.message };
    return this.exclusive(() =>
      this.transaction(() => {
        const { group, row } = this.activeSource(source);
        if (
          !group.members.includes(source.bot) ||
          !group.members.includes(value.bot) ||
          value.bot === source.bot
        )
          throw new Fault('GROUP_MEMBER_REQUIRED');
        const signature = JSON.stringify(value),
          previous = this.db
            .prepare('SELECT * FROM group_handoffs WHERE source=?')
            .get(String(row.id));
        if (previous) {
          if (previous.signature !== signature) throw new Fault('GROUP_HANDOFF_CONFLICT');
          return {
            group: group.id,
            sourceId: String(row.source),
            bot: value.bot,
            deliveryId: String(previous.target),
          };
        }
        if (this.runner.admit?.(value.bot) === false) throw new Fault('BOT_UNAVAILABLE');
        const stages = this.db
          .prepare('SELECT * FROM group_deliveries WHERE grp=? AND source=? ORDER BY position')
          .all(group.id, String(row.source));
        let target = stages.find((stage) => stage.bot === value.bot && stage.state === 'pending');
        if (!target) {
          if (stages.length >= 8) throw new Fault('GROUP_HANDOFF_LIMIT');
          const position = Number(stages.at(-1)!.position) + 1;
          const id = digest([group.id, row.source, position, value.bot]);
          this.db
            .prepare(
              "INSERT INTO group_deliveries(id,grp,source,bot,position,state) VALUES(?,?,?,?,?,'pending')",
            )
            .run(id, group.id, String(row.source), value.bot, position);
          target = { id };
        }
        this.db
          .prepare('INSERT INTO group_handoffs(source,signature,target) VALUES(?,?,?)')
          .run(String(row.id), signature, String(target.id));
        this.db
          .prepare(
            "INSERT INTO group_messages(id,grp,source,role,text,created,author,name,run) VALUES(?,?,?,'bot',?,?,?,?,?)",
          )
          .run(
            `handoff-${row.id}`,
            group.id,
            String(row.source),
            `转交给 ${value.bot}：${value.message}`,
            new Date().toISOString(),
            source.bot,
            String(row.name || source.bot),
            source.runId,
          );
        this.changed();
        return {
          group: group.id,
          sourceId: String(row.source),
          bot: value.bot,
          deliveryId: String(target.id),
        };
      }),
    );
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.failure = errorCode(error) || 'GROUP_UNAVAILABLE';
      });
    }, 1000);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    await this.chain.catch(() => {});
    await this.ready.catch(() => {});
    if (this.closed) return;
    this.closed = true;
    this.db?.close();
  }
  async drain() {
    await this.chain.catch(() => {});
  }
}
