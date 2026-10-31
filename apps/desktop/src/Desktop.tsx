import { Check, FileText, Folder, Globe, Monitor, ShieldCheck, Terminal, Wifi } from 'lucide-react';
import { useState } from 'react';
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
  const [app, setApp] = useState<App>('document');
  const apps = [
    ['files', Folder, '文件管理器'],
    ['browser', Globe, '浏览器'],
    ['terminal', Terminal, '终端'],
    ['document', FileText, '文档'],
  ] as const;
  return (
    <section
      className={`desktop-preview ${expanded ? 'fullscreen-desktop' : ''}`}
      aria-label={`${name}的示例 Linux 桌面`}
    >
      <div className="desktop-topbar">
        <Monitor />
        <span>daban</span>
        <span className="spacer" />
        <span>示例桌面</span>
        <Wifi />
        <span>10:28</span>
      </div>
      <div className="desktop-wallpaper" />
      {human && <div className="desktop-control-state">你正在接管 · 演示状态</div>}
      <div className="desktop-window">
        <div className="window-bar">
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-path">
            <ShieldCheck />
            {app === 'terminal'
              ? `${name} · 终端预览`
              : app === 'files'
                ? '/workspace · 共享文件'
                : app === 'browser'
                  ? 'workspace.example.test · 示例页面'
                  : '工作区 / 周报草稿'}
          </span>
        </div>
        {app === 'terminal' ? (
          <div className="desktop-terminal">
            <span className="terminal-prompt">bot@daban:~$</span> ls /workspace
            <br />
            本周工作摘要.md
            <br />
            项目记录.md
            <br />
            待办清单.csv
            <br />
            产品介绍.md
            <br />
            <br />
            <span className="terminal-prompt">bot@daban:~$</span> <span>▏</span>
            <p className="terminal-note">
              终端界面预览
              <br />
              尚未连接 Linux 运行环境
            </p>
          </div>
        ) : app === 'files' ? (
          <div className="desktop-folder">
            <div className="desktop-folder-title">共享工作区 / workspace</div>
            {['本周工作摘要.md', '项目记录.md', '待办清单.csv', '产品介绍.md'].map((text, i) => (
              <div className="desktop-folder-row" key={text}>
                <FileText />
                <span>{text}</span>
                <small>{['2.4 KB', '1.8 KB', '0.6 KB', '1.2 KB'][i]}</small>
              </div>
            ))}
          </div>
        ) : (
          <div className="document">
            <h2>本周工作摘要</h2>
            <p className="document-meta">本周 · 草稿 · 示例内容</p>
            <h3>本周进展</h3>
            {['项目资料整理与归档', '产品参考与初步方案', '第一版内容与文档'].map((text) => (
              <div className="document-row" key={text}>
                <span>{text}</span>
                <small>已完成</small>
              </div>
            ))}
            <h3>需要确认</h3>
            {['下一轮评审时间', '下周工作的优先顺序'].map((text) => (
              <div className="document-row pending" key={text}>
                <span>{text}</span>
                <small>待确认</small>
              </div>
            ))}
            <p className="document-foot">
              <Check />
              已整理 3 份资料，尚未对外发送
            </p>
          </div>
        )}
      </div>
      <fieldset className="desktop-dock" aria-label="桌面应用预览">
        {apps.map(([id, Icon, label]) => (
          <Tooltip label={`预览${label}`} key={id}>
            <button
              type="button"
              className={app === id ? 'active' : ''}
              aria-label={`预览${label}`}
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
