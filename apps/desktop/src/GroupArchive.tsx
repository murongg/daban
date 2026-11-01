import {
  type GroupActionAck,
  type GroupActionRequest,
  isGroupActionAck,
  recoveryBlocked,
} from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';
import type { Action, Bot, State } from './state';

const definite = new Set([
  'INVALID_GROUP_ACTION',
  'GROUP_BUSY',
  'GROUP_CONFLICT',
  'GROUP_STATE_CONFLICT',
  'GROUP_ACTION_ID_REUSED',
  'GROUP_ACTION_LIMIT',
  'GROUP_NOT_FOUND',
  'GROUP_LIFECYCLE_UNAVAILABLE',
  'RUNTIME_TOO_OLD',
  'RUNTIME_RECOVERY_PENDING',
]);
export function GroupArchive({
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
  navigate?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime(),
    current = runtime.snapshot.groups?.items.find((group) => group.id === bot.id);
  // A committed acknowledgement can arrive before the next snapshot; never offer its opposite operation from stale metadata.
  const acknowledged = (state.groupRevisions[bot.id] || 0) > (current?.revision || 0);
  const revision = acknowledged ? state.groupRevisions[bot.id] : current?.revision;
  const pending = state.groupActions[bot.id];
  const action =
    pending?.action ??
    ((current && !acknowledged ? current.archived : bot.archived) ? 'restore' : 'archive');
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 28 &&
    !!runtime.snapshot.groups?.available &&
    !!current;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [code, setCode] = useState('');
  const mounted = useRef(true),
    working = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function apply(value: unknown, request: GroupActionRequest) {
    if (
      !isGroupActionAck(value) ||
      value.group.id !== request.group ||
      value.receipt.request.id !== request.id ||
      value.receipt.request.group !== request.group ||
      value.receipt.request.action !== request.action ||
      value.receipt.request.revision !== request.revision
    )
      throw new Error('INVALID_GROUP_ACTION_ACK');
    // Canonical metadata may update after the dialog closes; neither acknowledgement selects another chat.
    dispatch({ type: 'groups', groups: [value.group] });
    dispatch({ type: 'group-action-clear', group: request.group, id: request.id });
    if (!mounted.current) return;
    notify(
      value.group.revision !== value.receipt.revision
        ? t('grouparchive.earlierOperationCompletedGroupWasUpdatedLater')
        : request.action === 'archive'
          ? t('grouparchive.groupArchivedHistoryFilesDraftsRetained')
          : t('grouparchive.groupRestoredOldMessagesNotDispatchedAutomatically'),
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
        setError(runtimeError(error));
        setCode(error instanceof Error ? error.message : '');
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function submit() {
    if (!revision || recoveryBlocked(runtime.snapshot)) return;
    const request: GroupActionRequest = pending ?? {
      id: crypto.randomUUID(),
      group: bot.id,
      action,
      revision,
    };
    dispatch({ type: 'group-action-pending', request });
    try {
      apply(await runtime.command<GroupActionAck>({ type: 'group.action', request }), request);
    } catch (error) {
      if (error instanceof Error && definite.has(error.message))
        dispatch({ type: 'group-action-clear', group: request.group, id: request.id });
      throw error;
    }
  }
  return (
    <Dialog
      title={action === 'archive' ? t('common.archiveGroup') : t('common.restoreGroup')}
      onClose={close}
    >
      <div className="archive-identity">
        <Avatar bot={bot} />
        <strong>{acknowledged ? bot.name : current?.name || bot.name}</strong>
      </div>
      <p className="dialog-description">
        {action === 'archive'
          ? t('grouparchive.archivingStopsNewCollaborationMembersHistoryAttachments')
          : t('grouparchive.restoreAccessGroupOldMessagesNotDispatched')}
      </p>
      {!available && (
        <p className="inline-note">
          {t('grouparchive.connectUpdatedLocalEnvironmentArchiveRestoreVerify')}
        </p>
      )}
      {pending && (
        <p className="inline-note">
          {t('grouparchive.previous')}
          {pending.action === 'archive' ? t('common.archive') : t('common.restore')}
          {t('grouparchive.needsVerificationClosingDialogDoesNotWithdraw')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {code === 'GROUP_BUSY'
            ? t('grouparchive.finishGroupSOngoingCollaborationArchivingMembers')
            : error}
        </p>
      )}
      {code === 'GROUP_BUSY' && navigate && (
        <button className="secondary" type="button" onClick={navigate}>
          {t('grouparchive.backGroup')}
        </button>
      )}
      <div className="dialog-actions">
        <button className="text-button" type="button" onClick={close}>
          {t('common.close')}
        </button>
        {pending && (
          <button
            className="secondary"
            type="button"
            disabled={busy || !available}
            onClick={() =>
              perform(async () =>
                apply(
                  await runtime.command({
                    type: 'group.receipt',
                    group: pending.group,
                    id: pending.id,
                  }),
                  pending,
                ),
              )
            }
          >
            {t('common.verifyOperationResult')}
          </button>
        )}
        <button
          className="primary"
          type="button"
          disabled={busy || !available || recoveryBlocked(runtime.snapshot)}
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
