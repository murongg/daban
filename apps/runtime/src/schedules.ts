import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isScheduleInput,
  isSchedulePatch,
  isScheduleRule,
  type Schedule,
  validAgentId,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { nativeSchedules, type ScheduleDomain } from './schedule-domain.js';

export type { ScheduleDomain } from './schedule-domain.js';

interface Runner {
  running(bot: string): boolean;
  admit?(bot: string): boolean;
  findRequest(
    bot: string,
    id: string,
  ): { runId: string; phase: string; error?: string } | undefined;
  start(bot: string, task: { requestId: string; prompt: string }): Promise<unknown>;
}
type Row = Record<string, unknown>;
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
  private db!: DatabaseSync;
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
    this.db = new DatabaseSync(this.options.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, bot TEXT NOT NULL, input TEXT NOT NULL, record TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS firings (id TEXT PRIMARY KEY, schedule TEXT NOT NULL, bot TEXT NOT NULL, occurrence TEXT NOT NULL, created TEXT NOT NULL, state TEXT NOT NULL, prompt TEXT NOT NULL, run TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS firing_schedule ON firings(schedule,created);
      CREATE INDEX IF NOT EXISTS firing_pending ON firings(state,created);`);
    for (const row of this.db.prepare('SELECT * FROM schedules').all()) this.decode(row);
    // A prior claim may have started the model before crashing. Inspect its receipt; never issue it again.
    for (const row of this.db
      .prepare("SELECT * FROM firings WHERE state IN ('claimed','running')")
      .all())
      this.reconcile(row, true);
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
  private transaction<T>(action: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private row(id: string, actor?: ScheduleActor, write = false) {
    actor?.signal?.throwIfAborted();
    const row = this.db.prepare('SELECT * FROM schedules WHERE id=? AND deleted=0').get(id);
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
        .prepare('SELECT * FROM firings WHERE schedule=? ORDER BY created DESC,rowid DESC LIMIT 20')
        .all(String(row.id))
        .map((firing) => this.firing(firing)),
    };
  }
  private firing(row: Row): Schedule['history'][number] {
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
      (actor
        ? this.db
            .prepare('SELECT * FROM schedules WHERE deleted=0 AND bot=? ORDER BY created,id')
            .all(actor.bot)
        : this.db.prepare('SELECT * FROM schedules WHERE deleted=0 ORDER BY created,id').all()
      ).map((row) => this.view(row)),
    );
  }
  suspendBot(bot: string) {
    if (!validAgentId(bot)) return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    return this.exclusive(() =>
      this.transaction(() => {
        const rows = this.db
          .prepare('SELECT * FROM schedules WHERE bot=? AND enabled=1 AND deleted=0')
          .all(bot);
        const stamp = new Date(this.clock()).toISOString();
        for (const row of rows) {
          const { input } = this.decode(row);
          // Human archive also pauses locked plans; it preserves their locks, definitions and due targets.
          this.db
            .prepare(
              'UPDATE schedules SET input=?,enabled=0,revision=revision+1,updated=? WHERE id=?',
            )
            .run(encoded({ ...input, enabled: false }), stamp, String(row.id));
        }
        const cancelled = this.db
          .prepare(
            "UPDATE firings SET state='cancelled',error='BOT_ARCHIVED' WHERE bot=? AND state='pending'",
          )
          .run(bot).changes;
        return { disabled: rows.length, cancelled: Number(cancelled) };
      }),
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
      this.transaction(() => {
        actor?.signal?.throwIfAborted();
        if (actor && input.bot !== actor.bot) throw new Fault('SCHEDULE_NOT_FOUND', 404);
        if (actor && input.locked) throw new Fault('SCHEDULE_LOCKED');
        const prior = this.db.prepare('SELECT * FROM schedules WHERE id=?').get(input.id);
        if (prior) {
          if (actor && prior.bot !== actor.bot) throw new Fault('SCHEDULE_NOT_FOUND', 404);
          if (actor && this.decode(prior).input.locked) throw new Fault('SCHEDULE_LOCKED');
          if (prior.deleted || encoded(this.decode(prior).input) !== encoded(input))
            throw new Fault('SCHEDULE_ID_REUSED');
          return this.view(prior);
        }
        if (input.enabled) this.requireAdmission(input.bot);
        if (
          Number(
            this.db
              .prepare('SELECT COUNT(*) AS count FROM schedules WHERE bot=? AND deleted=0')
              .get(input.bot)?.count,
          ) >= 100 ||
          (input.enabled &&
            Number(
              this.db
                .prepare(
                  'SELECT COUNT(*) AS count FROM schedules WHERE bot=? AND enabled=1 AND deleted=0',
                )
                .get(input.bot)?.count,
            ) >= 20)
        )
          throw new Fault('SCHEDULE_LIMIT');
        const now = this.clock(),
          record = this.domain.create(input, now),
          stamp = new Date(now).toISOString();
        this.db
          .prepare(
            'INSERT INTO schedules(id,bot,input,record,revision,enabled,created,updated) VALUES(?,?,?,?,1,?,?,?)',
          )
          .run(
            input.id,
            input.bot,
            encoded(input),
            JSON.stringify(record),
            input.enabled ? 1 : 0,
            stamp,
            stamp,
          );
        return this.view(this.row(input.id));
      }),
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
      this.transaction(() => {
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
        if (
          next.enabled &&
          row.enabled !== 1 &&
          Number(
            this.db
              .prepare(
                'SELECT COUNT(*) AS count FROM schedules WHERE bot=? AND enabled=1 AND deleted=0',
              )
              .get(input.bot)?.count,
          ) >= 20
        )
          throw new Fault('SCHEDULE_LIMIT');
        // Editing a name or instruction must not move an already committed wall-clock target.
        const reset =
          (changes.rule !== undefined && encoded(changes.rule) !== encoded(input.rule)) ||
          (next.enabled && row.enabled !== 1);
        const target = reset
          ? this.domain.create(next, this.clock())
          : { ...record, title: next.title, prompt: next.prompt };
        this.db
          .prepare(
            'UPDATE schedules SET input=?,record=?,revision=revision+1,enabled=?,updated=? WHERE id=?',
          )
          .run(
            encoded(next),
            JSON.stringify(target),
            next.enabled ? 1 : 0,
            new Date(this.clock()).toISOString(),
            id,
          );
        if (Object.keys(changes).some((key) => key !== 'locked'))
          this.db
            .prepare("UPDATE firings SET state='cancelled' WHERE schedule=? AND state='pending'")
            .run(id);
        return this.view(this.row(id));
      }),
    );
  }
  remove(id: string, revision: number, actor?: ScheduleActor) {
    if (!validAgentId(id) || !Number.isSafeInteger(revision) || revision < 1)
      return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    return this.exclusive(() =>
      this.transaction(() => {
        const row = this.row(id, actor, true);
        if (row.revision !== revision) throw new Fault('SCHEDULE_CONFLICT');
        this.db
          .prepare('UPDATE schedules SET deleted=1,enabled=0,revision=revision+1 WHERE id=?')
          .run(id);
        this.db
          .prepare("UPDATE firings SET state='cancelled' WHERE schedule=? AND state='pending'")
          .run(id);
        return { id, removed: true };
      }),
    );
  }
  private enqueue(row: Row, id: string, occurrence: string) {
    const existing = this.db.prepare('SELECT * FROM firings WHERE id=?').get(id);
    if (existing) return this.firing(existing);
    const { input } = this.decode(row);
    const pending = this.db
      .prepare("SELECT id FROM firings WHERE schedule=? AND state='pending'")
      .get(input.id);
    const prompt = `这是用户预先保存的定时任务「${input.title}」。\n计划触发时间：${occurrence}。\n按本轮实际条件执行以下任务说明，缺少输入时提问，不要凭历史声称已经完成：\n${input.prompt}`;
    this.db
      .prepare(
        'INSERT INTO firings(id,schedule,bot,occurrence,created,state,prompt) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.id,
        input.bot,
        occurrence,
        new Date(this.clock()).toISOString(),
        pending ? 'coalesced' : 'pending',
        prompt,
      );
    return this.firing(this.db.prepare('SELECT * FROM firings WHERE id=?').get(id)!);
  }
  run(id: string, requestId: string) {
    if (!validAgentId(id) || !validAgentId(requestId))
      return Promise.reject(new Fault('INVALID_SCHEDULE', 400));
    return this.exclusive(() =>
      this.transaction(() => {
        const key = `manual-${digest(`${id}:${requestId}`)}`;
        const previous = this.db.prepare('SELECT * FROM firings WHERE id=?').get(key);
        if (previous) return this.firing(previous);
        const row = this.row(id);
        this.requireAdmission(String(row.bot));
        return this.enqueue(row, key, new Date(this.clock()).toISOString());
      }),
    );
  }
  private reconcile(row: Row, recovering = false) {
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
      .prepare('UPDATE firings SET state=?,run=?,error=? WHERE id=?')
      .run(
        state,
        receipt?.runId || null,
        receipt?.error?.slice(0, 1000) || (!receipt ? 'SCHEDULE_OUTCOME_UNKNOWN' : null),
        String(row.id),
      );
  }
  tick() {
    return this.exclusive(async () => {
      for (const row of this.db
        .prepare("SELECT * FROM firings WHERE state IN ('claimed','running')")
        .all())
        this.reconcile(row);
      this.transaction(() => {
        const now = this.clock();
        for (const row of this.db
          .prepare('SELECT * FROM schedules WHERE enabled=1 AND deleted=0')
          .all()) {
          if (this.options.runner.admit?.(String(row.bot)) === false) continue;
          const { record } = this.decode(row);
          if (Date.parse(record.scheduledAt) > now) continue;
          const due = this.domain.due(record, now);
          this.enqueue(row, `due-${digest(`${row.id}:${due.occurrenceAt}`)}`, due.occurrenceAt);
          this.db
            .prepare('UPDATE schedules SET record=?,enabled=? WHERE id=?')
            .run(
              JSON.stringify({ ...record, scheduledAt: due.nextScheduledAt || record.scheduledAt }),
              due.nextScheduledAt ? 1 : 0,
              String(row.id),
            );
        }
      });
      for (const row of this.db
        .prepare("SELECT * FROM firings WHERE state='pending' ORDER BY created,rowid")
        .all()) {
        const bot = String(row.bot);
        if (this.options.runner.admit?.(bot) === false) continue;
        if (this.options.runner.running(bot)) continue;
        // Commit the claim before model effects. Only a definite busy rejection is safe to requeue.
        if (
          !this.db
            .prepare("UPDATE firings SET state='claimed' WHERE id=? AND state='pending'")
            .run(String(row.id)).changes
        )
          continue;
        try {
          await this.options.runner.start(bot, {
            requestId: `schedule-${row.id}`,
            prompt: String(row.prompt),
          });
          this.reconcile(row, true);
        } catch (error) {
          const code = errorCode(error);
          if (this.options.runner.findRequest(bot, `schedule-${row.id}`)) this.reconcile(row, true);
          else
            this.db
              .prepare('UPDATE firings SET state=?,error=? WHERE id=?')
              .run(
                [
                  'MODEL_ALREADY_RUNNING',
                  'BOT_CHANGING',
                  'RUNTIME_RECOVERY_PENDING',
                  'CHAT_CONFLICT',
                ].includes(code || '')
                  ? 'pending'
                  : 'interrupted',
                code || 'SCHEDULE_OUTCOME_UNKNOWN',
                String(row.id),
              );
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
    this.db?.close();
  }
  async drain() {
    await this.chain.catch(() => {});
  }
}
