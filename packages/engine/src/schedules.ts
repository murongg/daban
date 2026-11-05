import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type AutomationSource,
  isAutomationSource,
  isScheduleInput,
  isSchedulePatch,
  isScheduleRule,
  type Schedule,
  validAgentId,
} from '@daban/protocol';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { errorCode, Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';
import { nativeSchedules, type ScheduleDomain } from './schedule-domain.js';
import { migrations } from './schedules-migrations.js';
import { firings, schedules } from './schedules-schema.js';

export type { ScheduleDomain } from './schedule-domain.js';

interface Runner {
  running(bot: string): boolean;
  admit?(bot: string): boolean;
  findRequest(
    bot: string,
    id: string,
  ): { runId: string; phase: string; error?: string } | undefined;
  start(
    bot: string,
    task: { requestId: string; prompt: string },
    conversation?: undefined,
    source?: AutomationSource,
  ): Promise<unknown>;
}
type Row = typeof schedules.$inferSelect;
type Firing = typeof firings.$inferSelect;

function legacy(client: DatabaseSync) {
  client.exec(`CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, bot TEXT NOT NULL, input TEXT NOT NULL, record TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS firings (id TEXT PRIMARY KEY, schedule TEXT NOT NULL, bot TEXT NOT NULL, occurrence TEXT NOT NULL, created TEXT NOT NULL, state TEXT NOT NULL, prompt TEXT NOT NULL, run TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS firing_schedule ON firings(schedule,created);
    CREATE INDEX IF NOT EXISTS firing_pending ON firings(state,created);`);
}

// SQLite's implicit insertion order breaks ties between firings created in the same millisecond.
const inserted = sql`rowid`;
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
  private failure = '';
  private readonly clock: () => number;
  constructor(
    readonly options: {
      file: string;
      runner: Runner;
      clock?: () => number;
      domain?: Promise<ScheduleDomain>;
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
    this.db.transaction(
      () => {
        for (const row of this.db.select().from(schedules).all()) {
          const input: unknown = JSON.parse(row.input);
          if (
            input &&
            typeof input === 'object' &&
            'rule' in input &&
            input.rule &&
            typeof input.rule === 'object' &&
            'kind' in input.rule &&
            input.rule.kind === 'file'
          ) {
            // Retire obsolete triggers without erasing their saved input or uncertain execution receipts.
            if (!row.deleted || row.enabled)
              this.db
                .update(schedules)
                .set({ enabled: 0, deleted: 1, revision: sql`${schedules.revision} + 1` })
                .where(eq(schedules.id, row.id))
                .run();
            this.cancelPending(row.id);
          } else this.decode(row);
        }
      },
      { behavior: 'immediate' },
    );
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
  private decode(row: Row) {
    try {
      const input: unknown = JSON.parse(String(row.input));
      if (!isScheduleInput(input) || input.id !== row.id || input.bot !== row.bot)
        throw new Error('invalid schedule');
      const record = this.domain.decode(JSON.parse(String(row.record)));
      if (record.id !== row.id || !Number.isFinite(Date.parse(record.scheduledAt)))
        throw new Error('invalid native schedule');
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
      ...(row.enabled === 1 ? { nextRunAt: record.scheduledAt } : {}),
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
      enabled: value.enabled ?? true,
      locked: value.locked ?? false,
    };
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
            record = this.domain.create(input, now),
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
          if (next.enabled) this.requireAdmission(input.bot);
          if (encoded(next) === encoded({ ...input, enabled: row.enabled === 1 }))
            return this.view(row);
          if (next.enabled && row.enabled !== 1 && this.live(input.bot, true) >= 20)
            throw new Fault('SCHEDULE_LIMIT');
          // Editing a name or instruction must not move an already committed wall-clock target.
          const reset =
            (changes.rule !== undefined && encoded(changes.rule) !== encoded(input.rule)) ||
            (next.enabled && row.enabled !== 1);
          const target = reset
            ? this.domain.create(next, this.clock())
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
          if (Object.keys(changes).some((key) => key !== 'locked')) this.cancelPending(id);
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
          return { id, removed: true };
        },
        { behavior: 'immediate' },
      ),
    );
  }
  private enqueue(row: Row, id: string, occurrence: string, trigger: 'time' | 'manual' = 'time') {
    const existing = this.firingRow(id);
    if (existing) return this.firing(existing);
    const { input } = this.decode(row);
    const pending = this.db
      .select({ id: firings.id })
      .from(firings)
      .where(and(eq(firings.schedule, input.id), eq(firings.state, 'pending')))
      .get();
    const prompt = `This is the user’s previously saved scheduled task: ${input.title}.\nScheduled trigger time: ${occurrence}.\nExecute the following instructions under the actual conditions of this turn. Ask if required input is missing, and do not claim completion based on history:\n${input.prompt}`;
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
        source: JSON.stringify({
          scheduleId: row.id,
          firingId: id,
          configRevision: row.revision,
          trigger,
          policy: { kind: 'all' },
        } satisfies AutomationSource),
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
      })
      .where(eq(firings.id, String(row.id)))
      .run();
  }
  tick() {
    return this.exclusive(async () => {
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
            const { record } = this.decode(row);
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
        const owner = this.db.select().from(schedules).where(eq(schedules.id, row.schedule)).get();
        if (!owner || owner.deleted) continue;
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
          const source: unknown = row.source ? JSON.parse(row.source) : undefined;
          if (source !== undefined && !isAutomationSource(source))
            throw new Fault('SCHEDULE_CORRUPT');
          await this.options.runner.start(
            bot,
            {
              requestId: `schedule-${row.id}`,
              prompt: String(row.prompt),
            },
            undefined,
            source,
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
