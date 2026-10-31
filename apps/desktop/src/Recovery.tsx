import {
  agentId,
  isRebootStatus,
  isRecoveryReview,
  type RebootStatus,
  type RecoveryReview,
  recoveryBlocked,
} from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { runtimeError, useRuntime } from './Runtime';
import type { Bot } from './state';

const stages = {
  preparing: '正在准备恢复',
  prepared: '恢复已准备，尚未关机',
  'stop-issued': '关机请求已发出，结果待核对',
  stopped: '运行环境已停止',
  'start-issued': '正在启动运行环境',
  complete: '运行环境已恢复',
  cancelled: '本次恢复已取消',
  rejected: '本次恢复未执行',
};
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
    <Dialog title="恢复整个运行环境" onClose={close}>
      <p className="dialog-description">
        这会重启本地 Linux，关闭所有 Bot
        的电脑和其中的应用。请先保存内容；部分网页可能需要重新登录。
      </p>
      <p className="inline-note">
        已保存的文件、偏好和聊天保留，电脑需重新连接。你设置的定时和排队工作会继续按原设置运行；结果不明的操作不会自动重放。
      </p>
      {scope && (
        <section className="recovery-screens" aria-label="本次影响的电脑">
          {scope.screens.length ? (
            scope.screens.map((row) => (
              <div key={row.computer.bot} className="recovery-screen">
                <span>{name(row.computer.bot)}</span>
                <span className="muted">
                  {row.computer.phase !== 'connected'
                    ? '状态需核对'
                    : row.lease?.owner === 'human'
                      ? '你正在接管'
                      : row.lease?.owner === 'agent'
                        ? 'Bot 可操作'
                        : '状态需核对'}
                </span>
              </div>
            ))
          ) : (
            <p className="inline-note">当前未占用 Bot 屏幕；恢复仍会重启整个 Linux。</p>
          )}
        </section>
      )}
      {(review?.running.length || running.length) > 0 && (
        <div className="inline-note">
          <p>先结束正在执行的任务，再恢复。</p>
          {[...new Set([...(review?.running ?? []), ...running])].map((id) => (
            <button
              key={id}
              type="button"
              className="secondary"
              onClick={() => onTask?.(id)}
              disabled={!onTask}
            >
              查看 {name(id)} 的任务
            </button>
          ))}
        </div>
      )}
      {foreign && (
        <p className="inline-note">已有恢复由其他客户端发起，请回到发起恢复的客户端核对结果。</p>
      )}
      {host && !host.available && (
        <p className="form-error" role="alert">
          {runtimeError(new Error(host.error))}
        </p>
      )}
      {operation && (
        <div className="recovery-result" role="status">
          <strong>{stages[operation.stage]}</strong>
          {operation.error && (
            <p className="form-error">{runtimeError(new Error(operation.error))}</p>
          )}
          {operation.stage === 'stop-issued' && (
            <p className="inline-note">先核对当前状态。客户端不会自动重复关机。</p>
          )}
          {pending && (
            <p className="inline-note">关闭窗口不会撤回已提交的操作；重开客户端后先核对回执。</p>
          )}
        </div>
      )}
      {changed && operation?.stage !== 'complete' && (
        <p className="inline-note">运行环境或控制状态已变化，请重新核对。</p>
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
          我已保存所有电脑中的内容
        </label>
      )}
      <div className="dialog-actions recovery-actions">
        <button type="button" className="text-button" onClick={close}>
          关闭
        </button>
        {!pending && (
          <button
            type="button"
            className="secondary"
            disabled={active || runtime.snapshot.phase !== 'ready'}
            onClick={() => perform(loadReview)}
          >
            重新核对
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
            核对恢复结果
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
            取消未执行的恢复
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
            启动运行环境
          </button>
        ) : (
          (!pending || unissued) && (
            <button
              type="button"
              className="primary"
              disabled={active || !saved || !canRestart}
              onClick={() => perform(restart)}
            >
              {active ? '正在处理…' : unissued ? '继续这次恢复' : '确认重启整个环境'}
            </button>
          )
        )}
      </div>
    </Dialog>
  );
}
export function RecoveryNotice({ open }: { open: () => unknown }) {
  const runtime = useRuntime();
  if (!recoveryBlocked(runtime.snapshot)) return null;
  return (
    <div className="recovery-banner" role="status">
      <div>
        <strong>运行环境恢复待核对</strong>
        <p>新任务和电脑操作暂缓，草稿仍可编辑，历史和已保存文件可查看。</p>
      </div>
      <button type="button" className="secondary" onClick={open}>
        查看恢复
      </button>
    </div>
  );
}
export function RecoveryEntry({ open }: { open?: () => unknown }) {
  const runtime = useRuntime();
  const operation = runtime.snapshot.reboot?.available
    ? runtime.snapshot.reboot.operation
    : undefined;
  const pending = !!operation && !terminal.has(operation.stage);
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">恢复本地运行环境</div>
        <p className="setting-description">
          电脑回收未确认或运行环境异常时，可核对后恢复整个 Linux。所有 Bot 的电脑都会受影响。
        </p>
        {runtime.snapshot.protocolVersion < 24 && (
          <p className="inline-note">更新运行环境后可用；已有回执仍可核对。</p>
        )}
      </div>
      <button
        type="button"
        className="secondary"
        disabled={!open || !runtime.enabled || (!pending && runtime.snapshot.protocolVersion < 24)}
        onClick={open}
      >
        {pending ? '查看恢复' : '检查并恢复'}
      </button>
    </div>
  );
}
