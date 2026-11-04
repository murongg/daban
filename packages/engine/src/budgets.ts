import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type BudgetPolicy,
  type BudgetPrice,
  type BudgetScope,
  type BudgetSettings,
  type BudgetView,
  defaultBudgetPolicy,
  type GoalResumeTarget,
  goalResumeKey,
  isBudgetPolicy,
  isBudgetPrice,
  isBudgetSettings,
  isBudgetView,
  isTokenUsage,
  type ReportedUsage,
  sameTranscriptScope,
  type TokenUsage,
  type TranscriptScope,
  type UsagePurpose,
  type UsageReceipt,
} from '@daban/protocol';
import { and, eq } from 'drizzle-orm';
import { GoalBudgets } from './budget-goals.js';
import { migrations } from './budgets-migrations.js';
import {
  budgetActions,
  budgetPrices,
  budgetReceipts,
  budgetRuns,
  budgetSettings,
  budgetTasks,
  budgetTools,
} from './budgets-schema.js';
import { configure, type Database, migrate } from './database.js';
import { costMicros } from './pricing.js';
import { privateMetadata, secureDirectory } from './private-files.js';

type Receipt = typeof budgetReceipts.$inferSelect;
export interface BudgetReservation {
  attemptId: string;
  runId: string;
  modelAttemptId: string;
  rootSessionId: string;
  sessionId: string;
  purpose: UsagePurpose;
  routeKey: string;
  auth: string;
  requestHash: string;
  reservedTokens: number;
  /** Only trusted, verified route bounds may turn on strict token/fee admission. */
  bounded?: boolean;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const policyKey = (p: BudgetPolicy) => [
  p.mode,
  p.toolLimit,
  p.activeMs,
  p.goalRounds,
  p.maxRequests,
  p.maxTokens,
  p.money?.currency,
  p.money?.limitMicros,
];
const priceKey = (p: BudgetPrice) => [
  p.id,
  p.routeKey,
  p.currency,
  p.createdAt,
  p.input,
  p.output,
  p.cacheRead,
  p.cacheWrite,
];
const zero = (): ReportedUsage => ({
  state: 'reported',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
function add(a: number, b: number) {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('BUDGET_OVERFLOW');
  return value;
}
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.includes('\0');
export class Budgets {
  readonly ready: Promise<unknown>;
  goals!: GoalBudgets;
  private db!: Database;
  private closed = false;
  constructor(readonly file: string) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    await secureDirectory(path.dirname(this.file));
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || !(await privateMetadata(this.file, info, 0o600)))
        throw new Error('BUDGET_STORE_UNSAFE');
    } finally {
      await handle.close();
    }
    const client = new DatabaseSync(this.file);
    try {
      configure(client, {
        journal: 'WAL',
        synchronous: 'FULL',
        foreignKeys: true,
        busyTimeout: 5000,
      });
      this.db = migrate(client, migrations);
      this.goals = new GoalBudgets(this.db, this);
      this.db.transaction(
        () => {
          this.db
            .insert(budgetSettings)
            .values({
              id: 1,
              scope: randomUUID(),
              revision: 0,
              policy: defaultBudgetPolicy,
              prices: [],
            })
            .onConflictDoNothing()
            .run();
          if (!this.db.select().from(budgetSettings).get()!.scope)
            this.db
              .update(budgetSettings)
              .set({ scope: randomUUID() })
              .where(eq(budgetSettings.id, 1))
              .run();
          this.db
            .update(budgetReceipts)
            .set({ phase: 'unknown', usage: { state: 'unknown', reason: 'HOST_RESTARTED' } })
            .where(eq(budgetReceipts.phase, 'dispatched'))
            .run();
          this.db
            .update(budgetReceipts)
            .set({ phase: 'released' })
            .where(eq(budgetReceipts.phase, 'reserved'))
            .run();
        },
        { behavior: 'immediate' },
      );
    } catch (error) {
      client.close();
      throw error;
    }
  }
  settings(): BudgetSettings {
    const row = this.db.select().from(budgetSettings).get();
    if (
      !row ||
      !text(row.scope) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      !isBudgetPolicy(row.policy) ||
      !Array.isArray(row.prices) ||
      row.prices.length > 200 ||
      !row.prices.every(isBudgetPrice)
    )
      throw new Error('BUDGET_STORE_CORRUPT');
    // Current adapters do not expose a verified bound for every provider billing bucket.
    return {
      scope: row.scope,
      revision: row.revision,
      policy: row.policy,
      prices: row.prices,
      strict: {
        requests: true,
        tokens: false,
        money: false,
        reason: 'TOKEN_AND_FEE_BOUNDS_UNVERIFIED',
      },
    };
  }
  configure(
    revision: number,
    policy: BudgetPolicy,
    prices: BudgetPrice[],
    command: string,
    scope?: string,
  ) {
    if (
      !isBudgetPolicy(policy) ||
      !Array.isArray(prices) ||
      prices.length > 200 ||
      !prices.every(isBudgetPrice) ||
      !text(command) ||
      new Set(prices.map((p) => p.routeKey)).size !== prices.length
    )
      throw new Error('INVALID_BUDGET_SETTINGS');
    if (policy.mode === 'strict' && (policy.maxTokens !== undefined || policy.money !== undefined))
      throw new Error('BUDGET_STRICT_UNAVAILABLE');
    return this.db.transaction(
      () => {
        const fingerprint = digest(['settings', revision, policyKey(policy), prices.map(priceKey)]);
        const prior = this.action(command, fingerprint);
        if (prior) {
          if (!isBudgetSettings(prior.result) || (scope && prior.result.scope !== scope))
            throw new Error('BUDGET_ACTION_CONFLICT');
          return prior.result;
        }
        const current = this.settings();
        if (scope && current.scope !== scope) throw new Error('BUDGET_OWNER_CONFLICT');
        if (revision !== current.revision) throw new Error('BUDGET_REVISION_CONFLICT');
        for (const price of prices) {
          const priorPrice = this.db
            .select()
            .from(budgetPrices)
            .where(eq(budgetPrices.id, price.id))
            .get();
          if (priorPrice && digest(priceKey(priorPrice.snapshot)) !== digest(priceKey(price)))
            throw new Error('BUDGET_PRICE_IMMUTABLE');
          this.db
            .insert(budgetPrices)
            .values({ id: price.id, snapshot: price })
            .onConflictDoNothing()
            .run();
        }
        this.db
          .update(budgetSettings)
          .set({ revision: revision + 1, policy, prices })
          .where(eq(budgetSettings.id, 1))
          .run();
        this.db
          .insert(budgetActions)
          .values({ id: command, fingerprint, result: this.settings() })
          .run();
        return this.settings();
      },
      { behavior: 'immediate' },
    );
  }
  private task(id: string) {
    const row = this.db.select().from(budgetTasks).where(eq(budgetTasks.id, id)).get();
    if (!row) throw new Error('BUDGET_NOT_FOUND');
    if (
      !isBudgetPolicy(row.policy) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !Array.isArray(row.prices) ||
      !row.prices.every(isBudgetPrice) ||
      !['active', 'limit-reached', 'usage-unknown', 'stopped', 'closed'].includes(row.state)
    )
      throw new Error('BUDGET_STORE_CORRUPT');
    return row;
  }
  private revision(scope: BudgetScope) {
    const task = this.task(scope.budgetId);
    if (task.revision !== scope.revision) throw new Error('BUDGET_REVISION_CONFLICT');
    return task;
  }
  ensure(root: string, policy?: BudgetPolicy, historyUnmetered = false): BudgetScope {
    if (!text(root) || (policy && !isBudgetPolicy(policy))) throw new Error('INVALID_BUDGET');
    return this.db.transaction(
      () => {
        const prior = this.db.select().from(budgetTasks).where(eq(budgetTasks.root, root)).get();
        if (prior) {
          this.task(prior.id);
          if (historyUnmetered && prior.policy.mode === 'strict')
            throw new Error('BUDGET_HISTORY_UNMETERED');
          if (historyUnmetered && !prior.historyUnmetered)
            this.db
              .update(budgetTasks)
              .set({ historyUnmetered: true })
              .where(eq(budgetTasks.id, prior.id))
              .run();
          return { budgetId: prior.id, revision: prior.revision };
        }
        const settings = this.settings();
        if (historyUnmetered && (policy ?? settings.policy).mode === 'strict')
          throw new Error('BUDGET_HISTORY_UNMETERED');
        const id = randomUUID();
        this.db
          .insert(budgetTasks)
          .values({
            id,
            root,
            revision: 1,
            policy: policy ?? settings.policy,
            prices: settings.prices,
            historyUnmetered,
            state: 'active',
          })
          .run();
        return { budgetId: id, revision: 1 };
      },
      { behavior: 'immediate' },
    );
  }
  bind(scope: BudgetScope, run: string) {
    this.revision(scope);
    const prior = this.db.select().from(budgetRuns).where(eq(budgetRuns.id, run)).get();
    if (prior && prior.budget !== scope.budgetId) throw new Error('BUDGET_OWNER_CONFLICT');
    this.db
      .insert(budgetRuns)
      .values({ id: run, budget: scope.budgetId })
      .onConflictDoNothing()
      .run();
  }
  private receipt(id: string) {
    const row = this.db.select().from(budgetReceipts).where(eq(budgetReceipts.id, id)).get();
    if (!row) throw new Error('BUDGET_ATTEMPT_NOT_FOUND');
    return row;
  }
  private project(row: Receipt): UsageReceipt {
    return {
      attemptId: row.id,
      scope: { budgetId: row.budget, revision: row.revision },
      runId: row.run,
      modelAttemptId: row.modelAttempt,
      rootSessionId: row.rootSession,
      sessionId: row.session,
      purpose: row.purpose,
      routeKey: row.route,
      phase: row.phase,
      reservedTokens: row.tokens,
      ...(row.micros === null ? {} : { reservedMicros: row.micros }),
      ...(row.estimated === null ? {} : { estimatedMicros: row.estimated }),
      ...(row.price ? { price: row.price } : {}),
      ...(row.usage ? { usage: row.usage } : {}),
      createdAt: row.created,
    };
  }
  view(id: string): BudgetView {
    const task = this.task(id);
    const rows = this.db.select().from(budgetReceipts).where(eq(budgetReceipts.budget, id)).all();
    const view: BudgetView = {
      scope: { budgetId: id, revision: task.revision },
      rootId: task.root,
      policy: task.policy,
      state: task.state,
      historyUnmetered: task.historyUnmetered,
      availability:
        !task.historyUnmetered &&
        this.db
          .select()
          .from(budgetRuns)
          .where(eq(budgetRuns.budget, id))
          .all()
          .every(
            (r) => Object.keys(r.coverage).length > 0 && Object.values(r.coverage).every(Boolean),
          )
          ? 'recorded'
          : 'partial',
      requests: 0,
      reported: zero(),
      reservedTokens: 0,
      unknownCount: 0,
      unknownCostCount: 0,
      warned: task.warned,
      receipts: rows.slice(-2000).map((r) => this.project(r)),
    };
    let estimated = 0,
      reserved = 0,
      knownCosts = 0,
      knownReserves = 0;
    for (const row of rows) {
      if (row.phase === 'released') continue;
      view.requests++;
      if (row.phase === 'settled' && row.usage?.state === 'reported') {
        for (const key of [
          'inputTokens',
          'outputTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
        ] as const)
          view.reported[key] = add(view.reported[key], row.usage[key]);
        if (row.estimated !== null) {
          estimated = add(estimated, row.estimated);
          knownCosts++;
        } else view.unknownCostCount++;
      } else {
        view.reservedTokens = add(view.reservedTokens, row.tokens);
        if (row.micros !== null) {
          reserved = add(reserved, row.micros);
          knownReserves++;
        }
        if (row.phase === 'unknown') view.unknownCount++;
        if (row.micros === null || row.phase === 'unknown') view.unknownCostCount++;
      }
    }
    const currencies = new Set(
      rows.filter((r) => r.phase !== 'released' && r.price).map((r) => r.price!.currency),
    );
    if (currencies.size === 1) {
      view.currency = [...currencies][0];
      if (knownCosts) view.estimatedMicros = estimated;
      if (knownReserves) view.reservedMicros = reserved;
    }
    return view;
  }
  reserve(scope: BudgetScope, input: BudgetReservation) {
    if (
      ![
        input.attemptId,
        input.runId,
        input.modelAttemptId,
        input.rootSessionId,
        input.sessionId,
        input.routeKey,
        input.auth,
      ].every(text) ||
      !/^[a-f0-9]{64}$/.test(input.requestHash) ||
      !Number.isSafeInteger(input.reservedTokens) ||
      input.reservedTokens < 0 ||
      !['main', 'subtask', 'compaction', 'review', 'fallback', 'session-title'].includes(
        input.purpose,
      )
    )
      throw new Error('INVALID_BUDGET_ATTEMPT');
    const fingerprint = digest([
      scope.budgetId,
      scope.revision,
      input.attemptId,
      input.runId,
      input.modelAttemptId,
      input.rootSessionId,
      input.sessionId,
      input.purpose,
      input.routeKey,
      input.auth,
      input.requestHash,
      input.reservedTokens,
      input.bounded === true,
    ]);
    const result = this.db.transaction(
      () => {
        const prior = this.db
          .select()
          .from(budgetReceipts)
          .where(eq(budgetReceipts.id, input.attemptId))
          .get();
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error('BUDGET_ATTEMPT_CONFLICT');
          return this.project(prior);
        }
        const task = this.revision(scope);
        if (task.state !== 'active')
          throw new Error(`BUDGET_${task.state.replaceAll('-', '_').toUpperCase()}`);
        const active = this.db
          .select()
          .from(budgetRuns)
          .where(eq(budgetRuns.budget, task.id))
          .all()
          .reduce((sum, run) => add(sum, run.activeMs), task.activeAdjustment);
        if (active >= task.policy.activeMs) {
          this.db
            .update(budgetTasks)
            .set({ state: 'limit-reached' })
            .where(eq(budgetTasks.id, task.id))
            .run();
          return 'BUDGET_TIME_LIMIT' as const;
        }
        const view = this.view(task.id);
        const price = task.prices.find(
          (p) =>
            p.routeKey === input.routeKey &&
            (!task.policy.money || p.currency === task.policy.money.currency),
        );
        // Unknown cache buckets reserve at the highest input price, never an unearned discount.
        const micros = price
          ? costMicros(
              {
                inputTokens: input.reservedTokens,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
              {
                ...price,
                input: Math.max(price.input, price.output, price.cacheRead, price.cacheWrite),
              },
            )
          : undefined;
        const policy = task.policy;
        if (policy.mode === 'strict') {
          if (
            (policy.maxTokens !== undefined || policy.money) &&
            (!input.bounded || (!price && policy.money))
          )
            throw new Error('BUDGET_STRICT_UNAVAILABLE');
          const denied =
            (policy.maxRequests !== undefined && view.requests + 1 > policy.maxRequests) ||
            (policy.maxTokens !== undefined &&
              add(
                add(view.reported.inputTokens, view.reported.outputTokens),
                add(view.reservedTokens, input.reservedTokens),
              ) > policy.maxTokens) ||
            (policy.money &&
              (micros === undefined ||
                add(add(view.estimatedMicros ?? 0, view.reservedMicros ?? 0), micros) >
                  policy.money.limitMicros));
          if (denied) {
            this.db
              .update(budgetTasks)
              .set({ state: 'limit-reached' })
              .where(eq(budgetTasks.id, task.id))
              .run();
            return 'BUDGET_LIMIT_REACHED' as const;
          }
        }
        this.db
          .insert(budgetReceipts)
          .values({
            id: input.attemptId,
            budget: task.id,
            revision: scope.revision,
            run: input.runId,
            modelAttempt: input.modelAttemptId,
            session: input.sessionId,
            rootSession: input.rootSessionId,
            purpose: input.purpose,
            route: input.routeKey,
            auth: input.auth,
            fingerprint,
            phase: 'reserved',
            tokens: input.reservedTokens,
            ...(micros === undefined ? {} : { micros }),
            price,
            created: new Date().toISOString(),
          })
          .run();
        this.warn(task.id);
        return this.project(this.receipt(input.attemptId));
      },
      { behavior: 'immediate' },
    );
    if (typeof result === 'string') throw new Error(result);
    return result;
  }
  dispatch(
    scope: BudgetScope,
    id: string,
    owner?: Pick<BudgetReservation, 'runId' | 'modelAttemptId' | 'auth'>,
  ) {
    return this.db.transaction(
      () => {
        this.revision(scope);
        const row = this.receipt(id);
        if (
          row.budget !== scope.budgetId ||
          row.revision !== scope.revision ||
          (owner &&
            (row.run !== owner.runId ||
              row.modelAttempt !== owner.modelAttemptId ||
              row.auth !== owner.auth))
        )
          throw new Error('BUDGET_OWNER_CONFLICT');
        if (row.phase !== 'reserved') return false;
        // Commit the single-use send claim before returning. A lost acknowledgement is unknown, never permission to resend.
        return (
          this.db
            .update(budgetReceipts)
            .set({ phase: 'dispatched' })
            .where(and(eq(budgetReceipts.id, id), eq(budgetReceipts.phase, 'reserved')))
            .run().changes === 1
        );
      },
      { behavior: 'immediate' },
    );
  }
  report(id: string, usage: TokenUsage, run: string, auth: string, scope?: BudgetScope) {
    return this.db.transaction(
      () => {
        const row = this.receipt(id);
        if (scope && (row.budget !== scope.budgetId || row.revision !== scope.revision))
          throw new Error('BUDGET_OWNER_CONFLICT');
        if (row.run !== run || row.auth !== auth) throw new Error('BUDGET_OWNER_CONFLICT');
        const valid: TokenUsage = isTokenUsage(usage)
          ? usage
          : { state: 'unknown', reason: 'INVALID_PROVIDER_USAGE' };
        if (row.phase === 'settled') {
          if (digest(row.usage) !== digest(valid)) throw new Error('BUDGET_RECEIPT_CONFLICT');
          return this.project(row);
        }
        if (!['dispatched', 'unknown'].includes(row.phase))
          throw new Error('BUDGET_NOT_DISPATCHED');
        const estimated =
          valid.state === 'reported' && row.price ? costMicros(valid, row.price) : null;
        this.db
          .update(budgetReceipts)
          .set({
            phase: valid.state === 'reported' ? 'settled' : 'unknown',
            usage: valid,
            estimated,
          })
          .where(eq(budgetReceipts.id, id))
          .run();
        const task = this.task(row.budget);
        if (
          valid.state === 'unknown' &&
          task.policy.mode === 'strict' &&
          (task.policy.maxTokens !== undefined || task.policy.money)
        )
          this.db
            .update(budgetTasks)
            .set({ state: 'usage-unknown' })
            .where(eq(budgetTasks.id, row.budget))
            .run();
        this.warn(row.budget);
        return this.project(this.receipt(id));
      },
      { behavior: 'immediate' },
    );
  }
  private warn(id: string) {
    const view = this.view(id),
      p = view.policy;
    // Known reservations can reach the warning before settlement; unknown costs remain absent in the view.
    const ratio = Math.max(
      p.maxRequests ? view.requests / p.maxRequests : 0,
      p.maxTokens
        ? (view.reported.inputTokens + view.reported.outputTokens + view.reservedTokens) /
            p.maxTokens
        : 0,
      p.money &&
        view.currency === p.money.currency &&
        (view.estimatedMicros !== undefined || view.reservedMicros !== undefined)
        ? ((view.estimatedMicros ?? 0) + (view.reservedMicros ?? 0)) / p.money.limitMicros
        : 0,
    );
    if (!view.warned && ratio >= 0.8)
      this.db.update(budgetTasks).set({ warned: true }).where(eq(budgetTasks.id, id)).run();
  }
  private action(id: string, fingerprint: string) {
    const prior = this.db.select().from(budgetActions).where(eq(budgetActions.id, id)).get();
    if (prior && prior.fingerprint !== fingerprint) throw new Error('BUDGET_ACTION_CONFLICT');
    return prior;
  }
  increase(
    id: string,
    revision: number,
    policy: BudgetPolicy,
    command: string,
    admit: () => boolean = () => true,
    owner?: TranscriptScope,
    goalResume?: GoalResumeTarget,
  ) {
    if (!isBudgetPolicy(policy) || !text(command)) throw new Error('INVALID_BUDGET_POLICY');
    if (policy.mode === 'strict' && (policy.maxTokens !== undefined || policy.money))
      throw new Error('BUDGET_STRICT_UNAVAILABLE');
    return this.db.transaction(
      () => {
        const fingerprint = digest([
          id,
          revision,
          policyKey(policy),
          owner ? [owner.bot, owner.runId, owner.conversationId, owner.chatRevision] : null,
          goalResumeKey(goalResume),
        ]);
        const prior = this.action(command, fingerprint);
        if (prior) return prior.result as BudgetView;
        if (!admit()) throw new Error('BUDGET_TASK_RUNNING');
        const task = this.revision({ budgetId: id, revision });
        const p = task.policy;
        if (
          policy.mode !== p.mode ||
          policy.toolLimit < p.toolLimit ||
          policy.activeMs < p.activeMs ||
          policy.goalRounds !== p.goalRounds ||
          (p.maxRequests !== undefined &&
            policy.maxRequests !== undefined &&
            policy.maxRequests < p.maxRequests) ||
          (p.maxTokens !== undefined &&
            policy.maxTokens !== undefined &&
            policy.maxTokens < p.maxTokens) ||
          (p.money &&
            (!policy.money ||
              policy.money.currency !== p.money.currency ||
              policy.money.limitMicros < p.money.limitMicros))
        )
          throw new Error('BUDGET_INCREASE_REQUIRED');
        this.db
          .update(budgetTasks)
          .set({ revision: revision + 1, policy, state: 'stopped' })
          .where(eq(budgetTasks.id, id))
          .run();
        this.db
          .update(budgetReceipts)
          .set({ phase: 'released' })
          .where(and(eq(budgetReceipts.budget, id), eq(budgetReceipts.phase, 'reserved')))
          .run();
        const result = {
          ...this.view(id),
          ...(owner ? { owner: structuredClone(owner) } : {}),
          ...(goalResume
            ? {
                goalResume: {
                  ...structuredClone(goalResume),
                  budget: { budgetId: id, revision: revision + 1 },
                },
              }
            : {}),
        };
        this.db.insert(budgetActions).values({ id: command, fingerprint, result }).run();
        return result;
      },
      { behavior: 'immediate' },
    );
  }
  continuationReceipt(scope: BudgetScope, id: string, owner?: TranscriptScope) {
    const row = this.db.select().from(budgetActions).where(eq(budgetActions.id, id)).get();
    if (
      !row ||
      !isBudgetView(row.result) ||
      row.result.scope.budgetId !== scope.budgetId ||
      row.result.scope.revision !== scope.revision ||
      (owner && (!row.result.owner || !sameTranscriptScope(row.result.owner, owner)))
    )
      throw new Error('BUDGET_CONTINUE_UNACCEPTED');
    return row.result;
  }
  continuation(scope: BudgetScope, id: string, owner?: TranscriptScope) {
    this.revision(scope);
    this.continuationReceipt(scope, id, owner);
    return this.view(scope.budgetId);
  }
  activate(scope: BudgetScope, id: string, owner?: TranscriptScope) {
    return this.db.transaction(
      () => {
        const current = this.continuation(scope, id, owner);
        if (!['active', 'stopped'].includes(current.state)) throw new Error('BUDGET_LIMIT_REACHED');
        // Changing quota does not resume a queued group. Only the separately accepted Continue action releases admission.
        this.db
          .update(budgetTasks)
          .set({ state: 'active' })
          .where(eq(budgetTasks.id, scope.budgetId))
          .run();
        return this.view(scope.budgetId);
      },
      { behavior: 'immediate' },
    );
  }
  coverage(run: string, attempt: string, complete: boolean) {
    const row = this.db.select().from(budgetRuns).where(eq(budgetRuns.id, run)).get();
    if (!row || !text(attempt)) throw new Error('BUDGET_OWNER_CONFLICT');
    this.db
      .update(budgetRuns)
      .set({ coverage: { ...row.coverage, [attempt]: complete } })
      .where(eq(budgetRuns.id, run))
      .run();
  }
  finishRun(run: string) {
    this.db
      .update(budgetReceipts)
      .set({ phase: 'unknown', usage: { state: 'unknown', reason: 'RUN_ENDED_WITHOUT_USAGE' } })
      .where(and(eq(budgetReceipts.run, run), eq(budgetReceipts.phase, 'dispatched')))
      .run();
  }
  tool(scope: BudgetScope, id: string) {
    return this.db.transaction(
      () => {
        const task = this.revision(scope);
        const prior = this.db.select().from(budgetTools).where(eq(budgetTools.id, id)).get();
        if (prior) {
          if (prior.budget !== task.id) throw new Error('BUDGET_OWNER_CONFLICT');
          return;
        }
        if (task.state !== 'active' || this.tools(task.id) >= task.policy.toolLimit)
          throw new Error('BUDGET_TOOL_LIMIT');
        this.db.insert(budgetTools).values({ id, budget: task.id }).run();
      },
      { behavior: 'immediate' },
    );
  }
  tools(id: string) {
    return (
      this.task(id).toolAdjustment +
      this.db.select().from(budgetTools).where(eq(budgetTools.budget, id)).all().length
    );
  }
  runs(id: string) {
    return this.db
      .select()
      .from(budgetRuns)
      .where(eq(budgetRuns.budget, id))
      .all()
      .map((row) => row.id);
  }
  reconcileOwner(scope: BudgetScope, tools: number, activeMs: number) {
    if (![tools, activeMs].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new Error('BUDGET_OVERFLOW');
    const task = this.revision(scope);
    const knownTools = this.tools(task.id);
    const knownTime = this.db
      .select()
      .from(budgetRuns)
      .where(eq(budgetRuns.budget, task.id))
      .all()
      .reduce((sum, row) => add(sum, row.activeMs), task.activeAdjustment);
    this.db
      .update(budgetTasks)
      .set({
        toolAdjustment: add(task.toolAdjustment, Math.max(0, tools - knownTools)),
        activeAdjustment: add(task.activeAdjustment, Math.max(0, activeMs - knownTime)),
      })
      .where(eq(budgetTasks.id, task.id))
      .run();
  }
  time(run: string, used: number, priorOwner = 0) {
    if (![used, priorOwner].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new Error('INVALID_BUDGET_TIME');
    const row = this.db.select().from(budgetRuns).where(eq(budgetRuns.id, run)).get();
    if (!row) throw new Error('BUDGET_OWNER_CONFLICT');
    const adjustment = this.task(row.budget).activeAdjustment;
    const others = this.db
      .select()
      .from(budgetRuns)
      .where(eq(budgetRuns.budget, row.budget))
      .all()
      .filter((run) => run.id !== row.id)
      .reduce((sum, run) => add(sum, run.activeMs), adjustment);
    // Keep the original owner's conservative crash charge as well as ledger time from later retries of an older ancestor.
    const charged = add(used, Math.max(0, priorOwner - others));
    if (charged > row.activeMs)
      this.db.update(budgetRuns).set({ activeMs: charged }).where(eq(budgetRuns.id, run)).run();
    return this.db
      .select()
      .from(budgetRuns)
      .where(eq(budgetRuns.budget, row.budget))
      .all()
      .reduce((sum, r) => add(sum, r.activeMs), adjustment);
  }
  close() {
    if (!this.closed && this.db) {
      this.closed = true;
      this.db.$client.close();
    }
  }
}
