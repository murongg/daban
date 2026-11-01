import type { SetupPhase } from '@daban/protocol';
import { ArrowRight, CircleCheck, HardDrive, Monitor, Pause } from 'lucide-react';
import { useState } from 'react';
import { useRuntime } from './Runtime';

const busy = new Set<SetupPhase>([
  'verifying',
  'extracting',
  'creating',
  'starting',
  'connecting',
  'cancelling',
]);
const labels: Partial<Record<SetupPhase, string>> = {
  verifying: '检查本地环境文件',
  extracting: '准备 Linux 系统',
  creating: '创建独立工作空间',
  starting: '启动本地环境',
  connecting: '连接 Agent',
  cancelling: '正在保存当前进度',
  cancelled: '安装已暂停',
  failed: '安装尚未完成',
  unavailable: '暂时无法安装',
  complete: '本地环境已就绪',
};
const errors: Record<string, string> = {
  SETUP_BUSY: '上一次安装操作仍在处理中。已保留进度，请稍后继续安装。',
  SETUP_MISSING: '此开发版本尚未附带本地运行环境。请使用包含运行环境的客户端安装包。',
  SETUP_PLATFORM: '此版本的本地环境暂仅支持 Apple 芯片 Mac。',
  SETUP_PAYLOAD: '运行环境文件不完整或版本不匹配。请重新获取包含环境的安装包。',
  SETUP_INTEGRITY: '运行环境文件校验未通过。请重新获取安装包后继续。',
  SETUP_SPACE: '可用磁盘空间不足。请清理空间后继续安装，已有进度会保留。',
  SETUP_STORE: '安装记录或目录无法安全使用。已保留原有内容，请检查本地运行环境。',
  SETUP_CHANGED: '安装包与上次的环境版本不同。已保留已有环境，请使用原版本继续安装。',
  SETUP_EXISTS: '检测到已有连接配置，安装没有替换它。请重新打开客户端连接原有环境。',
  SETUP_UNCERTAIN: '上一次操作的结果尚未确认。环境已保留，请稍后继续核对。',
  SETUP_CONNECT: 'Linux 已保留，Agent 暂未连接。请继续安装以重试连接。',
  SETUP_PORT: '本机连接地址暂时不可用，已有 Linux 环境已保留。请继续安装以重试连接。',
  SETUP_RECOVERY: '检测到已有环境的恢复记录，安装已暂停。请先恢复原连接配置，已有数据会保留。',
};
export function Setup() {
  const runtime = useRuntime();
  const status = runtime.snapshot.setup!;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const running = busy.has(status.phase);
  async function act(type: 'setup.start' | 'setup.cancel') {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await runtime.command({ type });
    } catch {
      setError('暂时无法处理安装请求。进度已保留，请重试或重新打开客户端。');
    } finally {
      setPending(false);
    }
  }
  const problem =
    error ||
    (status.error
      ? (errors[status.error] ?? '安装未完成，已有环境和数据会保留。请继续安装以重试。')
      : '');
  return (
    <main className="setup-page">
      <header className="setup-header">
        <span>Daban</span>
        <span className="setup-local">
          <HardDrive size={15} />
          本机运行
        </span>
      </header>
      <section className="setup-content" aria-labelledby="setup-title">
        <div className="setup-symbol">
          <Monitor size={34} strokeWidth={1.4} />
        </div>
        <h1 id="setup-title">给 Bot 一个本地工作空间</h1>
        <p className="setup-description">
          让 Bot 在独立的 Linux 环境里工作。每位 Bot
          有自己的屏幕，共享文件和浏览器登录，你可以随时接管。
        </p>
        {status.phase !== 'unavailable' && (
          <>
            <div className="setup-details">
              <span>
                <CircleCheck size={17} />
                环境随客户端提供
              </span>
              <span>
                <CircleCheck size={17} />
                无需单独安装 Docker 或 DSH
              </span>
            </div>
            <p className="setup-budget">
              默认分配 3 GiB 内存、16 GiB 虚拟磁盘。首次安装请预留至少 36 GB 可用空间。
            </p>
          </>
        )}
        {status.phase !== 'available' && (
          <div className="setup-progress" aria-live="polite">
            <div className="setup-step">
              <span>{labels[status.phase] ?? '准备本地环境'}</span>
              {status.phase === 'extracting' && <span>{status.progress ?? 0}%</span>}
            </div>
            {status.phase === 'extracting' && (
              <div
                className="setup-track"
                role="progressbar"
                aria-label="Linux 系统解包进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={status.progress ?? 0}
              >
                <span style={{ width: `${status.progress ?? 0}%` }} />
              </div>
            )}
            {status.phase === 'cancelling' && (
              <p>当前创建或启动步骤结束后暂停，已创建的环境会保留。</p>
            )}
            {status.phase === 'cancelled' && <p>继续安装会先核对已有进度，不会删除工作空间。</p>}
          </div>
        )}
        {problem && (
          <p className="setup-error" role="alert">
            {problem}
          </p>
        )}
        <div className="setup-actions">
          {running ? (
            <button
              type="button"
              className="secondary"
              disabled={pending || status.phase === 'cancelling'}
              onClick={() => act('setup.cancel')}
            >
              <Pause size={15} />
              暂停安装
            </button>
          ) : (
            status.phase !== 'unavailable' && (
              <button
                type="button"
                className="primary"
                disabled={pending}
                onClick={() => act('setup.start')}
              >
                {status.phase === 'available' ? '创建本地环境' : '继续安装'}
                <ArrowRight size={17} />
              </button>
            )
          )}
        </div>
        <p className="setup-footnote">
          任务在本机运行。关闭客户端不会删除环境，模型连接在环境就绪后单独配置。
        </p>
      </section>
    </main>
  );
}
