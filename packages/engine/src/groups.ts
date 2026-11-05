import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProjectScope } from '@daban/protocol';
import {
  type AutomationSource,
  type BudgetScope,
  type GoalResumeTarget,
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
  goalResumeKey,
  groupCopyKey,
  isAutomationSource,
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
import { and, asc, count, desc, eq, inArray, lt, lte, type SQL, sql } from 'drizzle-orm';
import type { Attachments } from './attachments.js';
import { errorCode, Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';
import { migrations } from './groups-migrations.js';
import {
  groupActions,
  groupBudgetResumes,
  groupCollaborations,
  groupDefs,
  groupDeliveries,
  groupHandoffs,
  groupMessages,
  groupMeta,
  groupTurns,
} from './groups-schema.js';
import type { ConversationScope, RunReceipt } from './tasks.js';

export type GroupReceipt = RunReceipt;
export interface GroupRunner {
  budgetResumeIssue?(bot: string, runId: string, goal?: GoalResumeTarget): string | undefined;
  budget?(group: string, sourceId: string): BudgetScope;
  member(bot: string): Promise<{ id: string; name: string; instructions?: string } | undefined>;
  directory?(): Promise<{ id: string; name: string; instructions?: string }[]>;
  source?(
    bot: string,
    runId: string,
    conversationId?: string,
  ):
    | {
        intentId: string;
        budget?: BudgetScope;
        project?: ProjectScope;
        automation?: AutomationSource;
      }
    | undefined;
  running(bot: string): boolean;
  groupRunning?(group: string): boolean;
  admit?(bot: string): boolean;
  findRequest(bot: string, requestId: string): GroupReceipt | undefined;
  start(
    bot: string,
    task: TaskRequest,
    scope: ConversationScope,
    automation?: AutomationSource,
  ): Promise<unknown>;
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
type Delivery = typeof groupDeliveries.$inferSelect;
type Message = typeof groupMessages.$inferSelect;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);
const activeStates = new Set(['pending', 'claimed', 'running']);
const terminal = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const requestId = (delivery: { id: string }) => `group-${delivery.id}`;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const live = [...activeStates];
const claimed = ['claimed', 'running'];
const waiting = ['pending', 'running'];

function legacy(client: DatabaseSync) {
  client.exec(`CREATE TABLE IF NOT EXISTS group_defs(id TEXT PRIMARY KEY,value TEXT NOT NULL,copy_origin TEXT);
    CREATE TABLE IF NOT EXISTS group_actions(id TEXT PRIMARY KEY,grp TEXT NOT NULL,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS group_actions_owner ON group_actions(grp);
    CREATE TABLE IF NOT EXISTS group_turns(grp TEXT NOT NULL,id TEXT NOT NULL,prompt TEXT NOT NULL,recipients TEXT NOT NULL,signature TEXT NOT NULL,seq INTEGER,created TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(grp,id));
    CREATE TABLE IF NOT EXISTS group_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,grp TEXT NOT NULL,source TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,created TEXT NOT NULL,author TEXT,name TEXT,phase TEXT,model TEXT,files TEXT,UNIQUE(grp,id));
    CREATE INDEX IF NOT EXISTS group_messages_page ON group_messages(grp,seq);
    CREATE TABLE IF NOT EXISTS group_deliveries(id TEXT PRIMARY KEY,grp TEXT NOT NULL,source TEXT NOT NULL,bot TEXT NOT NULL,position INTEGER NOT NULL,state TEXT NOT NULL,run TEXT,context TEXT,name TEXT,error TEXT);
    CREATE INDEX IF NOT EXISTS group_deliveries_queue ON group_deliveries(grp,source,position);
    CREATE TABLE IF NOT EXISTS group_handoffs(source TEXT PRIMARY KEY,signature TEXT NOT NULL,target TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_collaborations(source TEXT PRIMARY KEY,grp TEXT NOT NULL,turn TEXT NOT NULL,signature TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);`);
  const columns = (table: string) =>
    client
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
  if (!columns('group_defs').includes('copy_origin'))
    client.exec('ALTER TABLE group_defs ADD COLUMN copy_origin TEXT');
  if (!columns('group_turns').includes('inputs'))
    client.exec("ALTER TABLE group_turns ADD COLUMN inputs TEXT NOT NULL DEFAULT '[]'");
  if (!columns('group_messages').includes('run'))
    client.exec('ALTER TABLE group_messages ADD COLUMN run TEXT');
}

export class Groups {
  // shortcut: one local service owns this database; acquire a process lease before supporting multiple dispatchers.
  readonly ready: Promise<unknown>;
  private db!: Database;
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
    const client = new DatabaseSync(this.file);
    try {
      configure(client, { journal: 'WAL', foreignKeys: true });
      this.db = migrate(client, migrations, legacy);
      this.db.insert(groupMeta).values({ id: 1, revision: 0 }).onConflictDoNothing().run();
    } catch (error) {
      client.close();
      throw error;
    }
    for (const row of this.db.select().from(groupDefs).all()) this.definition(row);
    for (const row of this.db
      .select()
      .from(groupDeliveries)
      .where(inArray(groupDeliveries.state, claimed))
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
  private changed() {
    this.db
      .update(groupMeta)
      .set({ revision: sql`${groupMeta.revision} + 1` })
      .where(eq(groupMeta.id, 1))
      .run();
  }
  private revision() {
    return Number(
      this.db
        .select({ revision: groupMeta.revision })
        .from(groupMeta)
        .where(eq(groupMeta.id, 1))
        .get()!.revision,
    );
  }
  private accepted(group: string, source: string): GroupPage {
    const row = this.db
      .select()
      .from(groupMessages)
      .where(
        and(
          eq(groupMessages.grp, group),
          eq(groupMessages.id, source),
          eq(groupMessages.role, 'user'),
        ),
      )
      .get();
    if (!row) throw new Fault('GROUP_CORRUPT');
    return { ...this.page(group), accepted: this.message(row) };
  }
  private definition(row: { id: string; value: string }): Group {
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
    const row = this.db.select().from(groupDefs).where(eq(groupDefs.id, id)).get();
    if (!row) throw new Fault('GROUP_NOT_FOUND', 404);
    return this.definition(row);
  }
  private actionRecord(id: string): GroupActionReceipt | undefined {
    const row = this.db.select().from(groupActions).where(eq(groupActions.id, id)).get();
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
        .select({ id: groupDeliveries.id })
        .from(groupDeliveries)
        .where(and(eq(groupDeliveries.grp, id), inArray(groupDeliveries.state, live)))
        .limit(1)
        .get() || this.runner.groupRunning?.(id) === true
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
      this.db.transaction(
        () => {
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
          if (Number(this.db.select({ count: count() }).from(groupActions).get()!.count) >= 10000)
            throw new Fault('GROUP_ACTION_LIMIT');
          const now = new Date().toISOString(),
            group: Group = { ...current, revision: current.revision + 1, updatedAt: now };
          if (request.action === 'archive') group.archived = true;
          else delete group.archived;
          const receipt: GroupActionReceipt = {
            request,
            revision: group.revision,
            completedAt: now,
          };
          // The receipt and state move together; a replay only returns current state, never reapplies intent.
          this.db
            .update(groupDefs)
            .set({ value: JSON.stringify(group) })
            .where(eq(groupDefs.id, group.id))
            .run();
          this.db
            .insert(groupActions)
            .values({ id: request.id, grp: group.id, value: JSON.stringify(receipt) })
            .run();
          this.changed();
          return { receipt, group };
        },
        { behavior: 'immediate' },
      ),
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
  private delivery(row: Delivery): GroupDelivery {
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
  private message(row: Message): GroupMessage {
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
      .select()
      .from(groupMessages)
      .where(
        and(eq(groupMessages.grp, id), lt(groupMessages.seq, before || Number.MAX_SAFE_INTEGER)),
      )
      .orderBy(desc(groupMessages.seq))
      .limit(limit + 1)
      .all();
    const messages = rows
      .slice(0, limit)
      .reverse()
      .map((row) => this.message(row));
    return {
      group,
      revision: this.revision(),
      messages,
      deliveries: this.db
        .select()
        .from(groupDeliveries)
        .where(eq(groupDeliveries.grp, id))
        // rowid is the implicit insertion order; it is not a declared column.
        .orderBy(desc(sql`rowid`))
        .limit(160)
        .all()
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
          .select()
          .from(groupDefs)
          .orderBy(asc(groupDefs.id))
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
        .select({
          grp: groupTurns.grp,
          id: groupTurns.id,
          state: groupTurns.state,
          automation: groupTurns.automation,
        })
        .from(groupTurns)
        .where(inArray(groupTurns.state, ['completed', 'failed', 'interrupted']))
        // rowid is the implicit insertion order; it is not a declared column.
        .orderBy(desc(sql`rowid`))
        .limit(1000)
        .all()
        .reverse()
        .filter(
          (row) =>
            row.state !== 'completed' ||
            this.automationSource(row.automation)?.policy.kind !== 'changes',
        )
        .map((row) => ({
          kind: 'group',
          id: String(row.id),
          group: String(row.grp),
          phase: row.state as 'completed' | 'failed' | 'interrupted',
        })),
    );
  }
  private automationSource(value: string | null) {
    if (value === null) return undefined;
    const source: unknown = JSON.parse(value);
    if (!isAutomationSource(source)) throw new Fault('GROUP_CORRUPT');
    return source;
  }
  private async creationMembers(id: string, members: string[]) {
    if (await this.runner.member(id)) throw new Fault('GROUP_ID_CONFLICT');
    for (const member of members)
      if (!(await this.runner.member(member))) throw new Fault('GROUP_MEMBER_REQUIRED');
  }
  private projectMembers(project: ProjectScope | undefined, _members: string[]) {
    if (project) throw new Fault('PROJECT_RETIRED', 409);
  }
  private admitCreation(members: string[]) {
    // Directory awaits must finish first; commit in this same turn before lifecycle permission can change.
    if (members.some((member) => this.runner.admit?.(member) === false))
      throw new Fault('BOT_UNAVAILABLE');
    if (Number(this.db.select({ count: count() }).from(groupDefs).get()!.count) >= 50)
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
      const origin = this.runner.source?.(source.bot, source.runId);
      const project = origin?.project;
      const automation = origin?.automation ? structuredClone(origin.automation) : undefined;
      const signature = JSON.stringify(value);
      const prior = this.db
        .select()
        .from(groupCollaborations)
        .where(eq(groupCollaborations.source, identity))
        .get();
      if (prior) {
        if (prior.signature !== signature) throw new Fault('GROUP_COLLABORATION_CONFLICT');
        return { group: this.group(String(prior.grp)), sourceId: String(prior.turn), reused: true };
      }
      const id = `group-${identity}`,
        sourceId = `task-${identity}`;
      if (this.db.select({ id: groupDefs.id }).from(groupDefs).where(eq(groupDefs.id, id)).get())
        throw new Fault('GROUP_ID_CONFLICT');
      const members = [source.bot, ...value.members];
      await this.creationMembers(id, members);
      const author = await this.runner.member(source.bot);
      // Directory reads yield; task identity and lifecycle eligibility must still match at commit.
      if (this.collaborationSource(source) !== identity || !author)
        throw new Fault('GROUP_SOURCE_CLOSED');
      this.admitCreation(members);
      this.projectMembers(project, members);
      const now = new Date().toISOString();
      const group: Group = {
        id,
        ...(project ? { project } : {}),
        name: value.name,
        members,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return this.db.transaction(
        () => {
          this.db
            .insert(groupDefs)
            .values({ id, value: JSON.stringify(group) })
            .run();
          this.enqueue(
            {
              id: sourceId,
              group: id,
              // Bot authorship is metadata; a prompt prefix would overflow valid summaries at the task limit.
              prompt: value.message,
              recipients: [...value.members, source.bot],
            },
            {
              bot: source.bot,
              name: author.name,
              budget: this.runner.source?.(source.bot, source.runId)?.budget,
            },
            automation,
          );
          // The group, initial dispatch and durable origin are one effect, including after a crash or retry.
          this.db
            .insert(groupCollaborations)
            .values({ source: identity, grp: id, turn: sourceId, signature })
            .run();
          return { group, sourceId, reused: false };
        },
        { behavior: 'immediate' },
      );
    });
  }
  private copied(request: GroupCopyRequest): GroupCopyAck | undefined {
    const row = this.db.select().from(groupDefs).where(eq(groupDefs.id, request.id)).get();
    if (!row) return undefined;
    const origin = createHash('sha256').update(groupCopyKey(request)).digest('hex');
    if (row.copyOrigin !== origin) throw new Fault('GROUP_COPY_CONFLICT');
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
      this.projectMembers(source.project, source.members);
      const now = new Date().toISOString();
      const group: Group = {
        id: request.id,
        name: request.name.trim(),
        members: [...source.members],
        ...(source.project ? { project: source.project } : {}),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return this.db.transaction(
        () => {
          this.db
            .insert(groupDefs)
            .values({
              id: group.id,
              value: JSON.stringify(group),
              copyOrigin: createHash('sha256').update(groupCopyKey(request)).digest('hex'),
            })
            .run();
          this.changed();
          return { request, state: 'complete', group };
        },
        { behavior: 'immediate' },
      );
    });
  }
  register(input: unknown) {
    if (!isGroupInput(input)) return Promise.reject(new Fault('INVALID_GROUP', 400));
    const value = structuredClone(input);
    return this.exclusive(async () => {
      const prior = this.db.select().from(groupDefs).where(eq(groupDefs.id, value.id)).get();
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
      return this.db.transaction(
        () => {
          this.db
            .insert(groupDefs)
            .values({ id: group.id, value: JSON.stringify(group) })
            .run();
          this.changed();
          return group;
        },
        { behavior: 'immediate' },
      );
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
      this.projectMembers(current.project, value.members);
      const group = {
        ...current,
        ...value,
        name: value.name.trim(),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      return this.db.transaction(
        () => {
          this.db
            .update(groupDefs)
            .set({ value: JSON.stringify(group) })
            .where(eq(groupDefs.id, id))
            .run();
          this.changed();
          return group;
        },
        { behavior: 'immediate' },
      );
    });
  }
  send(input: unknown) {
    if (!isGroupSend(input)) return Promise.reject(new Fault('INVALID_GROUP_MESSAGE', 400));
    const value = structuredClone(input);
    return this.exclusive(async () => {
      this.group(value.group);
      if (
        this.db
          .select({ id: groupTurns.id })
          .from(groupTurns)
          .where(and(eq(groupTurns.grp, value.group), eq(groupTurns.id, value.id)))
          .get()
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
      .select({ inputs: groupTurns.inputs })
      .from(groupTurns)
      .where(and(eq(groupTurns.grp, group), eq(groupTurns.id, source)))
      .get();
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
      .select({ id: groupTurns.id })
      .from(groupTurns)
      .where(
        and(
          eq(groupTurns.grp, owner),
          inArray(groupTurns.state, waiting),
          // json_each over the stored inputs array has no query-builder form.
          sql`EXISTS (SELECT 1 FROM json_each(${groupTurns.inputs}) f WHERE json_extract(f.value,'$.attachmentId')=${id})`,
        ),
      )
      .limit(1)
      .get();
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
    return this.db.transaction(() => this.enqueue(value), { behavior: 'immediate' });
  }
  private enqueue(
    value: GroupSend,
    author?: { bot: string; name: string; budget?: BudgetScope },
    automation?: AutomationSource,
  ) {
    const group = this.group(value.group),
      signature = JSON.stringify([
        value.prompt,
        value.recipients,
        value.files || [],
        ...(value.revision === undefined ? [] : [value.revision]),
        ...(author ? [{ author: author.bot }] : []),
        ...(automation ? [{ automation }] : []),
      ]);
    const prior = this.db
      .select()
      .from(groupTurns)
      .where(and(eq(groupTurns.grp, group.id), eq(groupTurns.id, value.id)))
      .get();
    if (prior) {
      if (prior.signature !== signature) throw new Fault('GROUP_REQUEST_ID_REUSED');
      return author ? this.page(group.id) : this.accepted(group.id, value.id);
    }
    if (group.archived) throw new Fault('GROUP_ARCHIVED');
    // Restoring a group cannot revive an unaccepted request sent before its archive boundary.
    if (
      value.revision === undefined &&
      this.db
        .select({ id: groupActions.id })
        .from(groupActions)
        .where(eq(groupActions.grp, group.id))
        .limit(1)
        .get()
    )
      throw new Fault('GROUP_REVISION_REQUIRED');
    if (value.revision !== undefined && value.revision !== group.revision)
      throw new Fault('GROUP_CONFLICT');
    this.projectMembers(group.project, [...value.recipients, ...(author ? [author.bot] : [])]);
    if (value.recipients.some((bot) => !group.members.includes(bot)))
      throw new Fault('GROUP_MEMBER_REQUIRED');
    if (value.recipients.some((bot) => this.runner.admit?.(bot) === false))
      throw new Fault('BOT_UNAVAILABLE');
    if (
      Number(
        this.db
          .select({ count: count() })
          .from(groupTurns)
          .where(and(eq(groupTurns.grp, group.id), inArray(groupTurns.state, waiting)))
          .get()!.count,
      ) >= 20
    )
      throw new Fault('GROUP_QUEUE_LIMIT');
    if (
      this.stored(group.id) +
        Buffer.byteLength(JSON.stringify([value.prompt, signature, value.files || []])) >
      50 * 1024 * 1024
    )
      throw new Fault('GROUP_STORAGE_LIMIT');
    const now = new Date().toISOString();
    const { seq } = this.db
      .insert(groupMessages)
      .values({
        id: value.id,
        grp: group.id,
        source: value.id,
        role: author ? 'bot' : 'user',
        text: value.prompt,
        created: now,
        author: author?.bot ?? null,
        name: author?.name ?? null,
      })
      .returning({ seq: groupMessages.seq })
      .get();
    this.db
      .insert(groupTurns)
      .values({
        grp: group.id,
        id: value.id,
        budget: author?.budget ?? this.runner.budget?.(group.id, value.id),
        prompt: value.prompt,
        recipients: JSON.stringify(value.recipients),
        signature,
        seq,
        created: now,
        state: 'pending',
        inputs: JSON.stringify(value.files || []),
        // This belongs to the accepted turn, so a later independent human message never inherits its authority.
        automation: automation ? JSON.stringify(automation) : null,
      })
      .run();
    value.recipients.forEach((bot, position) => {
      this.db
        .insert(groupDeliveries)
        .values({
          id: digest([group.id, value.id, position, bot]),
          grp: group.id,
          source: value.id,
          bot,
          position,
          state: 'pending',
        })
        .run();
    });
    this.changed();
    return author ? this.page(group.id) : this.accepted(group.id, value.id);
  }
  private stored(group: string) {
    // CAST AS BLOB measures stored UTF-8 bytes; the builder has no byte-length operator.
    const bytes = (value: SQL) => sql<number>`coalesce(sum(length(CAST(${value} AS BLOB))),0)`;
    const messages = this.db
      .select({ size: bytes(sql`${groupMessages.text}`) })
      .from(groupMessages)
      .where(eq(groupMessages.grp, group))
      .get()!.size;
    const turns = this.db
      .select({
        size: bytes(sql`${groupTurns.prompt} || ${groupTurns.signature} || ${groupTurns.inputs}`),
      })
      .from(groupTurns)
      .where(eq(groupTurns.grp, group))
      .get()!.size;
    const deliveries = this.db
      .select({ size: bytes(sql`${groupDeliveries.context}`) })
      .from(groupDeliveries)
      .where(eq(groupDeliveries.grp, group))
      .get()!.size;
    return Number(messages) + Number(turns) + Number(deliveries);
  }
  private appendResult(row: Delivery, receipt: GroupReceipt) {
    const text = receipt.result || receipt.response?.text || receipt.error || 'GROUP_RESULT_EMPTY';
    if (text.length > replyLimit) throw new Fault('GROUP_RESULT_INVALID');
    this.db
      .insert(groupMessages)
      .values({
        id: `reply-${row.id}`,
        grp: String(row.grp),
        source: String(row.source),
        role: receipt.result || receipt.response?.text ? 'bot' : 'notice',
        text,
        created: new Date().toISOString(),
        author: String(row.bot),
        name: String(row.name || row.bot),
        phase: receipt.phase,
        model: receipt.model || null,
        files: receipt.files?.length
          ? JSON.stringify(
              receipt.files
                .slice(0, 20)
                .map(({ path, name, size, modified }) => ({ path, name, size, modified })),
            )
          : null,
        run: receipt.runId,
      })
      .onConflictDoNothing()
      .run();
  }
  private finishRound(group: string, source: string, state: string, error?: string) {
    this.db
      .update(groupTurns)
      .set({ state })
      .where(and(eq(groupTurns.grp, group), eq(groupTurns.id, source)))
      .run();
    if (state !== 'completed')
      this.db
        .update(groupDeliveries)
        .set({ state: 'cancelled', error: error || null })
        .where(
          and(
            eq(groupDeliveries.grp, group),
            eq(groupDeliveries.source, source),
            eq(groupDeliveries.state, 'pending'),
          ),
        )
        .run();
  }
  private reconcile(row: Delivery, recovering = false) {
    const receipt = this.runner.findRequest(String(row.bot), requestId(row));
    if (!receipt && !recovering && row.state === 'claimed') return;
    this.db.transaction(
      () => {
        if (
          !receipt ||
          receipt.conversationId !== row.grp ||
          (row.run && row.run !== receipt.runId)
        ) {
          this.db
            .update(groupDeliveries)
            .set({ state: 'interrupted', error: 'GROUP_OUTCOME_UNKNOWN' })
            .where(eq(groupDeliveries.id, String(row.id)))
            .run();
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
            .update(groupDeliveries)
            .set({ state, run: receipt.runId, error: receipt.error || null })
            .where(eq(groupDeliveries.id, String(row.id)))
            .run();
          this.appendResult(row, receipt);
          if (state !== 'completed')
            this.finishRound(String(row.grp), String(row.source), state, receipt.error);
          else if (
            !this.db
              .select({ id: groupDeliveries.id })
              .from(groupDeliveries)
              .where(
                and(
                  eq(groupDeliveries.grp, String(row.grp)),
                  eq(groupDeliveries.source, String(row.source)),
                  inArray(groupDeliveries.state, live),
                ),
              )
              .limit(1)
              .get()
          )
            this.finishRound(String(row.grp), String(row.source), 'completed');
          this.changed();
        } else if (row.state !== 'running' || row.run !== receipt.runId) {
          this.db
            .update(groupDeliveries)
            .set({ state: 'running', run: receipt.runId })
            .where(eq(groupDeliveries.id, String(row.id)))
            .run();
          this.changed();
        }
      },
      { behavior: 'immediate' },
    );
  }
  private context(
    row: Delivery,
    group: Group,
    members: { id: string; name: string; role?: string; available: boolean }[],
  ): string {
    const turn = this.turn(group.id, String(row.source));
    // Include earlier turns even if their replies arrived later, but never a newer human request.
    const messages = this.earlier(group.id, Number(turn.seq))
      .orderBy(desc(groupMessages.seq))
      .limit(12)
      .all()
      .reverse()
      .map((value) => {
        const message = this.message(value.message),
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
  private turn(group: string, id: string) {
    return this.db
      .select()
      .from(groupTurns)
      .where(and(eq(groupTurns.grp, group), eq(groupTurns.id, id)))
      .get()!;
  }
  private earlier(group: string, seq: number, ...conditions: SQL[]) {
    return this.db
      .select({ message: groupMessages })
      .from(groupMessages)
      .innerJoin(
        groupTurns,
        and(eq(groupTurns.grp, groupMessages.grp), eq(groupTurns.id, groupMessages.source)),
      )
      .where(and(eq(groupMessages.grp, group), lte(groupTurns.seq, seq), ...conditions))
      .$dynamic();
  }
  private stages(group: string, source: string) {
    return this.db
      .select()
      .from(groupDeliveries)
      .where(and(eq(groupDeliveries.grp, group), eq(groupDeliveries.source, source)))
      .orderBy(asc(groupDeliveries.position))
      .all();
  }
  tick() {
    return this.exclusive(async () => {
      for (const row of this.db
        .select()
        .from(groupDeliveries)
        .where(inArray(groupDeliveries.state, claimed))
        .all())
        this.reconcile(row);
      for (const definition of this.db.select().from(groupDefs).orderBy(asc(groupDefs.id)).all()) {
        if (
          Number(
            this.db
              .select({ count: count() })
              .from(groupDeliveries)
              .where(inArray(groupDeliveries.state, claimed))
              .get()!.count,
          ) >= 2
        )
          break;
        const group = this.definition(definition);
        if (group.archived) continue;
        const turn = this.db
          .select()
          .from(groupTurns)
          .where(and(eq(groupTurns.grp, group.id), inArray(groupTurns.state, waiting)))
          .orderBy(asc(groupTurns.seq))
          .limit(1)
          .get();
        if (!turn) continue;
        const stages = this.stages(group.id, String(turn.id));
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
          this.db.transaction(
            () => {
              this.db
                .update(groupDeliveries)
                .set({ state: 'failed', error: 'GROUP_MEMBER_REQUIRED' })
                .where(eq(groupDeliveries.id, String(row.id)))
                .run();
              this.finishRound(group.id, String(turn.id), 'failed', 'GROUP_MEMBER_REQUIRED');
              this.changed();
            },
            { behavior: 'immediate' },
          );
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
        this.projectMembers(group.project, [String(row.bot)]);
        const context = row.context ? String(row.context) : this.context(row, group, directory);
        // Directory reads yield; recheck eligibility in the same turn that claims the delivery.
        if (this.runner.admit?.(String(row.bot)) === false) continue;
        this.db.transaction(
          () => {
            this.db
              .update(groupDeliveries)
              .set({ state: 'claimed', context, name: member.name })
              .where(
                and(eq(groupDeliveries.id, String(row.id)), eq(groupDeliveries.state, 'pending')),
              )
              .run();
            this.db
              .update(groupTurns)
              .set({ state: 'running' })
              .where(and(eq(groupTurns.grp, group.id), eq(groupTurns.id, String(turn.id))))
              .run();
            this.changed();
          },
          { behavior: 'immediate' },
        );
        row.context = context;
        row.name = member.name;
        row.state = 'claimed';
        try {
          await this.runner.start(
            String(row.bot),
            {
              requestId: requestId(row),
              ...(group.project ? { project: group.project } : {}),
              prompt: row.goalResume ? '/goal resume' : String(turn.prompt),
              ...(row.goalResume ? { goalResume: row.goalResume } : {}),
              ...(row.retryOf
                ? { retryOf: row.retryOf }
                : { files: this.inputs(group.id, String(turn.id)) }),
            },
            {
              id: group.id,
              context,
              sourceId: String(turn.id),
              ...(turn.budget ? { budget: turn.budget } : {}),
            },
            this.automationSource(turn.automation),
          );
          this.reconcile(row, true);
        } catch (error) {
          if (this.runner.findRequest(String(row.bot), requestId(row))) this.reconcile(row, true);
          // Definite admission refusals issued no model effect, so retain the original queue identity.
          else if (
            [
              'MODEL_ALREADY_RUNNING',
              'BOT_CHANGING',
              'RUNTIME_RECOVERY_PENDING',
              'BUDGET_LIMIT_REACHED',
              'BUDGET_REVISION_CONFLICT',
            ].includes(errorCode(error) || '')
          )
            this.db.transaction(
              () => {
                this.db
                  .update(groupDeliveries)
                  .set({ state: 'pending' })
                  .where(eq(groupDeliveries.id, String(row.id)))
                  .run();
                this.changed();
              },
              { behavior: 'immediate' },
            );
          else
            this.db.transaction(
              () => {
                this.db
                  .update(groupDeliveries)
                  .set({ state: 'interrupted', error: errorCode(error) || 'GROUP_OUTCOME_UNKNOWN' })
                  .where(eq(groupDeliveries.id, String(row.id)))
                  .run();
                this.finishRound(group.id, String(turn.id), 'interrupted', errorCode(error));
                this.changed();
              },
              { behavior: 'immediate' },
            );
        }
      }
      this.failure = '';
    });
  }
  private resumeRecord(scope: BudgetScope, id: string, goal?: GoalResumeTarget) {
    const prior = this.db
      .select()
      .from(groupBudgetResumes)
      .where(eq(groupBudgetResumes.id, id))
      .get();
    if (
      prior &&
      prior.signature !== JSON.stringify([scope.budgetId, scope.revision, goalResumeKey(goal)])
    )
      throw new Fault('BUDGET_CONTINUE_CONFLICT', 409);
    return prior !== undefined;
  }
  budgetResume(scope: BudgetScope, id: string, goal?: GoalResumeTarget) {
    return this.exclusive(() => this.resumeRecord(scope, id, goal));
  }
  resumeBudget(scope: BudgetScope, id: string, goal?: GoalResumeTarget) {
    if (!validAgentId(id)) return Promise.reject(new Fault('INVALID_BUDGET_CONTINUATION', 400));
    return this.exclusive(() =>
      this.db.transaction(
        () => {
          const signature = JSON.stringify([scope.budgetId, scope.revision, goalResumeKey(goal)]);
          if (this.resumeRecord(scope, id, goal)) return true;
          const turns = this.db
            .select()
            .from(groupTurns)
            .all()
            .filter((turn) => turn.budget?.budgetId === scope.budgetId);
          if (!turns.length) return false;
          for (const turn of turns) {
            const group = this.group(turn.grp);
            if (group.archived) throw new Fault('GROUP_ARCHIVED');
            const stages = this.stages(turn.grp, turn.id);
            if (stages.some((stage) => this.runner.running(stage.bot)))
              throw new Fault('BUDGET_TASK_RUNNING', 409);
            const failed = stages.find(
              (stage) =>
                ['failed', 'interrupted'].includes(stage.state) &&
                !stages.some((next) => next.retryStage === stage.id),
            );
            if (failed) {
              const issue = failed.run
                ? this.runner.budgetResumeIssue?.(failed.bot, failed.run, goal)
                : undefined;
              if (issue) throw new Fault(issue, 409);
              // A new delivery keeps the failed reply and its receipt intact; only an explicit human continuation can retry it.
              this.db
                .insert(groupDeliveries)
                .values({
                  id: `budget-${digest([id, failed.id])}`,
                  grp: failed.grp,
                  source: failed.source,
                  bot: failed.bot,
                  position: failed.position,
                  state: 'pending',
                  retryOf: goal ? undefined : (failed.run ?? undefined),
                  goalResume: goal,
                  retryStage: failed.id,
                  context: failed.context,
                  name: failed.name,
                })
                .run();
              for (const stage of stages.filter(
                (stage) => stage.position > failed.position && stage.state === 'cancelled',
              ))
                this.db
                  .update(groupDeliveries)
                  .set({ state: 'pending', error: null })
                  .where(eq(groupDeliveries.id, stage.id))
                  .run();
            }
            const waiting = !!failed || stages.some((stage) => stage.state === 'pending');
            this.db
              .update(groupTurns)
              .set({ budget: scope, ...(waiting ? { state: 'pending' } : {}) })
              .where(and(eq(groupTurns.grp, turn.grp), eq(groupTurns.id, turn.id)))
              .run();
          }
          this.db.insert(groupBudgetResumes).values({ id, signature }).run();
          this.changed();
          return true;
        },
        { behavior: 'immediate' },
      ),
    );
  }
  async cancel(group: string, sourceId: string) {
    if (!validAgentId(sourceId)) throw new Fault('INVALID_GROUP_MESSAGE', 400);
    const active = await this.exclusive(() =>
      this.db.transaction(
        () => {
          this.group(group);
          const rows = this.db
            .select()
            .from(groupDeliveries)
            .where(and(eq(groupDeliveries.grp, group), eq(groupDeliveries.source, sourceId)))
            .all();
          if (!rows.length) throw new Fault('GROUP_MESSAGE_NOT_FOUND', 404);
          const active = rows.filter((row) => row.state === 'claimed' || row.state === 'running');
          this.db
            .update(groupDeliveries)
            .set({ state: 'cancelled' })
            .where(
              and(
                eq(groupDeliveries.grp, group),
                eq(groupDeliveries.source, sourceId),
                inArray(groupDeliveries.state, live),
              ),
            )
            .run();
          this.db
            .update(groupTurns)
            .set({ state: 'cancelled' })
            .where(
              and(
                eq(groupTurns.grp, group),
                eq(groupTurns.id, sourceId),
                inArray(groupTurns.state, waiting),
              ),
            )
            .run();
          this.changed();
          return active;
        },
        { behavior: 'immediate' },
      ),
    );
    // Stop outside the database owner: a model may itself be awaiting a queued group tool.
    await Promise.all(
      active.map((row) => this.runner.stopRequest(String(row.bot), requestId(row), group)),
    );
    return this.exclusive(() => {
      for (const row of active) {
        const receipt = this.runner.findRequest(String(row.bot), requestId(row));
        if (receipt?.conversationId === group && terminal.has(receipt.phase))
          this.db.transaction(
            () => {
              this.appendResult(row, receipt);
              this.changed();
            },
            { behavior: 'immediate' },
          );
      }
      return { ...this.page(group), cancelledSource: sourceId };
    });
  }
  hasPendingBot(bot: string) {
    if (!validAgentId(bot)) return Promise.reject(new Fault('INVALID_GROUP_QUERY', 400));
    return this.exclusive(
      () =>
        !!this.db
          .select({ id: groupDeliveries.id })
          .from(groupDeliveries)
          .where(and(eq(groupDeliveries.bot, bot), inArray(groupDeliveries.state, live)))
          .limit(1)
          .get(),
    );
  }
  private activeSource(source: GroupSource) {
    source.signal?.throwIfAborted();
    const group = this.group(source.group);
    if (group.archived) throw new Fault('GROUP_ARCHIVED');
    if (!group.members.includes(source.bot)) throw new Fault('GROUP_SOURCE_CLOSED');
    const row = this.db
      .select()
      .from(groupDeliveries)
      .where(
        and(
          eq(groupDeliveries.grp, group.id),
          eq(groupDeliveries.bot, source.bot),
          inArray(groupDeliveries.state, claimed),
        ),
      )
      .orderBy(asc(groupDeliveries.position))
      .limit(1)
      .get();
    const receipt = row ? this.runner.findRequest(source.bot, requestId(row)) : undefined;
    if (
      (this.runner.source && !this.runner.source(source.bot, source.runId, source.group)) ||
      !row ||
      !receipt ||
      receipt.runId !== source.runId ||
      receipt.conversationId !== group.id ||
      !this.runner.running(source.bot) ||
      terminal.has(receipt.phase)
    )
      throw new Fault('GROUP_SOURCE_CLOSED');
    this.projectMembers(group.project, [source.bot]);
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
      const turn = this.turn(group.id, String(row.source));
      if (args.messageId !== undefined) {
        if (!validAgentId(args.messageId) || args.before !== undefined)
          throw new Fault('INVALID_GROUP_QUERY', 400);
        const target = this.earlier(
          group.id,
          Number(turn.seq),
          eq(groupMessages.id, args.messageId),
        ).get();
        if (!target) throw new Fault('GROUP_MESSAGE_NOT_FOUND', 404);
        const message = this.message(target.message),
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
      const messages = this.earlier(group.id, Number(turn.seq), lt(groupMessages.seq, before))
        .orderBy(desc(groupMessages.seq))
        .limit(limit + 1)
        .all();
      const entries = messages.slice(0, limit).map((value) => {
        const message = this.message(value.message),
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
      this.db.transaction(
        () => {
          const { group, row } = this.activeSource(source);
          if (
            !group.members.includes(source.bot) ||
            !group.members.includes(value.bot) ||
            value.bot === source.bot
          )
            throw new Fault('GROUP_MEMBER_REQUIRED');
          const signature = JSON.stringify(value),
            previous = this.db
              .select()
              .from(groupHandoffs)
              .where(eq(groupHandoffs.source, String(row.id)))
              .get();
          if (previous) {
            if (previous.signature !== signature) throw new Fault('GROUP_HANDOFF_CONFLICT');
            return {
              group: group.id,
              sourceId: String(row.source),
              bot: value.bot,
              deliveryId: String(previous.target),
            };
          }
          this.projectMembers(group.project, [source.bot, value.bot]);
          if (this.runner.admit?.(value.bot) === false) throw new Fault('BOT_UNAVAILABLE');
          const stages = this.stages(group.id, String(row.source));
          let target: { id: string } | undefined = stages.find(
            (stage) => stage.bot === value.bot && stage.state === 'pending',
          );
          if (!target) {
            if (stages.length >= 8) throw new Fault('GROUP_HANDOFF_LIMIT');
            const position = Number(stages.at(-1)!.position) + 1;
            const id = digest([group.id, row.source, position, value.bot]);
            this.db
              .insert(groupDeliveries)
              .values({
                id,
                grp: group.id,
                source: String(row.source),
                bot: value.bot,
                position,
                state: 'pending',
              })
              .run();
            target = { id };
          }
          this.db
            .insert(groupHandoffs)
            .values({ source: String(row.id), signature, target: String(target.id) })
            .run();
          this.db
            .insert(groupMessages)
            .values({
              id: `handoff-${row.id}`,
              grp: group.id,
              source: String(row.source),
              role: 'bot',
              text: `转交给 ${value.bot}：${value.message}`,
              created: new Date().toISOString(),
              author: source.bot,
              name: String(row.name || source.bot),
              run: source.runId,
            })
            .run();
          this.changed();
          return {
            group: group.id,
            sourceId: String(row.source),
            bot: value.bot,
            deliveryId: String(target.id),
          };
        },
        { behavior: 'immediate' },
      ),
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
    this.db?.$client.close();
  }
  async drain() {
    await this.chain.catch(() => {});
  }
}
