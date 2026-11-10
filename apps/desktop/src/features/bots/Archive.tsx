import {
  agentId,
  agentTask,
  type BotLifecycleAck,
  type BotLifecycleRequest,
} from '@daban/protocol';
import { Archive as ArchiveIcon, RotateCcw } from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { type Action, type Bot, lifecycleRequest, type Panel, type State } from '../../app/state';
import { WindowList } from '../../components/collection/WindowList';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';
import { Avatar } from './Avatar';

const definite = new Set([
  'INVALID_BOT_LIFECYCLE',
  'BOT_TASK_RUNNING',
  'BOT_COMPUTER_CONNECTED',
  'BOT_COMPUTER_STATE_UNAVAILABLE',
  'BOT_GROUP_PENDING',
  'BOT_PROFILE_CONFLICT',
  'BOT_PROFILE_NOT_FOUND',
  'BOT_REQUEST_ID_REUSED',
  'BOT_RESTORE_NOT_READY',
  'BOT_ARCHIVED',
]);
export function Archive({
  state,
  bot,
  dispatch,
  close,
  notify,
  navigate,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  close: () => unknown;
  notify: (message: string) => unknown;
  navigate: (bot: string, panel?: Panel) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const target = agentId(bot.id);
  const profile = runtime.snapshot.profiles.find((entry) => entry.id === target);
  const pending = lifecycleRequest(state, bot.id, profile);
  const action = pending?.action ?? (profile?.archived || bot.archived ? 'restore' : 'archive');
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 22 &&
    !!profile;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true),
    working = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const task = agentTask(runtime.snapshot, bot.id);
  const connection = runtime.snapshot.computers?.items.find((entry) => entry.bot === target);
  const connected =
    !!connection && (connection.reserved || !['disconnected', 'failed'].includes(connection.phase));
  const resourceUnknown = runtime.snapshot.computers?.available !== true;
  const groups = state.bots.filter((entry) => entry.members?.some((id) => agentId(id) === target));
  const later =
    !!pending &&
    !!profile?.lifecycle &&
    profile.lifecycle.id !== pending.id &&
    profile.revision > pending.revision;
  function applied(value: BotLifecycleAck, request: BotLifecycleRequest) {
    if (!mounted.current) return;
    dispatch({ type: 'profiles', profiles: [value.profile] });
    dispatch({ type: 'lifecycle-clear', bot: bot.id, id: request.id });
    notify(
      request.action === 'archive'
        ? t('archive.botArchivedHistoryDraftsRetained')
        : t('archive.botRestoredAutomaticTasksMustEnabledAgain'),
    );
    close();
  }
  async function perform(operation: () => Promise<unknown>) {
    if (working.current || !available) return;
    working.current = true;
    setBusy(true);
    setError('');
    setCode('');
    try {
      await operation();
    } catch (error) {
      if (mounted.current) {
        setError(
          error instanceof Error && error.message === 'RUNTIME_SESSION_CHANGED'
            ? t('archive.runtimeReconnectedVerifyBotOperationSResult')
            : runtimeError(error),
        );
        setCode(error instanceof Error ? error.message : '');
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function submit() {
    if (!profile) return;
    const request = pending ?? {
      id: crypto.randomUUID(),
      bot: target,
      action,
      revision: profile.revision,
    };
    dispatch({ type: 'lifecycle-pending', bot: bot.id, request });
    try {
      const result = await runtime.command<BotLifecycleAck>({ type: 'bot.action', request });
      applied(result, request);
    } catch (error) {
      if (error instanceof Error && definite.has(error.message))
        dispatch({ type: 'lifecycle-clear', bot: bot.id, id: request.id });
      throw error;
    }
  }
  async function inspect() {
    if (!pending) return;
    const value = await runtime.command<BotLifecycleAck>({
      type: 'bot.receipt',
      bot: target,
      id: pending.id,
    });
    if (!mounted.current) return;
    dispatch({ type: 'profiles', profiles: [value.profile] });
    if (value.receipt.phase === 'complete') applied(value, pending);
    else setNotice(t('archive.archivingIncompleteBotCannotAcceptNewTasks'));
  }
  return (
    <Dialog
      title={action === 'archive' ? t('common.archiveBot') : t('common.restoreBot')}
      onClose={close}
    >
      <div className="archive-identity">
        <Avatar bot={bot} />
        <strong>{bot.name}</strong>
      </div>
      <p className="dialog-description">
        {action === 'archive'
          ? t('archive.archivingRemovesBotSActiveEntryDisables')
          : t('archive.restoreAccessBotSConversationRetainedHistory')}
      </p>
      {!available && (
        <p className="inline-note">
          {runtime.snapshot.protocolVersion < 22
            ? t('archive.updateLocalRuntimeArchiveRestoreBots')
            : t('archive.originalBotRecordsDisconnectedLocallyCachedHistory')}
        </p>
      )}
      {task?.running && (
        <div className="inline-note">
          <p>{t('archive.finishOngoingTasksArchiving')}</p>
          <button
            className="secondary"
            type="button"
            onClick={() => navigate(task.conversationId ?? bot.id)}
          >
            {t('archive.viewCurrentTask')}
          </button>
        </div>
      )}
      {connected && (
        <div className="inline-note">
          <p>{t('archive.stopComputerConfirmContentSavedArchiving')}</p>
          <button className="secondary" type="button" onClick={() => navigate(bot.id, 'computer')}>
            {t('archive.manageComputer')}
          </button>
        </div>
      )}
      {resourceUnknown && available && (
        <p className="inline-note">
          {t('archive.computerStateCannotVerifiedRecoverRuntimeActing')}
        </p>
      )}
      {code === 'BOT_GROUP_PENDING' && (
        <div className="inline-note">
          <div className="inline-form-actions">
            {groups.map((group) => (
              <button
                className="secondary"
                type="button"
                key={group.id}
                onClick={() => navigate(group.id)}
              >
                {group.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="inline-note" role="status">
          {notice}
        </p>
      )}
      {pending && (
        <p className="inline-note">
          {t('archive.resultNeedsVerificationCheckingOnlyReadsReceipt')}
        </p>
      )}
      {later && (
        <div className="inline-note">
          <p>{t('archive.botHasSubsequentOperationsCanUseCurrent')}</p>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              dispatch({ type: 'lifecycle-clear', bot: bot.id, id: pending!.id });
              close();
            }}
          >
            {t('archive.useCurrentProfileState')}
          </button>
        </div>
      )}
      <div className="dialog-actions archive-actions">
        <button className="text-button" type="button" disabled={busy} onClick={close}>
          {t('common.close')}
        </button>
        {pending && (
          <button
            className="secondary"
            type="button"
            disabled={busy || !available}
            onClick={() => perform(inspect)}
          >
            {t('common.verifyOperationResult')}
          </button>
        )}
        <button
          className="primary"
          type="button"
          disabled={busy || !available || !!task?.running || connected || resourceUnknown || later}
          onClick={() => perform(submit)}
        >
          {busy
            ? t('common.processing')
            : pending
              ? t('common.retrySameOperation')
              : action === 'archive'
                ? t('common.confirmArchive')
                : t('common.confirmRestore')}
        </button>
      </div>
    </Dialog>
  );
}

export function ArchiveList({
  state,
  dispatch,
  onAction,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  onAction?: (bot: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const bots = state.bots.filter(
    (bot) =>
      bot.archived || (bot.members ? state.groupActions[bot.id] : lifecycleRequest(state, bot.id)),
  );
  return (
    <div className="settings-section">
      <h2>{t('common.archived')}</h2>
      <div className="settings-group">
        <p className="setting-description">
          {t('archive.historyDraftsRetainedReEnableBotAutomation')}
        </p>
        {!bots.length && <p className="inline-note">{t('archive.archivedBotsGroupsAppearHere')}</p>}
        <WindowList
          scope="archived-bots"
          items={bots}
          getKey={(bot) => bot.id}
          renderItem={(bot) => {
            const pending = bot.members
              ? state.groupActions[bot.id]
              : lifecycleRequest(
                  state,
                  bot.id,
                  runtime.snapshot.profiles.find((entry) => entry.id === agentId(bot.id)),
                );
            return (
              <div className="setting-row archive-row" key={bot.id}>
                <Avatar bot={bot} />
                <div className="archive-copy">
                  <div className="setting-label">{bot.name}</div>
                  <p className="setting-description">
                    {pending ? t('archive.operationNeedsVerification') : t('common.archived')}
                  </p>
                </div>
                <div className="model-actions">
                  <button
                    className="secondary"
                    type="button"
                    aria-label={t('archive.viewItemHistory', { 0: bot.name })}
                    onClick={() => dispatch({ type: 'select', bot: bot.id })}
                  >
                    {t('archive.viewHistory')}
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    aria-label={`${pending ? t('archive.verifyOperation') : t('common.restore')} ${bot.name}`}
                    disabled={
                      !onAction || runtime.snapshot.protocolVersion < (bot.members ? 28 : 22)
                    }
                    onClick={() => onAction?.(bot.id)}
                  >
                    {pending ? <ArchiveIcon /> : <RotateCcw />}
                    {pending ? t('archive.verifyOperation') : t('common.restore')}
                  </button>
                </div>
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}
