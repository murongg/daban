import {
  agentId,
  isRebootStatus,
  isRecoveryReview,
  type RebootStatus,
  type RecoveryReview,
  recoveryBlocked,
} from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';

const stages = {
  preparing: 'recovery.preparingRecovery',
  prepared: 'recovery.recoveryPreparedShutdownNotStarted',
  'stop-issued': 'recovery.shutdownRequestedResultNeedsVerification',
  stopped: 'recovery.runtimeStopped',
  'start-issued': 'recovery.startingRuntime',
  complete: 'recovery.runtimeRecovered',
  cancelled: 'recovery.recoveryCancelled',
  rejected: 'recovery.recoveryNotExecuted',
} as const;
const terminal = new Set(['complete', 'cancelled', 'rejected']);
export function Recovery({
  bots,
  close,
  onTask,
}: {
  bots: Bot[];
  close: () => unknown;
  onTask?: (id: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const [local, setLocal] = useState<RebootStatus>();
  const [review, setReview] = useState<RecoveryReview>();
  const [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(true),
    working = useRef(false),
    sequence = useRef(0);
  const live = runtime.snapshot.reboot;
  const host =
    local?.available && live?.available
      ? local.revision > live.revision
        ? local
        : live
      : (local ?? live);
  const operation = host?.available ? host.operation : undefined;
  const pending = !!operation && !terminal.has(operation.stage);
  const unissued = !!operation && ['preparing', 'prepared'].includes(operation.stage);
  const foreign =
    !operation &&
    runtime.snapshot.recovery?.available &&
    runtime.snapshot.recovery.operation &&
    ['prepared', 'claimed'].includes(runtime.snapshot.recovery.operation.phase);
  const active = busy || !!(host?.available && host.busy);
  const name = (id: string) => bots.find((bot) => agentId(bot.id) === id)?.name ?? id;
  const accept = useCallback((value: unknown) => {
    if (!isRebootStatus(value)) throw new Error('INVALID_RUNTIME_STATE');
    if (mounted.current)
      setLocal((previous) =>
        previous?.available && value.available && previous.revision > value.revision
          ? previous
          : value,
      );
    return value;
  }, []);
  const loadReview = useCallback(async () => {
    const ticket = ++sequence.current;
    const value = await runtime.command<RecoveryReview>({ type: 'recovery.review' });
    if (!isRecoveryReview(value)) throw new Error('INVALID_RUNTIME_STATE');
    if (mounted.current && ticket === sequence.current) {
      setReview(value);
      setSaved(false);
    }
  }, [runtime.command]);
  useEffect(() => {
    mounted.current = true;
    const ticket = ++sequence.current;
    async function load() {
      const value = await runtime.command<RebootStatus>({ type: 'recovery.status' });
      if (!mounted.current || ticket !== sequence.current) return;
      accept(value);
      if (
        value.available &&
        (!value.operation ||
          terminal.has(value.operation.stage) ||
          ['preparing', 'prepared'].includes(value.operation.stage))
      )
        await loadReview();
    }
    load().catch((failure) => {
      if (mounted.current) setError(runtimeError(failure));
    });
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [runtime.command, accept, loadReview]);
  async function perform(action: () => Promise<unknown>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      if (mounted.current) setError(runtimeError(failure));
      try {
        accept(await runtime.command({ type: 'recovery.status' }));
      } catch {
        /* Retain the last known receipt if inspection is unavailable. */
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  // A completed operation describes the previous kernel; a new restart must use a freshly reviewed scope.
  const scope = pending ? operation!.review : (review ?? operation?.review);
  const changed =
    !!review &&
    (runtime.snapshot.computers?.revision !== review.computersRevision ||
      review.screens.some((row) => {
        const current = runtime.snapshot.computers?.items.find(
          (item) => item.bot === row.computer.bot,
        );
        const lease = runtime.snapshot.bots[row.computer.bot];
        return (
          !current ||
          current.instance !== row.computer.instance ||
          current.phase !== row.computer.phase ||
          (!!row.lease &&
            (!lease || lease.epoch !== row.lease.epoch || lease.owner !== row.lease.owner))
        );
      }) ||
      (pending &&
        !!operation &&
        (review.boot !== operation.review.boot ||
          review.instance !== operation.review.instance ||
          review.computersRevision !== operation.review.computersRevision ||
          JSON.stringify(review.screens) !== JSON.stringify(operation.review.screens))));
  const running = Object.entries(runtime.snapshot.agents)
    .filter(([, task]) => task.running)
    .map(([id]) => id);
  const canRestart =
    !!host?.available &&
    !!review &&
    !foreign &&
    !changed &&
    !review.changing &&
    !review.running.length &&
    !running.length &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 24 &&
    (!pending || unissued);
  async function restart() {
    if (!saved || !canRestart || !scope) return;
    const request = {
      id: unissued ? operation!.id : crypto.randomUUID(),
      revision: scope.revision,
      review: scope.digest,
      confirmation: 'restart-all-apps' as const,
    };
    setSaved(false);
    accept(await runtime.command({ type: 'recovery.restart', request }));
  }
  return (
    <Dialog title={t('recovery.recoverEntireRuntime')} onClose={close}>
      <p className="dialog-description">{t('recovery.restartsLocalLinuxClosesEveryBotS')}</p>
      <p className="inline-note">
        {t('recovery.savedFilesPreferencesChatsRetainedReconnectComputers')}
      </p>
      {scope && (
        <section className="recovery-screens" aria-label={t('recovery.computersAffectedRecovery')}>
          {scope.screens.length ? (
            scope.screens.map((row) => (
              <div key={row.computer.bot} className="recovery-screen">
                <span>{name(row.computer.bot)}</span>
                <span className="muted">
                  {row.computer.phase !== 'connected'
                    ? t('recovery.stateNeedsVerification')
                    : row.lease?.owner === 'human'
                      ? t('common.control')
                      : row.lease?.owner === 'agent'
                        ? t('recovery.botControlEnabled')
                        : t('recovery.stateNeedsVerification')}
                </span>
              </div>
            ))
          ) : (
            <p className="inline-note">
              {t('recovery.noBotScreensCurrentlyOccupiedRecoveryStill')}
            </p>
          )}
        </section>
      )}
      {(review?.running.length || running.length) > 0 && (
        <div className="inline-note">
          <p>{t('recovery.finishRunningTaskRestoring')}</p>
          {[...new Set([...(review?.running ?? []), ...running])].map((id) => (
            <button
              key={id}
              type="button"
              className="secondary"
              onClick={() => onTask?.(id)}
              disabled={!onTask}
            >
              {t('recovery.view')}
              {name(id)}
              {t('recovery.sTasks')}
            </button>
          ))}
        </div>
      )}
      {foreign && (
        <p className="inline-note">{t('recovery.recoveryWasStartedAnotherClientVerifyResult')}</p>
      )}
      {host && !host.available && (
        <p className="form-error" role="alert">
          {runtimeError(new Error(host.error))}
        </p>
      )}
      {operation && (
        <div className="recovery-result" role="status">
          <strong>{t(stages[operation.stage])}</strong>
          {operation.error && (
            <p className="form-error">{runtimeError(new Error(operation.error))}</p>
          )}
          {operation.stage === 'stop-issued' && (
            <p className="inline-note">{t('recovery.checkCurrentStateFirstAppWillNot')}</p>
          )}
          {pending && (
            <p className="inline-note">
              {t('recovery.closingWindowDoesNotWithdrawSubmittedOperations')}
            </p>
          )}
        </div>
      )}
      {changed && operation?.stage !== 'complete' && (
        <p className="inline-note">{t('recovery.runtimeControlStateChangedVerifyAgain')}</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {canRestart && (
        <label className="recovery-consent">
          <input
            type="checkbox"
            checked={saved}
            disabled={active}
            onChange={(event) => setSaved(event.target.checked)}
          />
          {t('recovery.iSavedContentAllComputers')}
        </label>
      )}
      <div className="dialog-actions recovery-actions">
        <button type="button" className="text-button" onClick={close}>
          {t('common.close')}
        </button>
        {!pending && (
          <button
            type="button"
            className="secondary"
            disabled={active || runtime.snapshot.phase !== 'ready'}
            onClick={() => perform(loadReview)}
          >
            {t('recovery.verifyAgain')}
          </button>
        )}
        {pending && (
          <button
            type="button"
            className="secondary"
            disabled={active}
            onClick={() =>
              perform(async () =>
                accept(await runtime.command({ type: 'recovery.inspect', id: operation!.id })),
              )
            }
          >
            {t('recovery.verifyRecoveryResult')}
          </button>
        )}
        {unissued && operation?.backend?.phase === 'prepared' && (
          <button
            type="button"
            className="secondary"
            disabled={active}
            onClick={() =>
              perform(async () =>
                accept(await runtime.command({ type: 'recovery.cancel', id: operation.id })),
              )
            }
          >
            {t('recovery.cancelRecoveryExecution')}
          </button>
        )}
        {operation?.stage === 'stopped' || operation?.stage === 'start-issued' ? (
          <button
            type="button"
            className="primary"
            disabled={active}
            onClick={() =>
              perform(async () =>
                accept(await runtime.command({ type: 'recovery.start', id: operation.id })),
              )
            }
          >
            {t('recovery.startRuntime')}
          </button>
        ) : (
          (!pending || unissued) && (
            <button
              type="button"
              className="primary"
              disabled={active || !saved || !canRestart}
              onClick={() => perform(restart)}
            >
              {active
                ? t('common.processing')
                : unissued
                  ? t('recovery.continueRecovery')
                  : t('recovery.confirmEntireEnvironmentRestart')}
            </button>
          )
        )}
      </div>
    </Dialog>
  );
}
export function RecoveryNotice({ open }: { open: () => unknown }) {
  useLocale();
  const runtime = useRuntime();
  if (!recoveryBlocked(runtime.snapshot)) return null;
  return (
    <div className="recovery-banner" role="status">
      <div>
        <strong>{t('recovery.runtimeRecoveryNeedsVerification')}</strong>
        <p>{t('recovery.newTasksComputerActionsPausedCanStill')}</p>
      </div>
      <button type="button" className="secondary" onClick={open}>
        {t('recovery.viewRecovery')}
      </button>
    </div>
  );
}
export function RecoveryEntry({ open }: { open?: () => unknown }) {
  useLocale();
  const runtime = useRuntime();
  const operation = runtime.snapshot.reboot?.available
    ? runtime.snapshot.reboot.operation
    : undefined;
  const pending = !!operation && !terminal.has(operation.stage);
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{t('recovery.recoverLocalRuntime')}</div>
        <p className="setting-description">
          {t('recovery.ifComputerCleanupUnconfirmedRuntimeUnhealthyVerify')}
        </p>
        {runtime.snapshot.protocolVersion < 24 && (
          <p className="inline-note">
            {t('recovery.availableUpdatingRuntimeExistingReceiptsCanStill')}
          </p>
        )}
      </div>
      <button
        type="button"
        className="secondary"
        disabled={!open || !runtime.enabled || (!pending && runtime.snapshot.protocolVersion < 24)}
        onClick={open}
      >
        {pending ? t('recovery.viewRecovery') : t('recovery.checkRecover')}
      </button>
    </div>
  );
}
