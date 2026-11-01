import type { SetupPhase } from '@daban/protocol';
import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  CirclePause,
  HardDrive,
  LoaderCircle,
  Pause,
} from 'lucide-react';
import { useState } from 'react';
import { Language } from './Language';
import { t, useLocale } from './locale';
import { useRuntime } from './Runtime';

const steps = [
  { phase: 'verifying', label: '检查本地环境文件', detail: '正在核对安装文件，确保环境完整。' },
  { phase: 'extracting', label: '准备 Linux 系统', detail: '正在解包系统文件，可能需要一些时间。' },
  { phase: 'creating', label: '创建独立工作空间', detail: '正在为 Bot 准备独立的本地环境。' },
  { phase: 'starting', label: '启动本地环境', detail: '正在启动 Linux，完成后会自动连接。' },
  { phase: 'connecting', label: '连接工作区', detail: '正在连接本地服务，完成后即可进入工作区。' },
];
const labels: Partial<Record<SetupPhase, string>> = {
  cancelling: '正在保存当前进度',
  cancelled: '安装已暂停',
  failed: '安装尚未完成',
  unavailable: '暂时无法安装',
  complete: '本地环境已就绪',
  existing: '本地环境已就绪',
};
const titles: Partial<Record<SetupPhase, string>> = {
  available: '给 Bot 一个本地工作空间',
  cancelling: '正在暂停安装',
  cancelled: '准备好了再继续',
  complete: '工作空间准备好了',
  existing: '工作空间准备好了',
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
  useLocale();
  const runtime = useRuntime();
  const status = runtime.snapshot.setup!;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Terminal phases carry no step history; show recovery instead of guessing which steps completed.
  const current = steps.findIndex((step) => step.phase === status.phase);
  const working = current >= 0;
  const running = working || status.phase === 'cancelling';
  const initial = status.phase === 'available';
  // Only extraction has measured progress. An absent or invalid value must not become a fake 0%.
  const percent =
    status.phase === 'extracting' &&
    typeof status.progress === 'number' &&
    Number.isFinite(status.progress) &&
    status.progress >= 0 &&
    status.progress <= 100
      ? status.progress
      : undefined;
  async function act(type: 'setup.start' | 'setup.cancel') {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await runtime.command({ type });
    } catch {
      setError(t('暂时无法处理安装请求。进度已保留，请重试或重新打开客户端。'));
    } finally {
      setPending(false);
    }
  }
  const problem =
    error ||
    (status.error
      ? t(errors[status.error] ?? '安装未完成，已有环境和数据会保留。请继续安装以重试。')
      : '');
  return (
    <main className="setup-page">
      <header className="setup-header">
        <span>Daban</span>
        <div className="setup-tools">
          <Language />
          <span className="setup-local">
            <HardDrive size={15} />
            {t('本机运行')}
          </span>
        </div>
      </header>
      <section className="setup-content" aria-labelledby="setup-title">
        <div className="setup-intro">
          <div className="setup-companion" data-active={working} aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="" width="120" height="120" />
          </div>
          <h1 id="setup-title">
            {t(working ? '搭子正在布置工作空间' : (titles[status.phase] ?? '工作空间还没准备好'))}
          </h1>
          <p className="setup-description">
            {working
              ? t('环境就绪后会自动进入工作区。请保持电脑唤醒，也可以随时暂停。')
              : t(
                  '让 Bot 在独立的 Linux 环境里工作。每位 Bot 有自己的屏幕，共享文件和浏览器登录，你可以随时接管。',
                )}
          </p>
        </div>
        <div className="setup-install">
          {initial && (
            <>
              <div className="setup-details">
                <span>
                  <CircleCheck size={17} />
                  {t('环境随客户端提供')}
                </span>
                <span>
                  <CircleCheck size={17} />
                  {t('无需单独安装 Docker 或 DSH')}
                </span>
              </div>
              <p className="setup-budget">
                {t('默认分配 3 GiB 内存、16 GiB 虚拟磁盘。首次安装请预留至少 36 GB 可用空间。')}
              </p>
            </>
          )}
          {!initial && (
            <div className="setup-progress">
              <div className="setup-status" role="status" aria-atomic="true">
                {working ? (
                  <>
                    <span>
                      {t('安装进行中')}
                      <span className="sr-only"> · {t(steps[current].label)}</span>
                    </span>
                    <span className="setup-count">
                      {current + 1} / {steps.length}
                    </span>
                  </>
                ) : (
                  <span className="setup-state-label">
                    {status.phase === 'cancelled' || status.phase === 'cancelling' ? (
                      <CirclePause size={19} />
                    ) : status.phase === 'complete' || status.phase === 'existing' ? (
                      <CircleCheck size={19} />
                    ) : (
                      <CircleAlert size={19} />
                    )}
                    {t(labels[status.phase] ?? '准备本地环境')}
                  </span>
                )}
              </div>
              {working && (
                <ol className="setup-steps" aria-label={t('安装步骤')}>
                  {steps.map((step, index) => {
                    const active = index === current;
                    const done = index < current;
                    return (
                      <li
                        key={step.phase}
                        className="setup-step"
                        data-state={active ? 'active' : done ? 'done' : 'waiting'}
                        aria-current={active ? 'step' : undefined}
                      >
                        <span className="setup-step-marker" aria-hidden="true">
                          {done ? (
                            <Check size={16} />
                          ) : active ? (
                            <LoaderCircle className="setup-spinner" size={20} />
                          ) : (
                            index + 1
                          )}
                        </span>
                        <div className="setup-step-body">
                          <div className="setup-step-heading">
                            <span>{t(step.label)}</span>
                            <span className="setup-step-state">
                              {t(active ? '进行中' : done ? '已完成' : '待执行')}
                            </span>
                          </div>
                          {active && (
                            <>
                              <p>{t(step.detail)}</p>
                              {percent !== undefined && (
                                <div className="setup-measured">
                                  <div
                                    className="setup-track"
                                    role="progressbar"
                                    aria-label={t('Linux 系统解包进度')}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={percent}
                                  >
                                    <span style={{ width: `${percent}%` }} />
                                  </div>
                                  <span>{percent}%</span>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {status.phase === 'cancelling' && (
                <p>{t('当前创建或启动步骤结束后暂停，已创建的环境会保留。')}</p>
              )}
              {status.phase === 'cancelled' && (
                <p>{t('继续安装会先核对已有进度，不会删除工作空间。')}</p>
              )}
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
                {t('暂停安装')}
              </button>
            ) : (
              status.phase !== 'unavailable' && (
                <button
                  type="button"
                  className="primary"
                  disabled={pending}
                  onClick={() => act('setup.start')}
                >
                  {status.phase === 'available' ? t('创建本地环境') : t('继续安装')}
                  <ArrowRight size={17} />
                </button>
              )
            )}
          </div>
          <p className="setup-footnote">
            {t('任务在本机运行。关闭客户端不会删除环境，模型连接在环境就绪后单独配置。')}
          </p>
        </div>
      </section>
    </main>
  );
}
