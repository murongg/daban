import {
  agentId,
  agentTask,
  type BotLifecycleAck,
  type BotLifecycleRequest,
} from '@daban/protocol';
import { Archive as ArchiveIcon, RotateCcw } from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';
import { type Action, type Bot, lifecycleRequest, type Panel, type State } from './state';

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
        ? t('Bot 已归档，历史和草稿保留。')
        : t('Bot 已恢复，自动任务仍需手动重新启用。'),
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
            ? t('运行环境已重新连接，请先核对这次 Bot 操作的结果。')
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
    else setNotice(t('归档尚未完成。这位 Bot 暂不接收新任务，可继续核对或完成同一次归档。'));
  }
  return (
    <Dialog title={action === 'archive' ? t('归档 Bot') : t('恢复 Bot')} onClose={close}>
      <div className="archive-identity">
        <Avatar bot={bot} />
        <strong>{bot.name}</strong>
      </div>
      <p className="dialog-description">
        {action === 'archive'
          ? t(
              '归档会暂停这位 Bot 的使用入口、停用它的定时任务。聊天、文件、资料、偏好和未发送草稿都会保留。',
            )
          : t(
              '恢复这位 Bot 的对话入口，继续使用保留的历史与偏好。电脑和旧任务不会自动启动，定时任务需要手动重新启用。',
            )}
      </p>
      {!available && (
        <p className="inline-note">
          {runtime.snapshot.protocolVersion < 22
            ? t('更新本地运行环境后可使用 Bot 归档与恢复。')
            : t('原 Bot 记录暂未连接，客户端保留的历史仍在。')}
        </p>
      )}
      {task?.running && (
        <div className="inline-note">
          <p>{t('先结束正在进行的任务，再归档。')}</p>
          <button
            className="secondary"
            type="button"
            onClick={() => navigate(task.conversationId ?? bot.id)}
          >
            {t('查看当前任务')}
          </button>
        </div>
      )}
      {connected && (
        <div className="inline-note">
          <p>{t('先停止电脑并确认已保存其中的内容，再归档。')}</p>
          <button className="secondary" type="button" onClick={() => navigate(bot.id, 'computer')}>
            {t('管理电脑')}
          </button>
        </div>
      )}
      {resourceUnknown && available && (
        <p className="inline-note">{t('电脑状态暂不可核对，请恢复运行环境后再操作。')}</p>
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
          {t(
            '这次操作结果待核对。核对只读取回执；重试沿用同一次操作。关闭窗口不会撤回已提交的操作。',
          )}
        </p>
      )}
      {later && (
        <div className="inline-note">
          <p>{t('这位 Bot 已有后续操作，可采用当前资料状态。')}</p>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              dispatch({ type: 'lifecycle-clear', bot: bot.id, id: pending!.id });
              close();
            }}
          >
            {t('采用当前资料状态')}
          </button>
        </div>
      )}
      <div className="dialog-actions archive-actions">
        <button className="text-button" type="button" disabled={busy} onClick={close}>
          {t('关闭')}
        </button>
        {pending && (
          <button
            className="secondary"
            type="button"
            disabled={busy || !available}
            onClick={() => perform(inspect)}
          >
            {t('核对操作结果')}
          </button>
        )}
        <button
          className="primary"
          type="button"
          disabled={busy || !available || !!task?.running || connected || resourceUnknown || later}
          onClick={() => perform(submit)}
        >
          {busy
            ? t('正在处理…')
            : pending
              ? t('重试同一次操作')
              : action === 'archive'
                ? t('确认归档')
                : t('确认恢复')}
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
      <h2>{t('已归档')}</h2>
      <p className="setting-description">
        {t('历史和草稿保留。Bot 的自动任务需手动重新启用；恢复群聊不会派发旧消息。')}
      </p>
      {!bots.length && <p className="inline-note">{t('归档的 Bot 和群聊会出现在这里。')}</p>}
      {bots.map((bot) => {
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
              <p className="setting-description">{pending ? t('操作待核对') : t('已归档')}</p>
            </div>
            <div className="model-actions">
              <button
                className="secondary"
                type="button"
                aria-label={t('查看历史 {0}', { 0: bot.name })}
                onClick={() => dispatch({ type: 'select', bot: bot.id })}
              >
                {t('查看历史')}
              </button>
              <button
                className="secondary"
                type="button"
                aria-label={`${pending ? t('核对操作') : t('恢复')} ${bot.name}`}
                disabled={!onAction || runtime.snapshot.protocolVersion < (bot.members ? 28 : 22)}
                onClick={() => onAction?.(bot.id)}
              >
                {pending ? <ArchiveIcon /> : <RotateCcw />}
                {pending ? t('核对操作') : t('恢复')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
