import { createHash, randomUUID } from 'node:crypto';
import {
  type DeliveryAttempt,
  type DeliveryChecklist,
  type DeliveryChecklistWrite,
  type DeliveryDecision,
  type DeliveryFileBind,
  type DeliveryFileEvidence,
  type DeliveryPage,
  type DeliveryQuery,
  type DeliveryReceipt,
  type DeliveryStart,
  type DeliveryTarget,
  type DeliveryWrite,
  deliveryKey,
  isDeliveryAttempt,
  isDeliveryChecklist,
  isDeliveryReceipt,
  isDeliveryWrite,
  type WorkItem,
  type WorkState,
  workKey,
} from '@daban/protocol';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { Fault } from './control.js';
import type { Database } from './database.js';
import {
  workChecklists,
  workDecisions,
  workDeliveries,
  workDeliveryOperations,
  workItems,
  workMeta,
  workOperations,
} from './work-schema.js';

export class WorkDelivery {
  constructor(
    private readonly db: Database,
    private readonly item: (id: string) => WorkItem,
    private readonly assertStateWrite: () => unknown,
  ) {}
  checklist(workId: string): DeliveryChecklist {
    this.item(workId);
    const row = this.db
      .select()
      .from(workChecklists)
      .where(eq(workChecklists.workId, workId))
      .get();
    const value = {
      workId,
      revision: row?.revision ?? 0,
      items: row ? (JSON.parse(row.items) as unknown) : [],
    };
    if (!isDeliveryChecklist(value)) throw new Fault('WORK_CORRUPT');
    return value;
  }
  page(query: DeliveryQuery): DeliveryPage {
    const rows = this.db
      .select()
      .from(workDeliveries)
      .where(
        and(
          eq(workDeliveries.workId, query.workId),
          ...(query.before === undefined ? [] : [lt(workDeliveries.seq, query.before)]),
        ),
      )
      .orderBy(desc(workDeliveries.seq))
      .limit((query.limit ?? 20) + 1)
      .all();
    const attempts = rows.slice(0, query.limit ?? 20).map((row) => this.decode(row.value));
    return {
      workId: query.workId,
      checklist: this.checklist(query.workId),
      attempts,
      ...(rows.length > (query.limit ?? 20) ? { nextBefore: attempts.at(-1)!.sequence } : {}),
    };
  }
  decode(data: string): DeliveryAttempt {
    const value: unknown = JSON.parse(data);
    if (!isDeliveryAttempt(value)) throw new Fault('WORK_CORRUPT');
    return value;
  }
  attempt(workId: string, id: string) {
    const row = this.db
      .select()
      .from(workDeliveries)
      .where(and(eq(workDeliveries.id, id), eq(workDeliveries.workId, workId)))
      .get();
    if (!row) throw new Fault('DELIVERY_NOT_FOUND', 404);
    return this.decode(row.value);
  }
  receipt(action: string, request: DeliveryWrite): DeliveryReceipt {
    const row = this.db
      .select()
      .from(workDeliveryOperations)
      .where(eq(workDeliveryOperations.id, request.requestId))
      .get();
    if (!row) return { state: 'unknown', request };
    const signature = createHash('sha256').update(deliveryKey(action, request)).digest('hex');
    if (row.signature !== signature || row.workId !== request.workId)
      throw new Fault('DELIVERY_REQUEST_CONFLICT');
    const value: unknown = JSON.parse(row.value);
    if (!isDeliveryReceipt(value)) throw new Fault('WORK_CORRUPT');
    return value;
  }
  record(action: string, request: DeliveryWrite, receipt: DeliveryReceipt) {
    if (!isDeliveryReceipt(receipt)) throw new Fault('INVALID_DELIVERY_RECEIPT');
    this.db
      .insert(workDeliveryOperations)
      .values({
        id: request.requestId,
        workId: request.workId,
        signature: createHash('sha256').update(deliveryKey(action, request)).digest('hex'),
        value: JSON.stringify(receipt),
      })
      .run();
    return receipt;
  }
  writeChecklist(request: DeliveryChecklistWrite) {
    if (!isDeliveryWrite('checklist.write', request))
      throw new Fault('INVALID_DELIVERY_REQUEST', 400);
    return this.db.transaction(
      () => {
        const prior = this.receipt('checklist.write', request);
        if (prior.state === 'complete') return prior;
        const item = this.item(request.workId);
        if (item.deleted) throw new Fault('WORK_TRASHED');
        if (
          item.revision !== request.workRevision ||
          this.checklist(item.id).revision !== request.checklistRevision
        )
          throw new Fault('DELIVERY_CONFLICT');
        const checklist = {
          workId: item.id,
          revision: request.checklistRevision + 1,
          items: request.items,
        };
        this.db
          .insert(workChecklists)
          .values({
            workId: item.id,
            revision: checklist.revision,
            items: JSON.stringify(checklist.items),
          })
          .onConflictDoUpdate({
            target: workChecklists.workId,
            set: { revision: checklist.revision, items: JSON.stringify(checklist.items) },
          })
          .run();
        return this.record('checklist.write', request, { state: 'complete', request, checklist });
      },
      { behavior: 'immediate' },
    );
  }
  private current(request: DeliveryTarget) {
    const item = this.item(request.workId);
    const attempt = this.attempt(request.workId, request.attemptId);
    if (item.revision !== request.workRevision || attempt.revision !== request.attemptRevision)
      throw new Fault('DELIVERY_CONFLICT');
    return { item, attempt };
  }
  private change(item: WorkItem, status: WorkState) {
    if (item.status === status) return item.revision;
    this.assertStateWrite();
    const now = new Date(Math.max(Date.now(), Date.parse(item.updatedAt))).toISOString();
    const changed = this.db
      .update(workItems)
      .set({
        status,
        revision: item.revision + 1,
        updated: now,
        editor: JSON.stringify({ kind: 'human' }),
        completed: status === 'done' || status === 'closed' ? now : null,
      })
      .where(and(eq(workItems.id, item.id), eq(workItems.revision, item.revision)))
      .run();
    if (Number(changed.changes) !== 1) throw new Fault('WORK_CONFLICT');
    const request = {
      id: `delivery-state-${randomUUID()}`,
      item: item.id,
      revision: item.revision,
      action: 'update' as const,
      value: { status },
    };
    this.db
      .insert(workOperations)
      .values({
        id: request.id,
        item: item.id,
        signature: createHash('sha256')
          .update(workKey(request, { kind: 'human' }))
          .digest('hex'),
        revision: item.revision + 1,
        at: now,
      })
      .run();
    this.db
      .update(workMeta)
      .set({ revision: sql`${workMeta.revision} + 1` })
      .where(eq(workMeta.id, 1))
      .run();
    return item.revision + 1;
  }
  private save(attempt: DeliveryAttempt) {
    if (!isDeliveryAttempt(attempt)) throw new Fault('INVALID_DELIVERY_ATTEMPT');
    const active =
      ['accepted', 'running', 'ready', 'unknown'].includes(attempt.phase) &&
      attempt.decision?.action !== 'close-unknown';
    this.db
      .update(workDeliveries)
      .set({ value: JSON.stringify(attempt), activeWorkId: active ? attempt.workId : null })
      .where(eq(workDeliveries.id, attempt.attemptId))
      .run();
    return attempt;
  }
  start(request: DeliveryStart) {
    return this.db.transaction(
      () => {
        const prior = this.receipt('start', request);
        if (prior.state === 'complete') return prior;
        const item = this.item(request.workId),
          checklist = this.checklist(item.id);
        if (item.deleted) throw new Fault('WORK_TRASHED');
        if (item.status === 'done' || item.status === 'closed')
          throw new Fault('DELIVERY_COMPLETED_WORK');
        if (
          item.revision !== request.workRevision ||
          checklist.revision !== request.checklistRevision
        )
          throw new Fault('DELIVERY_CONFLICT');
        if (
          this.db
            .select()
            .from(workDeliveries)
            .where(eq(workDeliveries.activeWorkId, item.id))
            .get()
        )
          throw new Fault('DELIVERY_ACTIVE');
        const now = new Date().toISOString();
        const attempt: DeliveryAttempt = {
          attemptId: `delivery-${randomUUID()}`,
          sequence: 1,
          revision: 1,
          workId: item.id,
          workRevision: item.revision,
          ownershipRevision: this.change(item, 'doing'),
          requestId: request.requestId,
          bot: request.bot,
          title: item.title,
          description: item.description,
          checklist,
          phase: 'accepted',
          createdAt: now,
          updatedAt: now,
          error: '',
          results: [],
          outputs: [],
          evidence: [],
          groups: [],
        };
        const row = this.db
          .insert(workDeliveries)
          .values({
            id: attempt.attemptId,
            workId: item.id,
            requestId: request.requestId,
            activeWorkId: item.id,
            value: JSON.stringify(attempt),
          })
          .returning({ sequence: workDeliveries.seq })
          .get();
        attempt.sequence = row.sequence;
        this.save(attempt);
        return this.record('start', request, { state: 'complete', request, attempt });
      },
      { behavior: 'immediate' },
    );
  }
  project(
    workId: string,
    id: string,
    revision: number,
    patch: Pick<DeliveryAttempt, 'phase' | 'error' | 'results' | 'outputs' | 'groups'> & {
      runId?: string;
    },
    queried = false,
  ) {
    return this.db.transaction(
      () => {
        const attempt = this.attempt(workId, id);
        if (
          attempt.revision !== revision ||
          attempt.decision ||
          ['failed', 'stopped', 'accepted-by-user', 'rejected'].includes(attempt.phase)
        )
          return attempt;
        const changed =
          JSON.stringify(patch) !==
          JSON.stringify({
            phase: attempt.phase,
            error: attempt.error,
            results: attempt.results,
            outputs: attempt.outputs,
            groups: attempt.groups,
            ...(attempt.runId ? { runId: attempt.runId } : {}),
          });
        if (!changed && (!queried || attempt.queriedAt)) return attempt;
        const item = this.item(workId);
        // Execution facts may arrive after a human edit; only the exact owned card version can move automatically.
        if (
          item.revision === attempt.ownershipRevision &&
          !item.deleted &&
          !['done', 'closed'].includes(item.status)
        ) {
          try {
            if (patch.phase === 'ready') attempt.ownershipRevision = this.change(item, 'review');
            if (patch.phase === 'failed' || patch.phase === 'stopped')
              attempt.ownershipRevision = this.change(item, 'blocked');
          } catch (error) {
            // A full Work operation ledger must not erase the already accepted execution's outcome.
            if (!(error instanceof Fault) || error.code !== 'WORK_OPERATION_LIMIT') throw error;
          }
        }
        Object.assign(attempt, patch);
        attempt.revision++;
        attempt.updatedAt = new Date().toISOString();
        const report = patch.results.filter((entry) => entry.text.trim()).at(-1);
        if (patch.phase === 'ready' && report) {
          attempt.evidence = [
            ...attempt.evidence.filter((entry) => entry.source === 'file-check'),
            ...attempt.checklist.items
              .filter((criterion) => criterion.kind === 'text')
              .map((criterion) => ({
                criterionId: criterion.id,
                source: 'model-report' as const,
                bot: report.bot,
                runId: report.runId,
                checkedAt: attempt.updatedAt,
              })),
          ];
        }
        if (queried && patch.phase === 'unknown') attempt.queriedAt = attempt.updatedAt;
        return this.save(attempt);
      },
      { behavior: 'immediate' },
    );
  }
  bind(request: DeliveryFileBind, evidence: DeliveryFileEvidence) {
    return this.db.transaction(
      () => {
        const prior = this.receipt('file.bind', request);
        if (prior.state === 'complete') return prior;
        const { item, attempt } = this.current(request);
        if (item.deleted) throw new Fault('WORK_TRASHED');
        if (attempt.phase !== 'ready' || attempt.decision) throw new Fault('DELIVERY_NOT_READY');
        if (
          !attempt.checklist.items.some(
            (item) => item.id === request.criterionId && item.kind === 'file',
          )
        )
          throw new Fault('DELIVERY_CRITERION');
        if (
          !attempt.outputs.some(
            (output) =>
              output.bot === request.output.bot &&
              output.runId === request.output.runId &&
              output.path === request.output.path,
          )
        )
          throw new Fault('DELIVERY_OUTPUT_OWNER');
        attempt.evidence = [
          ...attempt.evidence.filter((item) => item.criterionId !== evidence.criterionId),
          evidence,
        ];
        attempt.revision++;
        attempt.updatedAt = new Date().toISOString();
        this.save(attempt);
        return this.record('file.bind', request, { state: 'complete', request, attempt });
      },
      { behavior: 'immediate' },
    );
  }
  invalidate(workId: string, id: string, revision: number, criterionIds: string[]) {
    return this.db.transaction(
      () => {
        const attempt = this.attempt(workId, id);
        if (attempt.revision !== revision || attempt.decision) return attempt;
        attempt.evidence = attempt.evidence.map((item) =>
          item.source === 'file-check' && criterionIds.includes(item.criterionId)
            ? { ...item, available: false }
            : item,
        );
        attempt.revision++;
        return this.save(attempt);
      },
      { behavior: 'immediate' },
    );
  }
  decide(request: DeliveryDecision) {
    return this.db.transaction(
      () => {
        const prior = this.receipt('decide', request);
        if (prior.state === 'complete') return prior;
        const { item, attempt } = this.current(request);
        if (item.deleted) throw new Fault('WORK_TRASHED');
        if (attempt.decision) throw new Fault('DELIVERY_DECIDED');
        if (request.action === 'close-unknown') {
          if (attempt.phase !== 'unknown' || !attempt.queriedAt)
            throw new Fault('DELIVERY_QUERY_REQUIRED');
        } else {
          if (item.status === 'closed') throw new Fault('WORK_REOPEN_REQUIRED');
          if (attempt.phase !== 'ready') throw new Fault('DELIVERY_NOT_READY');
          if (request.action === 'accept') {
            if (
              attempt.checklist.items.some((item) => !request.checked.includes(item.id)) ||
              request.checked.some((id) => !attempt.checklist.items.some((item) => item.id === id))
            )
              throw new Fault('DELIVERY_UNCHECKED');
            if (
              attempt.checklist.items.some(
                (item) =>
                  item.kind === 'file' &&
                  item.required &&
                  !attempt.evidence.some(
                    (entry) =>
                      entry.source === 'file-check' &&
                      entry.criterionId === item.id &&
                      entry.available,
                  ),
              )
            )
              throw new Fault('DELIVERY_FILE_UNAVAILABLE');
          }
          attempt.phase = request.action === 'accept' ? 'accepted-by-user' : 'rejected';
          attempt.ownershipRevision = this.change(
            item,
            request.action === 'accept' ? 'done' : 'blocked',
          );
        }
        attempt.revision++;
        attempt.updatedAt = new Date().toISOString();
        attempt.decision = {
          action: request.action,
          checked: request.checked,
          reason: request.reason,
          at: attempt.updatedAt,
          criteria: attempt.checklist.items,
          evidence: attempt.evidence,
        };
        this.db
          .insert(workDecisions)
          .values({
            attemptId: attempt.attemptId,
            requestId: request.requestId,
            value: JSON.stringify(attempt.decision),
          })
          .run();
        this.save(attempt);
        return this.record('decide', request, { state: 'complete', request, attempt });
      },
      { behavior: 'immediate' },
    );
  }
  stop(request: DeliveryTarget) {
    return this.db.transaction(
      () => {
        const prior = this.receipt('stop', request);
        if (prior.state === 'complete') return prior;
        const { attempt } = this.current(request);
        if (!['accepted', 'running', 'unknown'].includes(attempt.phase) || attempt.decision)
          throw new Fault('DELIVERY_NOT_RUNNING');
        return this.record('stop', request, { state: 'complete', request, attempt });
      },
      { behavior: 'immediate' },
    );
  }
}
