import {
  agentId,
  agentTask,
  type ChatAck,
  type ChatRequest,
  isChatAck,
  recoveryBlocked,
} from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';
import { type Action, type Bot, chatRevision, lifecycleRequest, type State } from './state';

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
        ? t('已开启新对话，旧记录和未发送草稿保留。')
        : t('此前操作已完成，当前已是更新的对话。'),
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
    <Dialog title={t('开启新对话')} onClose={close}>
      <div className="archive-identity">
        <Avatar bot={bot} />
        <strong>{bot.name}</strong>
      </div>
      <p className="dialog-description">
        {t(
          '新对话使用全新的模型上下文。旧记录可在历史对话中阅读，工作偏好、资料、文件、电脑和浏览器登录状态保持原样。未发送的文字和附件会保留，不会自动发送。',
        )}
      </p>
      {!available && (
        <p className="inline-note">{t('连接更新后的本地环境，才能开启新对话或核对操作。')}</p>
      )}
      {!!state.runtimeRequests[bot.id] && (
        <p className="inline-note">{t('有一条消息的发送结果尚待确认，请先在对话里核对。')}</p>
      )}
      {task?.running && !task.conversationId && (
        <p className="inline-note">{t('先结束当前私聊任务，再开启新对话。群聊任务不受影响。')}</p>
      )}
      {pending && (
        <p className="inline-note">
          {t('上一次开启操作尚待核对。关闭弹窗不会撤回已提交的操作，请核对结果或重试同一次操作。')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="text-button" type="button" onClick={close}>
          {t('关闭')}
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
            {t('核对操作结果')}
          </button>
        )}
        <button
          className="primary"
          type="button"
          disabled={busy || !canWrite}
          onClick={() => perform(submit)}
        >
          {busy ? t('正在处理…') : pending ? t('重试同一次操作') : t('确认开启')}
        </button>
      </div>
    </Dialog>
  );
}
