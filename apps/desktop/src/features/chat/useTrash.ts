import {
  agentId,
  agentTask,
  type ConversationAck,
  type ConversationRequest,
  isConversationAck,
  recoveryBlocked,
  sameConversationRequest,
} from '@daban/protocol';
import { type Dispatch, useRef, useState } from 'react';
import { clientCache } from '../../app/cache';
import { profileInput } from '../../app/profiles';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { type Action, lifecycleRequest, reduce, type State } from '../../app/state';
import { serialize, storageKey } from '../../app/storage';
import { t } from '../../i18n/locale';
import { conversationPending, conversationState } from './conversations';

interface Target {
  bot: string;
  revision: number;
  title: string;
  action: ConversationRequest['action'];
}
export interface TrashIssue extends Target {
  error: string;
  task?: boolean;
  archived?: boolean;
}
const definite = new Set([
  'INVALID_CONVERSATION_REQUEST',
  'CONVERSATION_CONFLICT',
  'CONVERSATION_TRASHED',
  'CONVERSATION_REQUEST_ID_REUSED',
  'CHAT_BUSY',
  'CHAT_NOT_FOUND',
  'CHAT_LIMIT',
  'BOT_ARCHIVED',
  'BOT_PROFILE_NOT_FOUND',
  'UNKNOWN_BOT',
  'RUNTIME_TOO_OLD',
]);
export function useTrash(
  state: State,
  dispatch: Dispatch<Action>,
  applied: (ack: ConversationAck, bot: string) => unknown,
) {
  const runtime = useRuntime();
  const current = useRef(state);
  current.current = state;
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<TrashIssue>();
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 47 &&
    runtime.snapshot.chats?.available === true;
  function commit(action: Action) {
    const next = reduce(current.current, action);
    // Save the exact intent before sending; reopening must only offer an explicit receipt check or retry.
    clientCache().setItem(storageKey, serialize(next));
    current.current = next;
    dispatch(action);
  }
  function block(target: Target): TrashIssue | undefined {
    const state = current.current;
    const bot = state.bots.find((bot) => bot.id === target.bot);
    if (!bot || bot.members) return { ...target, error: t('trash.unavailable') };
    const task = agentTask(runtime.snapshot, bot.id);
    if (task?.running && !task.conversationId && (task.chatRevision ?? 0) === target.revision)
      return { ...target, task: true, error: t('trash.taskRunning') };
    if (
      bot.archived ||
      runtime.snapshot.profiles.find((profile) => profile.id === agentId(bot.id))?.archived
    )
      return { ...target, archived: true, error: t('trash.botArchived') };
    if (
      state.runtimeRequests[bot.id] ||
      state.attachmentUploads[bot.id] ||
      state.chatRequests[bot.id] ||
      lifecycleRequest(state, bot.id)
    )
      return { ...target, error: t('trash.otherPending') };
    if (!available || recoveryBlocked(runtime.snapshot))
      return { ...target, error: t('trash.unavailable') };
    return undefined;
  }
  async function execute(target: Target, request: ConversationRequest, receipt = false) {
    if (working.current) return;
    const blocked = receipt
      ? !available
        ? { ...target, error: t('trash.unavailable') }
        : undefined
      : block(target);
    if (blocked) {
      setIssue(blocked);
      return;
    }
    working.current = true;
    setBusy(true);
    try {
      if (!receipt) {
        commit({ type: 'conversation-pending', request });
        const bot = current.current.bots.find((bot) => bot.id === target.bot)!;
        if (!runtime.snapshot.profiles.some((profile) => profile.id === request.bot)) {
          // Explicitly organizing an unsent editor may register its identity, but never starts a model task.
          await runtime.command({
            type: 'bot.register',
            profile: profileInput(bot, current.current.memories[bot.id] ?? ''),
          });
        }
      }
      const value = await runtime.command({
        type: receipt ? 'conversation.receipt' : 'conversation.action',
        request,
      });
      if (!isConversationAck(value) || !sameConversationRequest(value.receipt.request, request))
        throw new Error('INVALID_CONVERSATION_ACK');
      commit({ type: 'conversation-result', ack: value });
      setIssue(undefined);
      applied(value, target.bot);
    } catch (error) {
      if (!receipt && error instanceof Error && definite.has(error.message)) {
        try {
          commit({ type: 'conversation-clear', request });
        } catch {
          /* Retain the intent if storage cannot confirm the rejected operation was cleared. */
        }
      }
      const blocked = block(target);
      setIssue(
        blocked?.task || blocked?.archived ? blocked : { ...target, error: runtimeError(error) },
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function start(
    bot: string,
    revision: number,
    title: string,
    action: ConversationRequest['action'],
    expectedVersion?: number,
  ) {
    const target = { bot, revision, title: title.slice(0, 120), action };
    const pending = conversationPending(current.current, bot, revision);
    if (pending) {
      setIssue({ ...target, action: pending.action, error: t('trash.pending') });
      return;
    }
    const version =
      conversationState(current.current, bot, revision, runtime.snapshot.chats)?.version ?? 0;
    if (expectedVersion !== undefined && version !== expectedVersion) {
      setIssue({ ...target, error: t('trash.changed') });
      return;
    }
    return execute(target, {
      id: crypto.randomUUID(),
      bot: agentId(bot),
      revision,
      version,
      action,
      title: target.title,
    });
  }
  function verify(bot: string, revision: number) {
    const request = conversationPending(current.current, bot, revision);
    if (!request) return;
    return execute({ bot, revision, title: request.title, action: request.action }, request, true);
  }
  function retry() {
    if (!issue) return;
    const request = conversationPending(current.current, issue.bot, issue.revision);
    return request
      ? execute(issue, request)
      : start(issue.bot, issue.revision, issue.title, issue.action);
  }
  return {
    busy,
    issue,
    available,
    verify,
    retry,
    close: () => setIssue(undefined),
    move: (bot: string, revision: number, title: string) => start(bot, revision, title, 'trash'),
    restore: (bot: string, revision: number, title: string, version?: number) =>
      start(bot, revision, title, 'restore', version),
  };
}
export type TrashController = ReturnType<typeof useTrash>;
