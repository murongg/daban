import {
  agentId,
  agentTask,
  type ChatAck,
  type ChatRequest,
  isChatAck,
  recoveryBlocked,
} from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { type Action, type Bot, chatRevision, lifecycleRequest, type State } from '../../app/state';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';

const definite = new Set([
  'INVALID_CHAT_REQUEST',
  'CHAT_BUSY',
  'CHAT_CONFLICT',
  'CHAT_REQUEST_ID_REUSED',
  'CHAT_LIMIT',
  'BOT_ARCHIVED',
  'BOT_CHANGING',
  'BOT_PROFILE_NOT_FOUND',
]);
export function NewChat({
  state,
  bot,
  dispatch,
  close,
  notify,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  close: () => unknown;
  notify: (text: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const pending = state.chatRequests[bot.id];
  const revision = chatRevision(state, bot.id, runtime.snapshot.chats);
  const task = agentTask(runtime.snapshot, bot.id);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 29 &&
    !!runtime.snapshot.chats?.available;
  const canWrite =
    available &&
    !recoveryBlocked(runtime.snapshot) &&
    !bot.archived &&
    !lifecycleRequest(state, bot.id) &&
    !state.runtimeRequests[bot.id] &&
    !(task?.running && !task.conversationId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const working = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function apply(value: unknown, request: ChatRequest) {
    if (
      !isChatAck(value) ||
      value.chat.bot !== request.bot ||
      value.receipt.request.id !== request.id ||
      value.receipt.request.revision !== request.revision
    )
      throw new Error('INVALID_CHAT_ACK');
    dispatch({ type: 'chats', items: [value.chat] });
    dispatch({ type: 'chat-clear', bot: bot.id, id: request.id });
    if (!mounted.current) return;
    notify(
      value.chat.revision === value.receipt.revision
        ? t('newchat.newConversationOpenedOldHistoryUnsentDrafts')
        : t('newchat.earlierOperationCompletedNewerConversationNowCurrent'),
    );
    close();
  }
  async function perform(operation: () => Promise<unknown>) {
    if (working.current || !available) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function submit() {
    if (!canWrite) return;
    const request: ChatRequest = pending ?? {
      id: crypto.randomUUID(),
      bot: agentId(bot.id),
      revision,
    };
    dispatch({ type: 'chat-pending', bot: bot.id, request });
    try {
      apply(await runtime.command<ChatAck>({ type: 'chat.new', request }), request);
    } catch (error) {
      if (error instanceof Error && definite.has(error.message))
        dispatch({ type: 'chat-clear', bot: bot.id, id: request.id });
      throw error;
    }
  }
  return (
    <Dialog title={t('common.newConversation')} onClose={close}>
      <div className="archive-identity">
        <Avatar bot={bot} />
        <strong>{bot.name}</strong>
      </div>
      <p className="dialog-description">{t('newchat.newConversationStartsFreshModelContextOld')}</p>
      {!available && (
        <p className="inline-note">
          {t('newchat.connectUpdatedLocalEnvironmentStartConversationsVerify')}
        </p>
      )}
      {!!state.runtimeRequests[bot.id] && (
        <p className="inline-note">{t('newchat.oneMessageHasUnconfirmedSendResultVerify')}</p>
      )}
      {task?.running && !task.conversationId && (
        <p className="inline-note">
          {t('newchat.finishCurrentPrivateTaskStartingNewConversation')}
        </p>
      )}
      {pending && (
        <p className="inline-note">
          {t('newchat.previousRequestOpenConversationNeedsVerificationClosing')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
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
                  await runtime.command({ type: 'chat.receipt', bot: pending.bot, id: pending.id }),
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
          disabled={busy || !canWrite}
          onClick={() => perform(submit)}
        >
          {busy
            ? t('common.processing')
            : pending
              ? t('common.retrySameOperation')
              : t('newchat.confirmNewConversation')}
        </button>
      </div>
    </Dialog>
  );
}
