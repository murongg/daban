import { createHash } from 'node:crypto';
import {
  type DeliveryAttempt,
  type DeliveryCommand,
  type DeliveryDecision,
  type DeliveryFileBind,
  type DeliveryReference,
  type DeliveryStart,
  type DeliveryTarget,
  deliveryAction,
  deliveryKey,
  isDeliveryCommand,
  isRuntimeDownload,
  sameDeliveryReference,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import type { Groups } from './groups.js';
import type { ModelRuns } from './model.js';
import type { AgentWorkspace } from './workspace.js';

export class Delivery {
  private readonly starting = new Map<string, { key: string; promise: Promise<unknown> }>();
  constructor(
    private readonly models: ModelRuns,
    private readonly groups: Groups | undefined,
    private readonly files: AgentWorkspace,
  ) {}
  private reference(attempt: DeliveryAttempt): DeliveryReference {
    return { attemptId: attempt.attemptId, workId: attempt.workId, requestId: attempt.requestId };
  }
  private async reconcile(attempt: DeliveryAttempt, queried = false) {
    if (
      attempt.decision ||
      ['failed', 'stopped', 'accepted-by-user', 'rejected'].includes(attempt.phase)
    )
      return attempt;
    const receipt = this.models.findRequest(attempt.bot, attempt.requestId);
    if (!receipt && this.starting.has(attempt.requestId)) return attempt;
    const owned = receipt && sameDeliveryReference(receipt.delivery, this.reference(attempt));
    let phase: DeliveryAttempt['phase'] = !owned
      ? 'unknown'
      : receipt.phase === 'completed'
        ? 'ready'
        : receipt.phase === 'failed'
          ? 'failed'
          : receipt.phase === 'stopped'
            ? 'stopped'
            : receipt.phase === 'interrupted'
              ? 'unknown'
              : 'running';
    let groupsUnavailable = false;
    const collaboration = this.groups
      ? await this.groups.deliveryProgress(this.reference(attempt)).catch(() => {
          groupsUnavailable = true;
          return [];
        })
      : [];
    // Even a failed primary reply cannot release the card while its accepted group still runs.
    if (groupsUnavailable) phase = 'unknown';
    else if (phase !== 'unknown') {
      if (collaboration.some((group) => ['pending', 'running'].includes(group.state)))
        phase = 'running';
      else if (collaboration.some((group) => ['interrupted', 'cancelled'].includes(group.state)))
        phase = 'unknown';
      else if (collaboration.some((group) => group.state === 'failed')) phase = 'failed';
    }
    const receipts = owned
      ? [
          { bot: attempt.bot, receipt },
          ...collaboration.flatMap((group) =>
            group.stages.flatMap((stage) => {
              const found = this.models.findRequest(stage.bot, stage.requestId);
              return found &&
                found.runId === stage.runId &&
                sameDeliveryReference(found.delivery, this.reference(attempt))
                ? [{ bot: stage.bot, receipt: found }]
                : [];
            }),
          ),
        ]
      : [];
    const patch = {
      phase,
      error: groupsUnavailable
        ? 'GROUP_UNAVAILABLE'
        : owned
          ? (receipt.error ?? '').slice(0, 2000)
          : 'DELIVERY_OUTCOME_UNKNOWN',
      results: receipts.map(({ bot, receipt }) => ({
        bot,
        runId: receipt.runId,
        text: (receipt.result ?? receipt.response?.text ?? '').slice(0, 100000),
        source: 'model-report' as const,
      })),
      outputs: receipts
        .flatMap(({ bot, receipt }) =>
          (receipt.files ?? [])
            .slice(0, 1000)
            .map((file) => ({ bot, runId: receipt.runId, path: file.path })),
        )
        .slice(0, 1000),
      groups: groupsUnavailable
        ? attempt.groups
        : collaboration.map(({ groupId, sourceId }) => ({ groupId, sourceId })),
      ...(owned ? { runId: receipt.runId } : {}),
    };
    if (phase === 'unknown') {
      // Losing a receipt does not erase facts already observed for this accepted attempt.
      patch.results = [
        ...new Map(
          [...attempt.results, ...patch.results].map((result) => [
            `${result.bot}:${result.runId}`,
            result,
          ]),
        ).values(),
      ].slice(-100);
      patch.outputs = [
        ...new Map(
          [...attempt.outputs, ...patch.outputs].map((output) => [
            `${output.bot}:${output.runId}:${output.path}`,
            output,
          ]),
        ).values(),
      ].slice(-1000);
    }
    return this.models.work.deliveryObserve((store) =>
      store.project(attempt.workId, attempt.attemptId, attempt.revision, patch, queried),
    );
  }
  private async start(request: DeliveryStart) {
    const pending = this.starting.get(request.requestId);
    const key = deliveryKey('start', request);
    if (pending) {
      if (pending.key !== key) throw new Fault('DELIVERY_REQUEST_CONFLICT');
      return pending.promise;
    }
    const run = this.accept(request);
    this.starting.set(request.requestId, { key, promise: run });
    try {
      return await run;
    } finally {
      this.starting.delete(request.requestId);
    }
  }
  private async accept(request: DeliveryStart) {
    const prior = await this.models.work.deliveryReceipt('start', request);
    if (prior.state === 'complete') return prior;
    if (this.models.findRequest(request.bot, request.requestId))
      throw new Fault('DELIVERY_REQUEST_CONFLICT');
    this.models.profiles.assertActive(request.bot);
    if (!this.models.admit(request.bot)) throw new Fault('RUNTIME_RECOVERY_PENDING');
    const accepted = await this.models.work.deliveryEffect((store) => {
      this.models.profiles.assertActive(request.bot);
      if (!this.models.admit(request.bot)) throw new Fault('RUNTIME_RECOVERY_PENDING');
      return store.start(request);
    });
    if (accepted.state !== 'complete' || !('attempt' in accepted))
      throw new Fault('INVALID_DELIVERY_RECEIPT');
    const attempt = accepted.attempt;
    try {
      // Commit the accepted claim before ModelRuns can issue any side effect. Recovery only queries this identity.
      await this.models.startHuman(
        attempt.bot,
        {
          requestId: attempt.requestId,
          // The accepted checklist can exceed the prompt's UTF-16 bound. Use the existing input-file path without truncating it or replacing Bot preferences.
          prompt: `${attempt.title}\n\n${attempt.description}\n\n${attempt.checklist.items.length ? 'Read delivery-criteria.txt for the accepted checklist. Report results against it for explicit human acceptance.' : 'Report the result for explicit human acceptance.'}`,
          ...(attempt.checklist.items.length
            ? {
                files: [
                  {
                    name: 'delivery-criteria.txt',
                    content: JSON.stringify(attempt.checklist.items, null, 2),
                  },
                ],
              }
            : {}),
          chatRevision: this.models.chats.current(attempt.bot).revision,
        },
        undefined,
        undefined,
        { delivery: this.reference(attempt) },
      );
    } catch (error) {
      if (
        !this.models.findRequest(attempt.bot, attempt.requestId) &&
        [
          'MODEL_ALREADY_RUNNING',
          'BOT_ARCHIVED',
          'UNKNOWN_BOT',
          'RUNTIME_RECOVERY_PENDING',
          'BOT_CHANGING',
          'DSH_NOT_INSTALLED',
        ].includes(errorCode(error) ?? '')
      ) {
        await this.models.work.deliveryEffect((store) =>
          store.project(attempt.workId, attempt.attemptId, attempt.revision, {
            phase: 'failed',
            error: errorCode(error)!,
            results: [],
            outputs: [],
            groups: [],
          }),
        );
      }
    }
    return accepted;
  }
  private async artifact(request: DeliveryFileBind) {
    const attempt = await this.models.work.deliveryObserve((store) =>
      store.attempt(request.workId, request.attemptId),
    );
    if (
      !attempt.outputs.some(
        (output) =>
          output.bot === request.output.bot &&
          output.runId === request.output.runId &&
          output.path === request.output.path,
      )
    )
      throw new Fault('DELIVERY_OUTPUT_OWNER');
    const file = await this.files.download(request.output.path).catch(() => {
      throw new Fault('DELIVERY_FILE_UNAVAILABLE');
    });
    if (!isRuntimeDownload(file) || file.path !== request.output.path)
      throw new Fault('DELIVERY_FILE_UNAVAILABLE');
    const bytes = Buffer.from(file.data, 'base64');
    return {
      ...request.output,
      criterionId: request.criterionId,
      source: 'file-check' as const,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      checkedAt: new Date().toISOString(),
      available: true,
    };
  }
  private async decide(request: DeliveryDecision) {
    const prior = await this.models.work.deliveryReceipt('decide', request);
    if (prior.state === 'complete') return prior;
    const attempt = await this.models.work.deliveryObserve((store) =>
      store.attempt(request.workId, request.attemptId),
    );
    if (request.action === 'accept') {
      const invalid: string[] = [];
      for (const evidence of attempt.evidence) {
        if (evidence.source !== 'file-check') continue;
        try {
          const current = await this.artifact({
            ...request,
            criterionId: evidence.criterionId,
            output: { bot: evidence.bot, runId: evidence.runId, path: evidence.path },
          });
          if (
            current.size !== evidence.size ||
            current.sha256 !== evidence.sha256 ||
            !evidence.available
          )
            invalid.push(evidence.criterionId);
        } catch {
          invalid.push(evidence.criterionId);
        }
      }
      if (invalid.length) {
        await this.models.work.deliveryEffect((store) =>
          store.invalidate(attempt.workId, attempt.attemptId, attempt.revision, invalid),
        );
        throw new Fault('DELIVERY_FILE_CHANGED');
      }
    }
    return this.models.work.deliveryEffect((store) => store.decide(request));
  }
  private async stop(request: DeliveryTarget) {
    const prior = await this.models.work.deliveryReceipt('stop', request);
    if (prior.state === 'complete') return prior;
    const ack = await this.models.work.deliveryEffect((store) => store.stop(request));
    if (ack.state !== 'complete' || !('attempt' in ack))
      throw new Fault('INVALID_DELIVERY_RECEIPT');
    const attempt = ack.attempt;
    await this.models.stopRequest(attempt.bot, attempt.requestId, undefined);
    const groups = this.groups ? await this.groups.deliveryProgress(this.reference(attempt)) : [];
    for (const group of groups) await this.groups!.cancel(group.groupId, group.sourceId);
    const current = await this.reconcile(attempt);
    const root = this.models.findRequest(attempt.bot, attempt.requestId);
    const terminal = ['completed', 'failed', 'stopped'];
    const settled = this.groups ? await this.groups.deliveryProgress(this.reference(attempt)) : [];
    const groupsStopped = settled.every((group) =>
      group.stages.every((stage) => {
        if (stage.state === 'completed' || stage.state === 'failed') return true;
        if (stage.state !== 'cancelled') return false;
        // Groups serializes claims and cancellation: a cancelled stage without a run was never dispatched.
        if (!stage.runId) return true;
        const receipt = this.models.findRequest(stage.bot, stage.requestId);
        return (
          !!receipt &&
          receipt.runId === stage.runId &&
          receipt.conversationId === group.groupId &&
          sameDeliveryReference(receipt.delivery, this.reference(attempt)) &&
          terminal.includes(receipt.phase)
        );
      }),
    );
    if (
      root &&
      sameDeliveryReference(root.delivery, this.reference(attempt)) &&
      terminal.includes(root.phase) &&
      groupsStopped
    ) {
      await this.models.work.deliveryObserve((store) =>
        store.project(current.workId, current.attemptId, current.revision, {
          phase: 'stopped',
          error: '',
          results: current.results,
          outputs: current.outputs,
          groups: current.groups,
          ...(current.runId ? { runId: current.runId } : {}),
        }),
      );
    }
    return ack;
  }
  async command(input: DeliveryCommand) {
    if (!isDeliveryCommand(input)) throw new Fault('INVALID_DELIVERY_REQUEST', 400);
    const command = structuredClone(input),
      work = this.models.work;
    if (command.type === 'delivery.checklist.get')
      return work.deliveryChecklist(command.query.workId);
    if (command.type === 'delivery.checklist.write')
      return work.deliveryChecklistWrite(command.request, { kind: 'human' });
    if (command.type === 'delivery.get') {
      const page = await work.deliveryPage(command.query);
      page.attempts = await Promise.all(
        page.attempts.map((attempt) => this.reconcile(attempt, true)),
      );
      return page;
    }
    const action = command.type.slice(9);
    if (action.endsWith('receipt'))
      return work.deliveryReceipt(deliveryAction(action), command.request);
    if (command.type === 'delivery.start') return this.start(command.request);
    if (command.type === 'delivery.decide') return this.decide(command.request);
    if (command.type === 'delivery.stop') return this.stop(command.request);
    if (command.type === 'delivery.file.bind') {
      const prior = await work.deliveryReceipt('file.bind', command.request);
      if (prior.state === 'complete') return prior;
      const evidence = await this.artifact(command.request);
      return work.deliveryEffect((store) => store.bind(command.request, evidence));
    }
    throw new Fault('INVALID_DELIVERY_REQUEST', 400);
  }
}
