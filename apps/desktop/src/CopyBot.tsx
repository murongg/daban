import {
  agentId,
  type BotCopyRequest,
  type BotProfile,
  botCopyKey,
  isBotCopyReceipt,
  modelOptions,
  recoveryBlocked,
} from '@daban/protocol';
import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { runtimeError, useRuntime } from './Runtime';
import { type Action, reduce, type State } from './state';
import { serialize, storageKey } from './storage';

const rejected = new Set([
  'INVALID_COMMAND',
  'INVALID_BOT_COPY',
  'RUNTIME_TOO_OLD',
  'BOT_PROFILE_CONFLICT',
  'BOT_ARCHIVED',
  'BOT_PROFILE_NOT_FOUND',
]);

export function CopyBot({
  state,
  dispatch,
  open,
  bot,
  close,
  notify,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  open: boolean;
  bot?: string;
  close: () => unknown;
  notify: (message: string) => unknown;
}) {
  const runtime = useRuntime();
  const pending = useRef(state.botCopy),
    opened = useRef(open),
    mounted = useRef(true);
  const mutation = useRef<string | undefined>(undefined),
    reader = useRef<string | undefined>(undefined);
  const [working, setWorking] = useState(false),
    [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  pending.current = state.botCopy;
  opened.current = open;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owns = useCallback(
    (request: BotCopyRequest) =>
      mounted.current && !!pending.current && botCopyKey(pending.current) === botCopyKey(request),
    [],
  );
  const handle = useCallback(
    (value: unknown, request: BotCopyRequest) => {
      if (!owns(request)) return;
      if (!isBotCopyReceipt(value) || botCopyKey(value.request) !== botCopyKey(request))
        throw new Error('INVALID_BOT_COPY_ACK');
      if (value.state !== 'complete') return;
      // Retire synchronously: concurrent read/mutation replies must settle this operation only once.
      pending.current = undefined;
      mutation.current = undefined;
      setWorking(false);
      dispatch({ type: 'profiles', profiles: [value.profile] });
      dispatch({ type: 'bot-copy-clear', request });
      setError('');
      if (opened.current) {
        if (!value.profile.archived) dispatch({ type: 'select', bot: value.profile.id });
        close();
      }
      notify(`已复制 ${value.profile.name}。`);
    },
    [owns, dispatch, close, notify],
  );
  const available =
    runtime.enabled && runtime.snapshot.phase === 'ready' && runtime.snapshot.protocolVersion >= 34;
  const check = useCallback(async () => {
    const request = pending.current;
    if (!request || reader.current || !available) return;
    const key = botCopyKey(request);
    reader.current = key;
    setReading(true);
    try {
      handle(await runtime.command({ type: 'bot.copy.receipt', request }), request);
    } catch (error) {
      if (owns(request)) setError(runtimeError(error));
    } finally {
      if (reader.current === key) {
        reader.current = undefined;
        if (mounted.current) setReading(false);
      }
    }
  }, [available, runtime.command, handle, owns]);
  useEffect(() => {
    if (!state.botCopy || !available) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      await check();
      if (live && pending.current)
        timer = setTimeout(() => {
          tick().catch(() => {
            if (live) setError('暂时无法核对复制结果。');
          });
        }, 1000);
    }
    tick().catch(() => {
      if (live) setError('暂时无法核对复制结果。');
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [state.botCopy, available, check]);
  async function submit(input: BotCopyRequest) {
    if (mutation.current || !available || recoveryBlocked(runtime.snapshot)) return;
    if (pending.current && botCopyKey(pending.current) !== botCopyKey(input)) return;
    const request = { ...input },
      key = botCopyKey(request);
    try {
      // Persist before dispatching the effect; the normal workspace effect may not run before a crash.
      localStorage.setItem(
        storageKey,
        serialize(reduce(state, { type: 'bot-copy-pending', request })),
      );
    } catch {
      setError('本机无法保存复制请求。请先释放存储空间或导出工作区，再重试。');
      return;
    }
    pending.current = request;
    // A placeholder profile would be registered by useProfiles and occupy the copy's target ID.
    dispatch({ type: 'bot-copy-pending', request });
    mutation.current = key;
    setWorking(true);
    setError('');
    try {
      const value = await runtime.command({ type: 'bot.copy', request });
      if (!isBotCopyReceipt(value) || value.state !== 'complete')
        throw new Error('INVALID_BOT_COPY_ACK');
      handle(value, request);
    } catch (error) {
      if (owns(request)) {
        setError(runtimeError(error));
        if (error instanceof Error && rejected.has(error.message)) {
          pending.current = undefined;
          dispatch({ type: 'bot-copy-clear', request });
        }
      }
    } finally {
      if (mutation.current === key) {
        mutation.current = undefined;
        if (mounted.current) setWorking(false);
      }
    }
  }
  if (!open) return null;
  return (
    <CopyEditor
      bot={bot}
      pending={state.botCopy}
      available={available}
      blocked={recoveryBlocked(runtime.snapshot)}
      working={working}
      reading={reading}
      error={error}
      submit={submit}
      check={check}
      close={close}
    />
  );
}

function CopyEditor({
  bot,
  pending,
  available,
  blocked,
  working,
  reading,
  error,
  submit,
  check,
  close,
}: {
  bot?: string;
  pending?: BotCopyRequest;
  available: boolean;
  blocked: boolean;
  working: boolean;
  reading: boolean;
  error: string;
  submit: (request: BotCopyRequest) => Promise<unknown>;
  check: () => Promise<unknown>;
  close: () => unknown;
}) {
  const runtime = useRuntime();
  const id = bot ? agentId(bot) : pending?.bot;
  const [source, setSource] = useState<BotProfile | undefined>(() => {
    const profile = runtime.snapshot.profiles.find((profile) => profile.id === id);
    return profile && { ...profile };
  });
  const latest = runtime.snapshot.profiles.find((profile) => profile.id === (source?.id ?? id));
  const [name, setName] = useState(
    () =>
      pending?.name ?? `${(latest?.name ?? '').slice(0, 27).replace(/[\uD800-\uDBFF]$/, '')} 副本`,
  );
  const [memory, setMemory] = useState(pending?.memory ?? true);
  const inactive =
    !source ||
    source.archived ||
    source.lifecycle?.phase === 'pending' ||
    latest?.archived ||
    latest?.lifecycle?.phase === 'pending';
  return (
    <Dialog title="复制 Bot" onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!source || pending || inactive || !name.trim() || name.includes('\0')) return;
          submit({
            id: crypto.randomUUID(),
            bot: source.id,
            revision: source.revision,
            name: name.trim(),
            memory,
          }).catch(() => {});
        }}
      >
        <p className="dialog-description">
          创建独立的新
          Bot，复制已保存的职责、颜色和模型选择。资料与技能可通过导入导出迁移；聊天、日程和工具授权不复制。
        </p>
        {!available && (
          <p className="form-error" role="alert">
            请先更新并连接本地运行环境，再复制 Bot。
          </p>
        )}
        {blocked && (
          <p className="inline-note">运行环境正在恢复，可以核对结果，恢复完成后可重试复制。</p>
        )}
        {pending ? (
          <div className="bundle-progress" role="status">
            <strong>{pending.name}</strong>
            <p>复制结果尚未确认。关闭后仍会保留原请求；重开只核对结果。</p>
            <p className="inline-note">重试沿用同一次请求，不会重复创建 Bot。</p>
          </div>
        ) : source ? (
          <div className="form-stack">
            <p className="inline-note">来源：{source.name}</p>
            <label className="field-label">
              新 Bot 名称
              <input
                className="field"
                data-autofocus
                maxLength={30}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field-label">
              职责
              <textarea className="field" rows={3} value={source.instructions} readOnly />
            </label>
            <p className="inline-note">
              模型：
              {source.model
                ? modelOptions.find((model) => model.id === source.model)?.name
                : '跟随工作区'}
            </p>
            <label className="bundle-choice">
              <input
                type="checkbox"
                checked={memory}
                onChange={(event) => setMemory(event.target.checked)}
              />
              <span>包含工作偏好</span>
            </label>
            {memory && (
              <textarea
                className="field"
                aria-label="已保存的工作偏好"
                rows={3}
                value={source.memory}
                readOnly
              />
            )}
            {latest && latest.revision !== source.revision && (
              <p className="inline-note">
                来源资料已有更新，请载入后核对；新名称和偏好选择会保留。
              </p>
            )}
            {latest && (
              <button
                type="button"
                className="secondary"
                disabled={!available || !!latest.archived || latest.lifecycle?.phase === 'pending'}
                onClick={() => setSource({ ...latest })}
              >
                载入最新来源
              </button>
            )}
            {inactive && (
              <p className="form-error" role="alert">
                来源 Bot 暂不可复制，请核对归档或恢复状态。
              </p>
            )}
          </div>
        ) : (
          <p className="form-error" role="alert">
            未找到来源资料，请关闭后重新选择 Bot。
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={close}>
            关闭
          </button>
          {pending ? (
            <>
              <button
                type="button"
                className="secondary"
                disabled={!available || reading}
                onClick={() => check().catch(() => {})}
              >
                {reading ? '正在核对…' : '核对复制结果'}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!available || blocked || working}
                onClick={() => submit(pending).catch(() => {})}
              >
                {working ? '正在复制…' : '重试同一次复制'}
              </button>
            </>
          ) : (
            <button
              type="submit"
              className="primary"
              disabled={
                !available || blocked || working || inactive || !name.trim() || name.includes('\0')
              }
            >
              创建副本
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
