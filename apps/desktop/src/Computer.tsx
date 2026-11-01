import { computerTarget, recoveryBlocked } from '@daban/protocol';
import {
  Check,
  FileText,
  Folder,
  Globe,
  Maximize2,
  Monitor,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { useState } from 'react';
import { Browser } from './Browser';
import { Connection } from './Connection';
import { LiveDesktop } from './LiveDesktop';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';
import type { Bot } from './state';
export type ComputerSurface = 'desktop' | 'browser';

export function Computer({
  bot,
  notify,
  expand,
  expanded = false,
  initialView = 'desktop',
  onRecovery,
}: {
  bot: Bot;
  notify: (message: string) => unknown;
  expand?: (view: ComputerSurface) => unknown;
  expanded?: boolean;
  initialView?: ComputerSurface;
  onRecovery?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime(),
    target = computerTarget(runtime.snapshot, bot.id),
    [busy, setBusy] = useState(false),
    [view, setView] = useState<ComputerSurface>(initialView);
  const computer = target ? runtime.snapshot.bots[target] : undefined;
  const managed = runtime.snapshot.protocolVersion >= 19;
  if (
    bot.archived &&
    !computer &&
    !runtime.snapshot.computers?.items.some((entry) => entry.bot === target && entry.reserved)
  )
    return (
      <div className="panel-section">
        <h2>{t('Bot 已归档')}</h2>
        <p className="panel-description">{t('恢复后可重新连接电脑，保留的历史和文件仍可查看。')}</p>
      </div>
    );
  if (managed && target && !computer)
    return <Connection bot={target} name={bot.name} notify={notify} onRecovery={onRecovery} />;
  if (runtime.snapshot.computerError)
    return (
      <div className="panel-section">
        <h2>{t('电脑暂不可用')}</h2>
        <p className="panel-description">
          {t(
            '你仍可以继续对话、处理工作区文件和使用资料。需要操作电脑的任务，请在桌面恢复后继续。',
          )}
        </p>
      </div>
    );
  if (!target)
    return (
      <div className="panel-section">
        <h2>{t('此 Bot 可以对话，尚未连接电脑')}</h2>
        <p className="panel-description">
          {t('它仍可聊天、使用工作区工具。连接电脑后，就可以查看它的屏幕，或在需要时接管。')}
        </p>
      </div>
    );
  const human = computer?.owner === 'human',
    ready = runtime.snapshot.phase === 'ready' && !recoveryBlocked(runtime.snapshot);
  const apps = [
    ['terminal', Terminal, t('终端')],
    ['files', Folder, t('文件管理器')],
    ['editor', FileText, t('编辑器')],
    ['browser', Globe, t('共享浏览器')],
  ] as const;
  return (
    <div className="computer-panel">
      <div className={`computer-info ${human ? 'human' : ''}`}>
        <span className="status-dot" />
        <span>
          {ready ? (human ? t('你正在接管') : t('Linux 桌面已连接')) : t('正在连接运行环境')}
        </span>
        <span className="spacer" />
        <span className="muted">
          {bot.name}
          {t('的屏幕')}
        </span>
        <div className="computer-actions">
          <button
            type="button"
            className="primary"
            disabled={!ready || !computer || busy || computer.owner === 'handoff'}
            onClick={async () => {
              if (!computer) return;
              setBusy(true);
              try {
                await runtime.command({
                  type: 'control',
                  bot: target,
                  epoch: computer.epoch,
                  ...(computer.instance === undefined ? {} : { instance: computer.instance }),
                  owner: human ? 'agent' : 'human',
                });
              } catch (error) {
                notify(runtimeError(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {human ? <Check /> : <Monitor />}
            {busy ? t('正在交接…') : human ? t('交还给 Bot') : t('接管电脑')}
          </button>
          {managed && target && (
            <Connection bot={target} name={bot.name} notify={notify} onRecovery={onRecovery} />
          )}
          {expand && (
            <button type="button" className="secondary" onClick={() => expand(view)}>
              <Maximize2 />
              {t('展开')}
            </button>
          )}
        </div>
      </div>
      {runtime.snapshot.protocolVersion >= 16 && (
        <nav className="computer-views" aria-label={t('电脑视图')}>
          <button
            type="button"
            aria-pressed={view === 'desktop'}
            onClick={() => setView('desktop')}
          >
            <Monitor size={15} />
            {t('Linux 桌面')}
          </button>
          <button
            type="button"
            aria-pressed={view === 'browser'}
            onClick={() => setView('browser')}
          >
            <Globe size={15} />
            {t('浏览器')}
          </button>
        </nav>
      )}
      {view === 'browser' && runtime.snapshot.protocolVersion >= 16 ? (
        <Browser key={target} bot={target} name={bot.name} notify={notify} expanded={expanded} />
      ) : (
        <>
          <LiveDesktop
            key={target}
            bot={target}
            name={bot.name}
            owner={computer?.owner || 'agent'}
            epoch={computer?.epoch || 0}
            notify={notify}
            expanded={expanded}
          />
          <div className="native-app-buttons">
            {apps.map(([app, Icon, label]) => (
              <button
                type="button"
                key={app}
                disabled={!ready || !human || busy}
                onClick={async () => {
                  try {
                    await runtime.command({
                      type: 'app',
                      bot: target,
                      epoch: computer!.epoch,
                      ...(computer!.instance === undefined ? {} : { instance: computer!.instance }),
                      app,
                    });
                  } catch (error) {
                    notify(runtimeError(error));
                  }
                }}
              >
                <Icon />
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="computer-copy">
        <h2>{human ? t('电脑暂时交给你') : t('在这里查看实际操作')}</h2>
        <p>
          {human
            ? t(
                '接管期间，这位 Bot 会等待你交还；另一位 Bot 可以继续工作。关闭面板不会交还控制权。',
              )
            : !ready
              ? t('连接恢复后可查看共享登录状态。')
              : runtime.snapshot.protocolVersion >= 16
                ? t(
                    '每位 Bot 各有独立桌面和标签，浏览器共用登录信息。网站的登录状态以网页显示为准。',
                  )
                : t('两位 Bot 各有独立桌面，浏览器登录状态共享。当前共享示例账户{0}。', {
                    0: runtime.snapshot.sharedLogin ? t('已登录') : t('尚未登录'),
                  })}
        </p>
      </div>
      <div className="computer-footer">
        <ShieldCheck />
        <span>
          {runtime.snapshot.protocolVersion >= 16
            ? t('本地 Linux · 独立屏幕 · 共享文件与浏览器登录')
            : t('本地 Linux · 独立屏幕 · 共享文件与示例登录')}
        </span>
      </div>
    </div>
  );
}
