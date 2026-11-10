import {
  type ComputerAck,
  type ComputerRequest,
  type ComputerState,
  recoveryBlocked,
} from '@daban/protocol';
import { CircleAlert, Power } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { IconButton } from '../../components/controls/Button';
import { Dialog } from '../../components/controls/Dialog';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import {
  beginComputer,
  type ComputerPending,
  clearComputer,
  pendingComputer,
  watchComputers,
} from './connections';

const definite = new Set([
  'COMPUTER_CONFLICT',
  'COMPUTER_BUSY',
  'COMPUTER_CAPACITY',
  'COMPUTER_CONFIRM_REQUIRED',
  'COMPUTER_BOT_NOT_FOUND',
  'COMPUTER_RECOVERY_REQUIRED',
  'COMPUTER_STOP_REQUIRED',
  'INVALID_COMPUTER_REQUEST',
  'RUNTIME_TOO_OLD',
  'RUNTIME_OFFLINE',
]);
const headings: Record<ComputerState['phase'], MessageKey> = {
  disconnected: 'computer.connectComputer',
  connecting: 'common.connectingComputer',
  connected: 'computer.computerConnected',
  stopping: 'common.stoppingComputer',
  suspended: 'computer.computerPaused',
  failed: 'computer.computerUnavailable',
  interrupted: 'computer.computerActionUnconfirmed',
};

export function Connection(props: {
  bot: string;
  name: string;
  notify: (text: string) => unknown;
  onRecovery?: () => unknown;
}) {
  useLocale();
  return <ConnectionControl key={props.bot} {...props} />;
}
function ConnectionControl({
  bot,
  name,
  notify,
  onRecovery,
}: {
  bot: string;
  name: string;
  notify: (text: string) => unknown;
  onRecovery?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime(),
    status = runtime.snapshot.computers;
  const computer = status?.items.find((item) => item.bot === bot) ?? {
    bot,
    revision: 0,
    phase: 'disconnected' as const,
    desired: false,
    reserved: false,
  };
  const [pending, setPending] = useState<ComputerPending>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [storageError, setStorageError] = useState(false);
  const [stop, setStop] = useState<{ revision: number; instance?: string; saved: boolean }>();
  const live = useRef(true),
    restored = useRef<string | undefined>(undefined);
  const ready = runtime.snapshot.phase === 'ready';
  const available = status?.available || runtime.snapshot.linux?.available === true;
  const running = runtime.snapshot.agents[bot]?.running === true;
  const changing = ['connecting', 'stopping'].includes(computer.phase);
  const registered = runtime.snapshot.profiles.some((profile) => profile.id === bot);
  const occupied = status?.items.filter((item) => item.reserved).length ?? 0;
  const full = !!status && occupied >= status.limit && !computer.reserved;
  const stale =
    !!stop && (stop.revision !== computer.revision || stop.instance !== computer.instance);
  const closeStop = useCallback(() => setStop(undefined), []);
  useEffect(() => {
    live.current = true;
    const sync = () => {
      try {
        setPending(pendingComputer(bot));
        setStorageError(false);
      } catch (cause) {
        setStorageError(true);
        setError(runtimeError(cause));
      }
    };
    try {
      restored.current = pendingComputer(bot)?.id;
    } catch {}
    sync();
    const unwatch = watchComputers(sync);
    return () => {
      live.current = false;
      unwatch();
    };
  }, [bot]);
  const settle = useCallback(
    (ack: ComputerAck, nonce: ComputerPending) => {
      if (ack.receipt.phase === 'settled' || ack.receipt.phase === 'interrupted') {
        clearComputer(bot, nonce.id);
        if (live.current) {
          const message = ack.receipt.error ? runtimeError(new Error(ack.receipt.error)) : '';
          setError(message);
          if (message) notify(message);
        }
      } else if (live.current) setError(t('computer.computerActionStillNeedsVerificationWillNot'));
    },
    [bot, notify],
  );
  const inspect = useCallback(
    async (nonce: ComputerPending) => {
      setBusy(true);
      try {
        const ack = await runtime.command<ComputerAck>({
          type: 'computer.receipt',
          id: nonce.id,
          bot,
        });
        if (pendingComputer(bot)?.id === nonce.id) settle(ack, nonce);
      } catch (cause) {
        if (live.current) setError(runtimeError(cause));
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [bot, runtime.command, settle],
  );
  useEffect(() => {
    if (!ready || !pending || restored.current !== pending.id) return;
    restored.current = undefined;
    inspect(pending).catch((cause) => {
      if (live.current) setError(runtimeError(cause));
    });
  }, [pending, ready, inspect]);
  async function run(action: 'connect' | 'stop') {
    if (busy || running || changing || !ready || !available || storageError) return;
    try {
      const existing = pendingComputer(bot);
      if (existing) {
        setPending(existing);
        setError(t('computer.computerActionNeedsVerificationCheckResultFirst'));
        return;
      }
      if (action === 'stop' && (!stop?.saved || stale)) return;
      const request: ComputerRequest =
        action === 'connect'
          ? { id: crypto.randomUUID(), bot, action, revision: computer.revision }
          : {
              id: crypto.randomUUID(),
              bot,
              action,
              revision: stop!.revision,
              ...(stop!.instance === undefined ? {} : { instance: stop!.instance }),
              confirmation: 'close-apps',
            };
      const nonce: ComputerPending = {
        id: request.id,
        bot,
        action,
        revision: request.revision,
        ...(request.instance === undefined ? {} : { instance: request.instance }),
      };
      beginComputer(nonce);
      setPending(nonce);
      setBusy(true);
      setError('');
      try {
        const ack = await runtime.command<ComputerAck>({ type: 'computer.action', request });
        settle(ack, nonce);
        if (live.current) setStop(undefined);
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : '';
        if (definite.has(code)) clearComputer(bot, nonce.id);
        if (live.current) {
          const message = definite.has(code)
            ? runtimeError(cause)
            : t('computer.operationResultUnconfirmedCheckComputerStateNo');
          setError(message);
          notify(message);
        }
      } finally {
        if (live.current) setBusy(false);
      }
    } catch (cause) {
      if (live.current) {
        setError(runtimeError(cause));
        notify(runtimeError(cause));
      }
    }
  }
  const stopButton = () =>
    setStop({ revision: computer.revision, instance: computer.instance, saved: false });
  const locked =
    busy ||
    running ||
    changing ||
    !ready ||
    !available ||
    !!pending ||
    storageError ||
    recoveryBlocked(runtime.snapshot);
  const inspectButton = pending && (
    <IconButton
      label={t('computer.verifyComputerAction')}
      disabled={busy || !ready}
      onClick={() => inspect(pending)}
    >
      <CircleAlert size={16} />
    </IconButton>
  );
  const dialog = stop && (
    <Dialog title={t('computer.stopBotComputer', { 0: name })} onClose={closeStop}>
      <p className="dialog-description">{t('computer.appsScreenWillCloseChatsDocumentsSaved')}</p>
      <label className="connection-confirm">
        <input
          type="checkbox"
          checked={stop.saved}
          disabled={busy}
          onChange={(event) =>
            setStop((current) => (current ? { ...current, saved: event.target.checked } : current))
          }
        />
        {t('computer.iSavedUnsavedContentComputer')}
      </label>
      {stale && (
        <p role="alert" className="connection-error">
          {t('computer.computerStateChangedCloseConfirmationVerifyAgain')}
        </p>
      )}
      {error && (
        <p role="alert" className="connection-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={closeStop}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!stop.saved || stale || locked}
          onClick={() => run('stop')}
        >
          {busy ? t('computer.stopping') : t('computer.stopComputer')}
        </button>
      </div>
    </Dialog>
  );
  if (computer.phase === 'connected')
    return (
      <>
        {inspectButton}
        <IconButton label={t('computer.stopComputer')} disabled={locked} onClick={stopButton}>
          <Power size={16} />
        </IconButton>
        {(pending || error || running) && (
          <p
            role={error ? 'alert' : 'status'}
            className={`connection-feedback ${error ? 'connection-error' : ''}`}
          >
            {pending && <span>{t('computer.computerActionResultNeedsVerificationWillNot')}</span>}
            {error && <span>{error}</span>}
            {running && <span>{t('computer.botHasRunningTaskFinishStoppingComputer')}</span>}
          </p>
        )}
        {dialog}
      </>
    );
  return (
    <section
      className="panel-section connection"
      aria-label={t('computer.computerConnection', { 0: name })}
    >
      <h2>
        {status?.available === false
          ? t('computer.computerServiceUnavailable')
          : t(headings[computer.phase])}
      </h2>
      <p className="connection-description">
        {changing
          ? t('computer.botCannotAcceptNewTasksWhileComputer')
          : t('computer.runsLocallyEachBotHasOwnScreen')}
      </p>
      {changing && (
        <p role="status" className="connection-description">
          {computer.phase === 'connecting'
            ? t('computer.startingIndependentScreenPleaseWait')
            : t('computer.closingBotSAppsVerifyingResources')}
        </p>
      )}
      {computer.recovery === 'restart' ? (
        <div role="status" className="connection-description">
          <p>{t('computer.previousResourceCleanupUnconfirmedSoSlotRemains')}</p>
          {onRecovery && runtime.snapshot.protocolVersion >= 24 ? (
            <button type="button" className="secondary" onClick={onRecovery}>
              {t('computer.checkRecoverEntireEnvironment')}
            </button>
          ) : (
            <p>{t('computer.restartLocalVmManuallyThenReconnect')}</p>
          )}
        </div>
      ) : (
        <div className="connection-actions">
          {computer.reserved ? (
            <button type="button" className="secondary" disabled={locked} onClick={stopButton}>
              {changing ? t('computer.pleaseWait') : t('computer.retryStop')}
            </button>
          ) : runtime.snapshot.agent?.execution === 'local-workspace' &&
            runtime.snapshot.computerAccess ? (
            <p className="connection-description">{t('localComputer.onDemand')}</p>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={locked || full || !registered}
              onClick={() => run('connect')}
            >
              {t('computer.connectComputer')}
            </button>
          )}
          {inspectButton}
        </div>
      )}
      {status && (
        <p className="connection-capacity">
          {t('computer.currentRuntimeUsing')}
          {occupied}/{status.limit}
          {t('computer.computerSlots')}
          {full ? t('computer.stopAnotherBotSComputerFirst') : '。'}
        </p>
      )}
      {running && (
        <p className="connection-description">
          {t('computer.botHasRunningTaskFinishOperatingComputer')}
        </p>
      )}
      {!registered && ready && (
        <p className="connection-description">{t('common.syncingBotProfilesPleaseWait')}</p>
      )}
      {error && (
        <p role="alert" className="connection-error">
          {error}
        </p>
      )}
      {dialog}
    </section>
  );
}
