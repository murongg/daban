import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type AutomationNotice,
  type AutomationSource,
  isAutomationCode,
  isAutomationNotice,
  isAutomationSource,
  isAutomationView,
  isMonitorPolicy,
  isScheduleInput,
  isSchedulePatch,
  isScheduleRule,
  type MonitorPolicy,
  type Schedule,
  type ScheduleInput,
  validAgentId,
} from '@daban/protocol';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type FileObserver, sampleFiles, signalDigest } from './automation.js';
import { errorCode, Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';
import { nativeSchedules, type ScheduleDomain } from './schedule-domain.js';
import { migrations } from './schedules-migrations.js';
import { automationEvents, automations, firings, schedules } from './schedules-schema.js';

export type { ScheduleDomain } from './schedule-domain.js';

interface Runner {
  running(bot: string): boolean;
  admit?(bot: string): boolean;
  findRequest(
    bot: string,
    id: string,
  ): { runId: string; phase: string; error?: string } | undefined;
  signal?(bot: string, runId: string, path: string): Promise<Uint8Array>;
  monitoringAvailable?(): boolean;
  start(
    bot: string,
    task: { requestId: string; prompt: string },
    conversation?: undefined,
    source?: AutomationSource,
  ): Promise<unknown>;
}
type Row = typeof schedules.$inferSelect;
type Firing = typeof firings.$inferSelect;
type Automation = typeof automations.$inferSelect;

function legacy(client: DatabaseSync) {
  client.exec(`CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, bot TEXT NOT NULL, input TEXT NOT NULL, record TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS firings (id TEXT PRIMARY KEY, schedule TEXT NOT NULL, bot TEXT NOT NULL, occurrence TEXT NOT NULL, created TEXT NOT NULL, state TEXT NOT NULL, prompt TEXT NOT NULL, run TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS firing_schedule ON firings(schedule,created);
    CREATE INDEX IF NOT EXISTS firing_pending ON firings(state,created);`);
}

// Host-created rowids persist the enqueue order even when clocks repeat or move backwards.
const inserted = sql<number>`rowid`;
const encoded = (value: unknown) =>
  JSON.stringify(value, [
    'id',
    'bot',
    'title',
    'prompt',
    'rule',
    'enabled',
    'locked',
    'kind',
    'everySeconds',
    'time',
    'timeZone',
    'weekdays',
    'date',
    'expression',
    'scope',
    'projectId',
    'revision',
    'paths',
    'pollSeconds',
  ]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 40);
export const scheduleKey = (runId: string, input: unknown) =>
  `bot-${digest(`${runId}:${encoded(input)}`)}`;
export interface ScheduleActor {
  bot: string;
  signal?: AbortSignal;
}
export class Schedules {
  // shortcut: one runtime service owns this database; add a process lease before allowing multiple schedulers.
  readonly ready: Promise<unknown>;
  private db!: Database;
  private domain!: ScheduleDomain;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private closing = false;
  private readonly samples = new Map<string, AbortController>();
  private readonly observations = new Set<Promise<unknown>>();
  private failure = '';
  private readonly clock: () => number;
  constructor(
    readonly options: {
      file: string;
      runner: Runner;
      clock?: () => number;
      domain?: Promise<ScheduleDomain>;
      observation?: FileObserver;
    },
  ) {
    this.clock = options.clock || Date.now;
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    this.domain = await (this.options.domain || nativeSchedules());
    await mkdir(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
    const existing = await lstat(this.options.file).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))
      throw new Fault('SCHEDULE_CORRUPT');
    if (!existing) await (await open(this.options.file, 'wx', 0o600)).close();
    await chmod(this.options.file, 0o600);
    const client = new DatabaseSync(this.options.file);
    try {
      configure(client, { journal: 'WAL', synchronous: 'FULL', busyTimeout: 5000 });
      this.db = migrate(client, migrations, legacy);
    } catch (error) {
      client.close();
      if (
        error instanceof Error &&
        ['DATABASE_NEWER', 'DATABASE_UNVERSIONED'].includes(error.message)
      )
        throw new Fault('SCHEDULE_CORRUPT');
      throw error;
    }
    for (const row of this.db.select().from(schedules).all()) this.decode(row);
    // A prior claim may have started the model before crashing. Inspect its receipt; never issue it again.
    for (const row of this.active()) this.reconcile(row, true);
  }
  private active() {
    return this.db
      .select()
      .from(firings)
      .where(inArray(firings.state, ['claimed', 'running']))
      .all();
  }
  private firingRow(id: string) {
    return this.db.select().from(firings).where(eq(firings.id, id)).get();
  }
  private live(bot: string, enabled?: boolean) {
    return this.db
      .select({ count: count() })
      .from(schedules)
      .where(
        and(
          eq(schedules.bot, bot),
          enabled ? eq(schedules.enabled, 1) : undefined,
          eq(schedules.deleted, 0),
        ),
      )
      .get()!.count;
  }
  private cancelPending(id: string) {
    this.db
      .update(firings)
      .set({ state: 'cancelled' })
      .where(and(eq(firings.schedule, id), eq(firings.state, 'pending')))
      .run();
  }
  private state(id: string) {
    const state = this.db.select().from(automations).where(eq(automations.schedule, id)).get();
    if (
      state &&
      (!isAutomationView(this.automationView(state)) ||
        !Number.isSafeInteger(state.resultFloor) ||
        state.resultFloor < 0)
    )
      throw new Fault('SCHEDULE_CORRUPT');
    return state;
  }
  private automationView(state: Automation) {
    return {
      configRevision: state.configRevision,
      policy: JSON.parse(state.policy) as MonitorPolicy,
      initialized: state.committed !== null,
      cursor: state.cursor,
      count: state.consecutive,
      ...(state.committed ? { committed: state.committed } : {}),
      ...(state.candidate ? { candidate: state.candidate } : {}),
      ...(state.nextPoll ? { nextPollAt: new Date(state.nextPoll).toISOString() } : {}),
      ...(state.observeError || state.resultError
        ? { error: state.observeError || state.resultError! }
        : {}),
    };
  }
  private source(row: Firing) {
    if (!row.source) return undefined;
    const value: unknown = JSON.parse(row.source);
    if (
      !isAutomationSource(value) ||
      value.scheduleId !== row.schedule ||
      value.firingId !== row.id
    )
      throw new Fault('SCHEDULE_CORRUPT');
    return value;
  }
  private resetConfiguration(id: string, policy?: MonitorPolicy) {
    const previous = this.state(id);
    this.samples.get(id)?.abort();
    this.db
      .insert(automations)
      .values({
        schedule: id,
        configRevision: (previous?.configRevision ?? 0) + 1,
        policy: JSON.stringify(
          policy ?? (previous ? JSON.parse(previous.policy) : { kind: 'all' }),
        ),
      })
      .onConflictDoUpdate({
        target: automations.schedule,
        set: {
          configRevision: (previous?.configRevision ?? 0) + 1,
          policy: JSON.stringify(
            policy ?? (previous ? JSON.parse(previous.policy) : { kind: 'all' }),
          ),
          committed: null,
          candidate: null,
          consecutive: 0,
          cursor: 0,
          nextPoll: 0,
          observeError: null,
          resultDigest: null,
          resultError: null,
          resultFloor: 0,
          notice: null,
        },
      })
      .run();
  }
  private record(input: ScheduleInput, now: number) {
    return input.rule.kind === 'file'
      ? {
          id: input.id,
          title: input.title,
          prompt: input.prompt,
          kind: 'file-observation-v1',
          scheduledAt: new Date(now).toISOString(),
        }
      : this.domain.create(input, now);
  }
  private requireFiles(row: Row) {
    const { input } = this.decode(row);
    if (input.rule.kind !== 'file') return;
    if (!this.options.observation || this.options.observation.available?.() === false)
      throw new Fault('AUTOMATION_FILES_UNAVAILABLE');
    this.options.observation.authorize(input.bot, input.rule.scope);
  }
  private monitoringSupported(row: Row) {
    const state = this.state(row.id);
    return (
      !state ||
      (JSON.parse(state.policy) as MonitorPolicy).kind !== 'changes' ||
      this.options.runner.monitoringAvailable?.() !== false
    );
  }
  private pauseUnsupportedMonitor(row: Row) {
    const state = this.state(row.id);
    if (!state) return;
    // Both callers commit the pause and notice in their existing immediate owner transaction.
    const code = 'AUTOMATION_MONITOR_UNAVAILABLE';
    const latest = this.db
      .select({ order: inserted })
      .from(firings)
      .where(eq(firings.schedule, row.id))
      .orderBy(desc(inserted))
      .get();
    if (state.resultError !== code) this.notice(row, state, 'fault', code);
    this.db
      .update(automations)
      // Capability recovery needs a newly accepted firing, even if an old receipt arrives after it returns.
      .set({
        resultError: code,
        resultFloor: Math.max(state.resultFloor, (latest?.order ?? 0) + 1),
      })
      .where(eq(automations.schedule, row.id))
      .run();
    const { input } = this.decode(row);
    this.db
      .update(schedules)
      .set({
        input: encoded({ ...input, enabled: false }),
        enabled: 0,
        revision: sql`${schedules.revision} + 1`,
      })
      .where(eq(schedules.id, row.id))
      .run();
    this.cancelPending(row.id);
  }
  monitor(id: string, revision: number, policy: unknown) {
    if (
      !validAgentId(id) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !isMonitorPolicy(policy)
    )
      return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    const copy: MonitorPolicy =
      policy.kind === 'all' ? { kind: 'all' } : { kind: 'changes', signalPath: policy.signalPath };
    return this.exclusive(() =>
      this.db.transaction(
        () => {
          const row = this.row(id);
          if (row.revision !== revision) throw new Fault('SCHEDULE_CONFLICT');
          const state = this.state(id);
          const previous: MonitorPolicy = state ? JSON.parse(state.policy) : { kind: 'all' };
          if (
            previous.kind === copy.kind &&
            (copy.kind === 'all' ||
              (previous.kind === 'changes' && previous.signalPath === copy.signalPath))
          )
            return this.view(row);
          this.resetConfiguration(id, copy);
          this.cancelPending(id);
          const { input } = this.decode(row);
          this.db
            .update(schedules)
            .set({
              input: encoded({ ...input, enabled: false }),
              enabled: 0,
              revision: revision + 1,
              updated: new Date(this.clock()).toISOString(),
            })
            .where(eq(schedules.id, id))
            .run();
          return this.view(this.row(id));
        },
        { behavior: 'immediate' },
      ),
    );
  }
  private receiptOwner(id: string) {
    // Deleting a definition cannot erase the lookup/ack path for an already claimed, uncertain execution.
    const row = this.db.select().from(schedules).where(eq(schedules.id, id)).get();
    if (!row) throw new Fault('SCHEDULE_NOT_FOUND', 404);
    return row;
  }
  receipt(id: string, firing: string) {
    return this.exclusive(() => {
      this.receiptOwner(id);
      const row = this.firingRow(firing);
      if (!row || row.schedule !== id) throw new Fault('SCHEDULE_NOT_FOUND', 404);
      if (row.state === 'interrupted' || row.state === 'running' || row.state === 'claimed')
        this.reconcile(row, true);
      return this.firing(this.firingRow(firing)!);
    });
  }
  private unknownKey(id: string) {
    return `unknown-${digest(id)}`;
  }
  notices() {
    return this.exclusive(() => {
      const items: AutomationNotice[] = this.db
        .select()
        .from(automations)
        .where(isNotNull(automations.notice))
        .orderBy(desc(automations.noticeRevision))
        .limit(1000)
        .all()
        .flatMap((state) => {
          if (!state.notice) return [];
          const notice: unknown = JSON.parse(state.notice);
          if (!isAutomationNotice(notice)) throw new Fault('SCHEDULE_CORRUPT');
          const row = this.db
            .select()
            .from(schedules)
            .where(eq(schedules.id, state.schedule))
            .get();
          return row && !row.deleted ? [notice] : [];
        });
      for (const row of this.db
        .select()
        .from(firings)
        .where(
          and(
            eq(firings.state, 'interrupted'),
            isNull(firings.run),
            isNotNull(firings.source),
            eq(firings.unknownAck, 0),
          ),
        )
        .orderBy(desc(firings.created), desc(inserted))
        .limit(1000)
        .all()) {
        this.source(row);
        items.unshift({
          kind: 'automation',
          id: this.unknownKey(row.id),
          bot: row.bot,
          schedule: row.schedule,
          firing: row.id,
          createdAt: row.created,
          phase: 'interrupted',
          reason: 'fault',
          code: 'SCHEDULE_OUTCOME_UNKNOWN',
        });
      }
      return items;
    });
  }
  ack(id: string, notice: string) {
    return this.exclusive(() => {
      this.receiptOwner(id);
      const state = this.state(id);
      if (state?.notice && JSON.parse(state.notice).id === notice)
        this.db.update(automations).set({ notice: null }).where(eq(automations.schedule, id)).run();
      for (const row of this.db
        .select({ id: firings.id })
        .from(firings)
        .where(
          and(
            eq(firings.schedule, id),
            eq(firings.state, 'interrupted'),
            isNull(firings.run),
            isNotNull(firings.source),
            eq(firings.unknownAck, 0),
          ),
        )
        .all())
        if (this.unknownKey(row.id) === notice)
          this.db.update(firings).set({ unknownAck: 1 }).where(eq(firings.id, row.id)).run();
      return { acknowledged: true };
    });
  }
  private decode(row: Row) {
    try {
      const input: unknown = JSON.parse(String(row.input));
      if (!isScheduleInput(input) || input.id !== row.id || input.bot !== row.bot)
        throw new Error('invalid schedule');
      const raw = JSON.parse(String(row.record));
      const record = input.rule.kind === 'file' ? raw : this.domain.decode(raw);
      if (record.id !== row.id || !Number.isFinite(Date.parse(record.scheduledAt)))
        throw new Error('invalid native schedule');
      if (
        input.rule.kind === 'file' &&
        (record.kind !== 'file-observation-v1' ||
          record.title !== input.title ||
          record.prompt !== input.prompt)
      )
        throw new Error('invalid file schedule');
      return { input: { ...input, locked: input.locked ?? false }, record };
    } catch {
      throw new Fault('SCHEDULE_CORRUPT');
    }
  }
  private exclusive<T>(action: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      await this.ready;
      if (this.closed) throw new Fault('SCHEDULE_CLOSED');
      return action();
    });
    this.chain = next.catch(() => {});
    return next;
  }
  private row(id: string, actor?: ScheduleActor, write = false) {
    actor?.signal?.throwIfAborted();
    const row = this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.id, id), eq(schedules.deleted, 0)))
      .get();
    if (!row || (actor && row.bot !== actor.bot)) throw new Fault('SCHEDULE_NOT_FOUND', 404);
    // Ownership and locks are checked in the same serialized operation that commits the mutation.
    if (actor && write && this.decode(row).input.locked) throw new Fault('SCHEDULE_LOCKED');
    return row;
  }
  private view(row: Row): Schedule {
    const { input, record } = this.decode(row);
    return {
      ...input,
      enabled: row.enabled === 1,
      revision: Number(row.revision),
      createdAt: String(row.created),
      updatedAt: String(row.updated),
      ...(row.enabled === 1 && input.rule.kind !== 'file' ? { nextRunAt: record.scheduledAt } : {}),
      ...(this.state(row.id) ? { automation: this.automationView(this.state(row.id)!) } : {}),
      history: this.db
        .select()
        .from(firings)
        .where(eq(firings.schedule, String(row.id)))
        .orderBy(desc(firings.created), desc(inserted))
        .limit(20)
        .all()
        .map((firing) => this.firing(firing)),
    };
  }
  private firing(row: Firing): Schedule['history'][number] {
    return {
      id: String(row.id),
      requestId: `schedule-${row.id}`,
      occurrenceAt: String(row.occurrence),
      createdAt: String(row.created),
      state: row.state as Schedule['history'][number]['state'],
      ...(row.run ? { runId: String(row.run) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
      ...(row.source ? { source: this.source(row)! } : {}),
      ...(row.monitor ? { monitor: row.monitor as Schedule['history'][number]['monitor'] } : {}),
    };
  }
  list(actor?: ScheduleActor) {
    return this.exclusive(() =>
      this.db
        .select()
        .from(schedules)
        .where(and(eq(schedules.deleted, 0), actor ? eq(schedules.bot, actor.bot) : undefined))
        .orderBy(asc(schedules.created), asc(schedules.id))
        .all()
        .map((row) => this.view(row)),
    );
  }
  suspendBot(bot: string) {
    if (!validAgentId(bot)) return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    return this.exclusive(() =>
      this.db.transaction(
        () => {
          const rows = this.db
            .select()
            .from(schedules)
            .where(and(eq(schedules.bot, bot), eq(schedules.enabled, 1), eq(schedules.deleted, 0)))
            .all();
          const stamp = new Date(this.clock()).toISOString();
          for (const row of rows) {
            this.samples.get(row.id)?.abort();
            const { input } = this.decode(row);
            // Human archive also pauses locked plans; it preserves their locks, definitions and due targets.
            this.db
              .update(schedules)
              .set({
                input: encoded({ ...input, enabled: false }),
                enabled: 0,
                revision: sql`${schedules.revision} + 1`,
                updated: stamp,
              })
              .where(eq(schedules.id, String(row.id)))
              .run();
          }
          const cancelled = this.db
            .update(firings)
            .set({ state: 'cancelled', error: 'BOT_ARCHIVED' })
            .where(and(eq(firings.bot, bot), eq(firings.state, 'pending')))
            .run().changes;
          return { disabled: rows.length, cancelled: Number(cancelled) };
        },
        { behavior: 'immediate' },
      ),
    );
  }
  private requireAdmission(bot: string) {
    if (this.options.runner.admit?.(bot) === false) throw new Fault('BOT_UNAVAILABLE');
  }
  async status() {
    try {
      return {
        available: !this.failure,
        items: await this.list(),
        ...(this.failure ? { error: this.failure } : {}),
      };
    } catch (error) {
      return { available: false, items: [], error: errorCode(error) || 'SCHEDULE_UNAVAILABLE' };
    }
  }
  get(id: string, actor?: ScheduleActor) {
    if (!validAgentId(id)) return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    return this.exclusive(() => this.view(this.row(id, actor)));
  }
  preview(rule: unknown) {
    if (!isScheduleRule(rule)) return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    const copy = structuredClone(rule);
    return this.exclusive(() => {
      let record = this.domain.create(
        { id: 'preview', bot: 'preview', title: 'preview', prompt: 'preview', rule: copy },
        this.clock(),
      );
      const times = [record.scheduledAt];
      for (let i = 1; i < 3; i++) {
        const next = this.domain.due(record, Date.parse(record.scheduledAt)).nextScheduledAt;
        if (!next) break;
        times.push(next);
        record = { ...record, scheduledAt: next };
      }
      return times;
    });
  }
  create(value: unknown, actor?: ScheduleActor) {
    if (!isScheduleInput(value)) return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    const input = {
      ...structuredClone(value),
      title: value.title.trim(),
      prompt: value.prompt.trim(),
      enabled: value.rule.kind === 'file' ? false : (value.enabled ?? true),
      locked: value.locked ?? false,
    };
    if (input.rule.kind === 'file') input.rule.paths.sort();
    return this.exclusive(() =>
      this.db.transaction(
        () => {
          actor?.signal?.throwIfAborted();
          if (actor && input.bot !== actor.bot) throw new Fault('SCHEDULE_NOT_FOUND', 404);
          if (actor && input.locked) throw new Fault('SCHEDULE_LOCKED');
          const prior = this.db.select().from(schedules).where(eq(schedules.id, input.id)).get();
          if (prior) {
            if (actor && prior.bot !== actor.bot) throw new Fault('SCHEDULE_NOT_FOUND', 404);
            if (actor && this.decode(prior).input.locked) throw new Fault('SCHEDULE_LOCKED');
            if (prior.deleted || encoded(this.decode(prior).input) !== encoded(input))
              throw new Fault('SCHEDULE_ID_REUSED');
            return this.view(prior);
          }
          if (input.enabled) this.requireAdmission(input.bot);
          if (this.live(input.bot) >= 100 || (input.enabled && this.live(input.bot, true) >= 20))
            throw new Fault('SCHEDULE_LIMIT');
          const now = this.clock(),
            record = this.record(input, now),
            stamp = new Date(now).toISOString();
          this.db
            .insert(schedules)
            .values({
              id: input.id,
              bot: input.bot,
              input: encoded(input),
              record: JSON.stringify(record),
              revision: 1,
              enabled: input.enabled ? 1 : 0,
              created: stamp,
              updated: stamp,
            })
            .run();
          if (input.rule.kind === 'file') this.resetConfiguration(input.id);
          return this.view(this.row(input.id));
        },
        { behavior: 'immediate' },
      ),
    );
  }
  update(id: string, revision: number, patch: unknown, actor?: ScheduleActor) {
    if (
      !validAgentId(id) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !isSchedulePatch(patch)
    )
      return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    const changes = structuredClone(patch);
    if (changes.rule?.kind === 'file') changes.rule.paths.sort();
    return this.exclusive(() =>
      this.db.transaction(
        () => {
          const row = this.row(id, actor, true),
            { input, record } = this.decode(row);
          if (actor && changes.locked !== undefined) throw new Fault('SCHEDULE_LOCKED');
          if (row.revision !== revision) throw new Fault('SCHEDULE_CONFLICT');
          const next = {
            ...input,
            ...changes,
            title: (changes.title ?? input.title).trim(),
            prompt: (changes.prompt ?? input.prompt).trim(),
            enabled: changes.enabled ?? row.enabled === 1,
          };
          const substantive =
            (changes.rule !== undefined && encoded(changes.rule) !== encoded(input.rule)) ||
            (changes.prompt !== undefined && next.prompt !== input.prompt);
          const automated = !!this.state(id) || next.rule.kind === 'file';
          const lockOnly = Object.keys(changes).every((key) => key === 'locked');
          const enabledChanged = next.enabled !== (row.enabled === 1);
          if (substantive && automated) next.enabled = false;
          if (next.enabled && enabledChanged && !this.monitoringSupported(row))
            throw new Fault('AUTOMATION_MONITOR_UNAVAILABLE');
          if (next.rule.kind === 'file') {
            next.rule.paths.sort();
            if (next.enabled && changes.enabled === true && enabledChanged) {
              if (!this.options.observation || this.options.observation.available?.() === false)
                throw new Fault('AUTOMATION_FILES_UNAVAILABLE');
              this.options.observation.authorize(next.bot, next.rule.scope);
            }
          }
          // Edit protection must remain available while execution or the file source is unavailable.
          if (next.enabled && !lockOnly) this.requireAdmission(input.bot);
          if (encoded(next) === encoded({ ...input, enabled: row.enabled === 1 }))
            return this.view(row);
          if (next.enabled && row.enabled !== 1 && this.live(input.bot, true) >= 20)
            throw new Fault('SCHEDULE_LIMIT');
          // Editing a name or instruction must not move an already committed wall-clock target.
          const reset =
            (changes.rule !== undefined && encoded(changes.rule) !== encoded(input.rule)) ||
            (next.enabled && row.enabled !== 1);
          const target = reset
            ? this.record(next, this.clock())
            : { ...record, title: next.title, prompt: next.prompt };
          this.db
            .update(schedules)
            .set({
              input: encoded(next),
              record: JSON.stringify(target),
              revision: sql`${schedules.revision} + 1`,
              enabled: next.enabled ? 1 : 0,
              updated: new Date(this.clock()).toISOString(),
            })
            .where(eq(schedules.id, id))
            .run();
          if (substantive && automated) this.resetConfiguration(id);
          if (changes.enabled !== undefined && enabledChanged) {
            this.samples.get(id)?.abort();
            if (next.rule.kind === 'file' && next.enabled && !substantive)
              this.db
                .update(automations)
                .set({
                  committed: null,
                  candidate: null,
                  consecutive: 0,
                  nextPoll: 0,
                  observeError: null,
                })
                .where(eq(automations.schedule, id))
                .run();
          }
          if (
            automated
              ? substantive || enabledChanged
              : Object.keys(changes).some((key) => key !== 'locked')
          )
            this.cancelPending(id);
          return this.view(this.row(id));
        },
        { behavior: 'immediate' },
      ),
    );
  }
  remove(id: string, revision: number, actor?: ScheduleActor) {
    if (!validAgentId(id) || !Number.isSafeInteger(revision) || revision < 1)
      return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    return this.exclusive(() =>
      this.db.transaction(
        () => {
          const row = this.row(id, actor, true);
          if (row.revision !== revision) throw new Fault('SCHEDULE_CONFLICT');
          this.db
            .update(schedules)
            .set({ deleted: 1, enabled: 0, revision: sql`${schedules.revision} + 1` })
            .where(eq(schedules.id, id))
            .run();
          this.cancelPending(id);
          this.samples.get(id)?.abort();
          return { id, removed: true };
        },
        { behavior: 'immediate' },
      ),
    );
  }
  private enqueue(
    row: Row,
    id: string,
    occurrence: string,
    origin: AutomationSource['trigger'] = 'time',
    event?: Pick<AutomationSource, 'fromCursor' | 'toCursor' | 'before' | 'after'>,
  ) {
    const existing = this.firingRow(id);
    if (existing) return this.firing(existing);
    const { input } = this.decode(row);
    const pending = this.db
      .select({ id: firings.id })
      .from(firings)
      .where(and(eq(firings.schedule, input.id), eq(firings.state, 'pending')))
      .get();
    const state = this.state(input.id);
    const source: AutomationSource = {
      scheduleId: input.id,
      firingId: id,
      configRevision: state?.configRevision ?? 1,
      trigger: origin,
      policy: state ? JSON.parse(state.policy) : { kind: 'all' },
      ...(input.rule.kind === 'file'
        ? { scope: input.rule.scope, paths: [...input.rule.paths] }
        : {}),
      ...event,
    };
    const prompt = `This is the user’s previously saved scheduled task: ${input.title}.\nScheduled trigger time: ${occurrence}.\nExecute the following instructions under the actual conditions of this turn. Ask if required input is missing, and do not claim completion based on history:\n${input.prompt}`;
    if (pending && origin === 'file') {
      const previous = this.firingRow(pending.id)!;
      const prior = this.source(previous)!;
      // Only unclaimed input is replaceable; cursors preserve A→B→A as distinct observations.
      this.db
        .update(firings)
        .set({
          prompt,
          occurrence,
          source: JSON.stringify({
            ...source,
            firingId: pending.id,
            fromCursor: prior.fromCursor ?? source.fromCursor,
            before: prior.before ?? source.before,
          }),
        })
        .where(and(eq(firings.id, pending.id), eq(firings.state, 'pending')))
        .run();
      return this.firing(this.firingRow(pending.id)!);
    }
    this.db
      .insert(firings)
      .values({
        id,
        schedule: input.id,
        bot: input.bot,
        occurrence,
        created: new Date(this.clock()).toISOString(),
        state: pending ? 'coalesced' : 'pending',
        prompt,
        source: source ? JSON.stringify(source) : null,
      })
      .run();
    return this.firing(this.firingRow(id)!);
  }
  run(id: string, requestId: string) {
    if (!validAgentId(id) || !validAgentId(requestId))
      return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    return this.exclusive(() =>
      this.db.transaction(
        () => {
          const key = `manual-${digest(`${id}:${requestId}`)}`;
          const previous = this.firingRow(key);
          if (previous) return this.firing(previous);
          const row = this.row(id);
          this.requireAdmission(String(row.bot));
          if (!this.monitoringSupported(row)) throw new Fault('AUTOMATION_MONITOR_UNAVAILABLE');
          this.requireFiles(row);
          return this.enqueue(row, key, new Date(this.clock()).toISOString(), 'manual');
        },
        { behavior: 'immediate' },
      ),
    );
  }
  private reconcile(row: Firing, recovering = false) {
    const receipt = this.options.runner.findRequest(String(row.bot), `schedule-${row.id}`);
    if (!receipt && !recovering) return;
    const phase = receipt?.phase;
    const state =
      phase === 'completed'
        ? 'completed'
        : phase === 'failed'
          ? 'failed'
          : ['interrupted', 'stopped'].includes(phase || '') || !receipt
            ? 'interrupted'
            : 'running';
    this.db
      .update(firings)
      .set({
        state,
        run: receipt?.runId || null,
        error: receipt?.error?.slice(0, 1000) || (!receipt ? 'SCHEDULE_OUTCOME_UNKNOWN' : null),
        ...(state !== row.state ? { monitor: null } : {}),
      })
      .where(eq(firings.id, String(row.id)))
      .run();
  }
  private notice(
    row: Row,
    state: Automation,
    reason: AutomationNotice['reason'],
    code?: string,
    runId?: string,
  ) {
    const revision = state.noticeRevision + 1;
    const notice: AutomationNotice = {
      kind: 'automation',
      id: `auto-${digest(`${row.id}:${state.configRevision}:${revision}`)}`,
      schedule: row.id,
      bot: row.bot,
      reason,
      phase:
        reason === 'fault'
          ? code === 'SCHEDULE_OUTCOME_UNKNOWN'
            ? 'interrupted'
            : 'failed'
          : 'completed',
      ...(code ? { code } : {}),
      ...(runId ? { runId } : {}),
    };
    this.db
      .update(automations)
      .set({ noticeRevision: revision, notice: JSON.stringify(notice) })
      .where(eq(automations.schedule, row.id))
      .run();
  }
  private observationFailure(row: Row, error: unknown) {
    const state = this.state(row.id);
    if (!state) return;
    const raw = errorCode(error);
    const code = isAutomationCode(raw) ? raw : 'AUTOMATION_READ_FAILED';
    const permanent =
      code.startsWith('PROJECT_') ||
      code === 'BOT_UNAVAILABLE' ||
      code === 'AUTOMATION_FILES_UNAVAILABLE';
    this.db.transaction(() => {
      if (state.observeError !== code) this.notice(row, state, 'fault', code);
      this.db
        .update(automations)
        .set({ observeError: code, candidate: null, consecutive: 0 })
        .where(eq(automations.schedule, row.id))
        .run();
      if (permanent) {
        const { input } = this.decode(row);
        this.db
          .update(schedules)
          .set({
            enabled: 0,
            input: encoded({ ...input, enabled: false }),
            revision: sql`${schedules.revision} + 1`,
          })
          .where(eq(schedules.id, row.id))
          .run();
        this.cancelPending(row.id);
      }
    });
  }
  private async pollFiles() {
    if (this.closing) return;
    const candidates = await this.exclusive(() =>
      this.db
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, 1), eq(schedules.deleted, 0)))
        .all()
        .flatMap((row) => {
          const { input } = this.decode(row);
          const state = this.state(row.id);
          if (
            input.rule.kind !== 'file' ||
            !state ||
            state.nextPoll > this.clock() ||
            this.samples.has(row.id)
          )
            return [];
          const controller = new AbortController();
          this.samples.set(row.id, controller);
          const nextPoll = this.clock() + input.rule.pollSeconds * 1000;
          this.db
            .update(automations)
            .set({ nextPoll })
            .where(eq(automations.schedule, row.id))
            .run();
          return [{ row, state, rule: input.rule, controller, nextPoll }];
        }),
    );
    // Bound per-file response buffers across rules without introducing another execution queue.
    for (let offset = 0; offset < candidates.length; offset += 4) {
      if (this.closing) break;
      await Promise.all(
        candidates.slice(offset, offset + 4).map((capture) => {
          const work = (async () => {
            const signal = AbortSignal.any([capture.controller.signal, AbortSignal.timeout(15000)]);
            try {
              if (!this.options.observation || this.options.observation.available?.() === false)
                throw new Fault('AUTOMATION_FILES_UNAVAILABLE');
              const hash = await sampleFiles(
                this.options.observation,
                capture.row.bot,
                capture.rule,
                signal,
              );
              await this.exclusive(() => {
                if (signal.aborted || this.closing) return;
                const row = this.db
                  .select()
                  .from(schedules)
                  .where(eq(schedules.id, capture.row.id))
                  .get();
                const state = this.state(capture.row.id);
                if (
                  !row ||
                  row.deleted ||
                  !row.enabled ||
                  !state ||
                  state.configRevision !== capture.state.configRevision ||
                  state.nextPoll !== capture.nextPoll
                )
                  return;
                this.requireFiles(row);
                this.db.transaction(
                  () => {
                    if (state.observeError && !state.resultError)
                      this.notice(row, state, 'recovered');
                    const consecutive =
                      state.candidate === hash ? Math.min(state.consecutive + 1, 2) : 1;
                    const changed =
                      consecutive === 2 && state.committed !== null && state.committed !== hash;
                    const cursor = state.cursor + (changed ? 1 : 0);
                    this.db
                      .update(automations)
                      .set({
                        candidate: hash,
                        consecutive,
                        committed: consecutive === 2 ? hash : state.committed,
                        cursor,
                        observeError: null,
                      })
                      .where(eq(automations.schedule, row.id))
                      .run();
                    if (changed) {
                      // A hash is a state, not an event identity: the cursor preserves observed A→B→A→B changes.
                      const id = `file-${digest(`${row.id}:${state.configRevision}:${cursor}`)}`;
                      const at = new Date(this.clock()).toISOString();
                      this.db
                        .insert(automationEvents)
                        .values({
                          id,
                          schedule: row.id,
                          configRevision: state.configRevision,
                          cursor,
                          before: state.committed!,
                          after: hash,
                          paths: JSON.stringify(capture.rule.paths),
                          observed: at,
                        })
                        .onConflictDoNothing()
                        .run();
                      this.enqueue(row, id, at, 'file', {
                        fromCursor: cursor,
                        toCursor: cursor,
                        before: state.committed!,
                        after: hash,
                      });
                    }
                  },
                  { behavior: 'immediate' },
                );
              });
            } catch (error) {
              if (!capture.controller.signal.aborted && !this.closing)
                await this.exclusive(() => {
                  const row = this.db
                    .select()
                    .from(schedules)
                    .where(eq(schedules.id, capture.row.id))
                    .get();
                  if (
                    row &&
                    !row.deleted &&
                    row.enabled &&
                    this.state(row.id)?.configRevision === capture.state.configRevision
                  )
                    this.observationFailure(row, error);
                });
            } finally {
              if (this.samples.get(capture.row.id) === capture.controller)
                this.samples.delete(capture.row.id);
            }
          })();
          this.observations.add(work);
          return work.finally(() => this.observations.delete(work));
        }),
      );
    }
  }
  private async monitorResults() {
    const rows = await this.exclusive(() =>
      this.db
        .select({ firing: firings, order: inserted })
        .from(firings)
        .where(
          and(
            isNotNull(firings.source),
            isNull(firings.monitor),
            inArray(firings.state, ['completed', 'failed', 'interrupted']),
          ),
        )
        .orderBy(asc(inserted))
        .limit(100)
        .all(),
    );
    for (const { firing, order } of rows) {
      const source = this.source(firing)!;
      let hash: string | undefined;
      let code: string | undefined;
      if (firing.state === 'interrupted' && !firing.run) code = 'SCHEDULE_OUTCOME_UNKNOWN';
      else if (firing.state !== 'completed')
        code = isAutomationCode(firing.error) ? firing.error : 'AUTOMATION_RUN_FAILED';
      else if (source.policy.kind === 'changes') {
        try {
          if (!firing.run || !this.options.runner.signal)
            throw new Fault('AUTOMATION_SIGNAL_UNAVAILABLE');
          hash = signalDigest(
            await this.options.runner.signal(firing.bot, firing.run, source.policy.signalPath),
          );
        } catch {
          code = 'AUTOMATION_SIGNAL_UNAVAILABLE';
        }
      }
      await this.exclusive(() =>
        this.db.transaction(
          () => {
            // Signal IO runs outside the owner queue; another tick may have committed this firing meanwhile.
            const current = this.firingRow(firing.id);
            if (
              !current ||
              current.monitor !== null ||
              current.state !== firing.state ||
              current.run !== firing.run
            )
              return;
            const row = this.db
              .select()
              .from(schedules)
              .where(eq(schedules.id, firing.schedule))
              .get();
            const state = this.state(firing.schedule);
            // This floor survives receipt reconciliation; equal order lets a firing settle its own unknown.
            if (
              !row ||
              row.deleted ||
              !state ||
              state.configRevision !== source.configRevision ||
              order < state.resultFloor
            ) {
              this.db
                .update(firings)
                .set({ monitor: 'unchanged' })
                .where(eq(firings.id, firing.id))
                .run();
              return;
            }
            const decision = code
              ? 'fault'
              : state.resultError
                ? 'recovered'
                : !state.resultDigest
                  ? 'baseline'
                  : hash !== state.resultDigest
                    ? 'changed'
                    : 'unchanged';
            // All-mode runs must also settle a recorded unknown outcome and any ensuing failure.
            const monitored =
              source.policy.kind === 'changes' ||
              code === 'SCHEDULE_OUTCOME_UNKNOWN' ||
              state.resultError !== null;
            if (monitored) {
              if (
                (code && code !== 'SCHEDULE_OUTCOME_UNKNOWN' && code !== state.resultError) ||
                (!code &&
                  !state.observeError &&
                  (decision === 'changed' || decision === 'recovered'))
              )
                this.notice(
                  row,
                  state,
                  code ? 'fault' : decision === 'recovered' ? 'recovered' : 'changed',
                  code,
                  firing.run ?? undefined,
                );
            }
            this.db
              .update(automations)
              .set({
                resultFloor: order,
                ...(monitored
                  ? { resultError: code ?? null, ...(hash ? { resultDigest: hash } : {}) }
                  : {}),
              })
              .where(eq(automations.schedule, row.id))
              .run();
            this.db
              .update(firings)
              .set({
                monitor: source.policy.kind === 'all' && !code ? 'all' : decision,
                ...(code && source.policy.kind === 'changes' ? { error: code } : {}),
              })
              .where(eq(firings.id, firing.id))
              .run();
          },
          { behavior: 'immediate' },
        ),
      );
    }
  }
  tick() {
    return this.cycle();
  }
  private async cycle() {
    await this.pollFiles();
    await this.exclusive(async () => {
      for (const row of this.active()) this.reconcile(row);
      this.db.transaction(
        () => {
          const now = this.clock();
          for (const row of this.db
            .select()
            .from(schedules)
            .where(and(eq(schedules.enabled, 1), eq(schedules.deleted, 0)))
            .all()) {
            if (this.options.runner.admit?.(String(row.bot)) === false) continue;
            const { input, record } = this.decode(row);
            if (input.rule.kind === 'file') continue;
            if (!this.monitoringSupported(row)) {
              this.pauseUnsupportedMonitor(row);
              continue;
            }
            if (Date.parse(record.scheduledAt) > now) continue;
            const due = this.domain.due(record, now);
            this.enqueue(row, `due-${digest(`${row.id}:${due.occurrenceAt}`)}`, due.occurrenceAt);
            this.db
              .update(schedules)
              .set({
                record: JSON.stringify({
                  ...record,
                  scheduledAt: due.nextScheduledAt || record.scheduledAt,
                }),
                enabled: due.nextScheduledAt ? 1 : 0,
              })
              .where(eq(schedules.id, String(row.id)))
              .run();
          }
        },
        { behavior: 'immediate' },
      );
      for (const row of this.db
        .select()
        .from(firings)
        .where(eq(firings.state, 'pending'))
        .orderBy(asc(firings.created), asc(inserted))
        .all()) {
        const bot = String(row.bot);
        if (this.options.runner.admit?.(bot) === false) continue;
        if (this.options.runner.running(bot)) continue;
        const live = this.db.select().from(schedules).where(eq(schedules.id, row.schedule)).get();
        if (!live || live.deleted) continue;
        if (!this.monitoringSupported(live)) {
          this.db.transaction(() => this.pauseUnsupportedMonitor(live), { behavior: 'immediate' });
          continue;
        }
        try {
          this.requireFiles(live);
        } catch (error) {
          this.observationFailure(live, error);
          continue;
        }
        // Commit the claim before model effects. Only a definite busy rejection is safe to requeue.
        if (
          !this.db
            .update(firings)
            .set({ state: 'claimed' })
            .where(and(eq(firings.id, String(row.id)), eq(firings.state, 'pending')))
            .run().changes
        )
          continue;
        try {
          await this.options.runner.start(
            bot,
            {
              requestId: `schedule-${row.id}`,
              prompt: String(row.prompt),
            },
            undefined,
            this.source(row),
          );
          this.reconcile(row, true);
        } catch (error) {
          const code = errorCode(error);
          if (this.options.runner.findRequest(bot, `schedule-${row.id}`)) this.reconcile(row, true);
          else
            this.db
              .update(firings)
              .set({
                state: [
                  'MODEL_ALREADY_RUNNING',
                  'BOT_CHANGING',
                  'RUNTIME_RECOVERY_PENDING',
                  'CHAT_CONFLICT',
                ].includes(code || '')
                  ? 'pending'
                  : 'interrupted',
                error: code || 'SCHEDULE_OUTCOME_UNKNOWN',
              })
              .where(eq(firings.id, String(row.id)))
              .run();
        }
      }
      this.failure = '';
    });
    await this.monitorResults();
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.failure = errorCode(error) || 'SCHEDULE_UNAVAILABLE';
      });
    }, 1000);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    this.closing = true;
    for (const sample of this.samples.values()) sample.abort();
    await Promise.allSettled([...this.observations]);
    this.samples.clear();
    await this.chain;
    await this.ready.catch(() => {});
    if (this.closed) return;
    this.closed = true;
    this.db?.$client.close();
  }
  async drain() {
    await this.chain.catch(() => {});
  }
}
