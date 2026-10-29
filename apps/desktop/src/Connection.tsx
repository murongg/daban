import {
  type ComputerAck,
  type ComputerRequest,
  type ComputerState,
  recoveryBlocked,
} from '@daban/protocol';
import { CircleAlert, Power } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from './Button';
import {
  beginComputer,
  type ComputerPending,
  clearComputer,
  pendingComputer,
  watchComputers,
} from './connections';
import { Dialog } from './Dialog';
import { runtimeError, useRuntime } from './Runtime';

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
const headings: Record<ComputerState['phase'], string> = {
  disconnected: '连接电脑',
  connecting: '正在连接电脑',
  connected: '电脑已连接',
  stopping: '正在停止电脑',
  suspended: '电脑已暂停',
  failed: '电脑暂不可用',
  interrupted: '电脑操作未确认',
};

export function Connection(props: {
  bot: string;
  name: string;
  notify: (text: string) => unknown;
  onRecovery?: () => unknown;
}) {
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
      } else if (live.current) setError('电脑操作仍待核对，不会自动重试。');
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
    if (busy || running || changing || !ready || !status?.available || storageError) return;
    try {
      const existing = pendingComputer(bot);
      if (existing) {
        setPending(existing);
        setError('已有电脑操作待核对，请先核对结果。');
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
            : '操作结果未确认，请核对电脑状态；不会自动重试。';
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
    !status?.available ||
    !!pending ||
    storageError ||
    recoveryBlocked(runtime.snapshot);
  const inspectButton = pending && (
    <IconButton label="核对电脑操作" disabled={busy || !ready} onClick={() => inspect(pending)}>
      <CircleAlert size={16} />
    </IconButton>
  );
  const dialog = stop && (
    <Dialog title={`停止${name}的电脑`} onClose={closeStop}>
      <p className="dialog-description">
        该屏幕中的应用将关闭。聊天、资料、已保存文件和浏览器资料会保留。
      </p>
      <label className="connection-confirm">
        <input
          type="checkbox"
          checked={stop.saved}
          disabled={busy}
          onChange={(event) =>
            setStop((current) => (current ? { ...current, saved: event.target.checked } : current))
          }
        />
        已保存这台电脑中未保存的内容
      </label>
      {stale && (
        <p role="alert" className="connection-error">
          电脑状态已变化，请关闭此确认后重新核对。
        </p>
      )}
      {error && (
        <p role="alert" className="connection-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={closeStop}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={!stop.saved || stale || locked}
          onClick={() => run('stop')}
        >
          {busy ? '正在停止…' : '停止电脑'}
        </button>
      </div>
    </Dialog>
  );
  if (computer.phase === 'connected')
    return (
      <>
        {inspectButton}
        <IconButton label="停止电脑" disabled={locked} onClick={stopButton}>
          <Power size={16} />
        </IconButton>
        {(pending || error || running) && (
          <p
            role={error ? 'alert' : 'status'}
            className={`connection-feedback ${error ? 'connection-error' : ''}`}
          >
            {pending && <span>电脑操作结果待核对，不会自动重试。请点击“核对电脑操作”。</span>}
            {error && <span>{error}</span>}
            {running && <span>这位 Bot 还有任务在执行，结束后再停止电脑。</span>}
          </p>
        )}
        {dialog}
      </>
    );
  return (
    <section className="panel-section connection" aria-label={`${name}的电脑连接`}>
      <h2>{status?.available === false ? '电脑服务暂不可用' : headings[computer.phase]}</h2>
      <p className="connection-description">
        {changing
          ? '连接或停止期间，这位 Bot 暂不能发送新任务，草稿会保留。其他 Bot 可继续使用。'
          : '本机运行，每位 Bot 拥有独立屏幕，共享文件和浏览器登录。普通对话和工作区工具仍可使用。'}
      </p>
      {changing && (
        <p role="status" className="connection-description">
          {computer.phase === 'connecting'
            ? '正在启动独立屏幕，请稍候…'
            : '正在关闭这位 Bot 的应用并核对资源…'}
        </p>
      )}
      {computer.recovery === 'restart' ? (
        <div role="status" className="connection-description">
          <p>上次资源回收未确认，名额仍被保留。请保存其他电脑中的内容后，恢复整个运行环境。</p>
          {onRecovery && runtime.snapshot.protocolVersion >= 24 ? (
            <button type="button" className="secondary" onClick={onRecovery}>
              检查并恢复整个环境
            </button>
          ) : (
            <p>当前需手动重启本地虚拟机后再连接。</p>
          )}
        </div>
      ) : (
        <div className="connection-actions">
          {computer.reserved ? (
            <button type="button" className="secondary" disabled={locked} onClick={stopButton}>
              {changing ? '请稍候…' : '重试停止'}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={locked || full || !registered}
              onClick={() => run('connect')}
            >
              连接电脑
            </button>
          )}
          {inspectButton}
        </div>
      )}
      {status && (
        <p className="connection-capacity">
          当前执行环境已占用 {occupied}/{status.limit} 个电脑名额
          {full ? '，请先停止另一位 Bot 的电脑。' : '。'}
        </p>
      )}
      {running && (
        <p className="connection-description">这位 Bot 还有任务在执行，结束后再操作电脑。</p>
      )}
      {!registered && ready && (
        <p className="connection-description">正在同步 Bot 资料，请稍候。</p>
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
