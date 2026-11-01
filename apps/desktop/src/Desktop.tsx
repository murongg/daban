import { Check, FileText, Folder, Globe, Monitor, ShieldCheck, Terminal, Wifi } from 'lucide-react';
import { useState } from 'react';
import { t, useLocale } from './locale';
import { Tooltip } from './Tooltip';

type App = 'document' | 'files' | 'terminal' | 'browser';
export function Desktop({
  name,
  human,
  expanded = false,
}: {
  name: string;
  human: boolean;
  expanded?: boolean;
}) {
  useLocale();
  const [app, setApp] = useState<App>('document');
  const apps = [
    ['files', Folder, t('文件管理器')],
    ['browser', Globe, t('浏览器')],
    ['terminal', Terminal, t('终端')],
    ['document', FileText, t('文档')],
  ] as const;
  return (
    <section
      className={`desktop-preview ${expanded ? 'fullscreen-desktop' : ''}`}
      aria-label={t('{0}的示例 Linux 桌面', { 0: name })}
    >
      <div className="desktop-topbar">
        <Monitor />
        <span>Daban</span>
        <span className="spacer" />
        <span>{t('示例桌面')}</span>
        <Wifi />
        <span>10:28</span>
      </div>
      <div className="desktop-wallpaper" />
      {human && <div className="desktop-control-state">{t('你正在接管 · 演示状态')}</div>}
      <div className="desktop-window">
        <div className="window-bar">
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-path">
            <ShieldCheck />
            {app === 'terminal'
              ? t('{0} · 终端预览', { 0: name })
              : app === 'files'
                ? t('/workspace · 共享文件')
                : app === 'browser'
                  ? t('workspace.example.test · 示例页面')
                  : t('工作区 / 周报草稿')}
          </span>
        </div>
        {app === 'terminal' ? (
          <div className="desktop-terminal">
            <span className="terminal-prompt">bot@daban:~$</span> ls /workspace
            <br />
            {t('本周工作摘要.md')}
            <br />
            {t('项目记录.md')}
            <br />
            {t('待办清单.csv')}
            <br />
            {t('产品介绍.md')}
            <br />
            <br />
            <span className="terminal-prompt">bot@daban:~$</span> <span>▏</span>
            <p className="terminal-note">
              {t('终端界面预览')}
              <br />
              {t('尚未连接 Linux 运行环境')}
            </p>
          </div>
        ) : app === 'files' ? (
          <div className="desktop-folder">
            <div className="desktop-folder-title">{t('共享工作区 / workspace')}</div>
            {[t('本周工作摘要.md'), t('项目记录.md'), t('待办清单.csv'), t('产品介绍.md')].map(
              (text, i) => (
                <div className="desktop-folder-row" key={text}>
                  <FileText />
                  <span>{text}</span>
                  <small>{['2.4 KB', '1.8 KB', '0.6 KB', '1.2 KB'][i]}</small>
                </div>
              ),
            )}
          </div>
        ) : (
          <div className="document">
            <h2>{t('本周工作摘要')}</h2>
            <p className="document-meta">{t('本周 · 草稿 · 示例内容')}</p>
            <h3>{t('本周进展')}</h3>
            {[t('项目资料整理与归档'), t('产品参考与初步方案'), t('第一版内容与文档')].map(
              (text) => (
                <div className="document-row" key={text}>
                  <span>{text}</span>
                  <small>{t('已完成')}</small>
                </div>
              ),
            )}
            <h3>{t('需要确认')}</h3>
            {[t('下一轮评审时间'), t('下周工作的优先顺序')].map((text) => (
              <div className="document-row pending" key={text}>
                <span>{text}</span>
                <small>{t('待确认')}</small>
              </div>
            ))}
            <p className="document-foot">
              <Check />
              {t('已整理 3 份资料，尚未对外发送')}
            </p>
          </div>
        )}
      </div>
      <fieldset className="desktop-dock" aria-label={t('桌面应用预览')}>
        {apps.map(([id, Icon, label]) => (
          <Tooltip label={t('预览{0}', { 0: label })} key={id}>
            <button
              type="button"
              className={app === id ? 'active' : ''}
              aria-label={t('预览{0}', { 0: label })}
              aria-pressed={app === id}
              onClick={() => setApp(id)}
            >
              <Icon />
            </button>
          </Tooltip>
        ))}
      </fieldset>
    </section>
  );
}
