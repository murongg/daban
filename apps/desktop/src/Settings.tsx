import { Download, Moon, Sun } from 'lucide-react';
import { type Dispatch, useState } from 'react';
import { ArchiveList } from './Archive';
import { Diagnostics } from './Diagnostics';
import { download } from './files';
import { Integrations } from './Integrations';
import { Models } from './Models';
import { Notifications } from './Notifications';
import { RecoveryEntry } from './Recovery';
import { runtimeError, useRuntime } from './Runtime';
import type { Action, State } from './state';
import { serialize } from './storage';

export function Settings({
  state,
  dispatch,
  onLifecycle,
  onRecovery,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  onLifecycle?: (bot: string) => unknown;
  onRecovery?: () => unknown;
}) {
  const runtime = useRuntime(),
    [error, setError] = useState('');
  return (
    <section className="full-page" aria-label="设置">
      <div className="page-inner">
        <h2 className="page-heading">按你的习惯工作</h2>
        <p className="page-subtitle">让工作区保持顺手，其他事情交给 Bot。</p>
        {runtime.snapshot.agent?.location === 'host' && (
          <div className="settings-section">
            <h2>执行环境与权限</h2>
            <div className="setting-row">
              <div>
                <div className="setting-label">虚拟机内完整权限</div>
                <p className="setting-description">
                  Bot 可以管理 Linux 系统、使用 sudo 和网络，并安装 npm、Codex
                  等软件。执行命令前会显示具体内容供你确认。
                </p>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">本机 Agent 服务</div>
                <p className="setting-description">
                  模型、密钥和审批保存在虚拟机外。关闭客户端后，后台任务继续运行；Bot
                  不会因此获得宿主机的终端或文件权限。
                </p>
              </div>
            </div>
          </div>
        )}
        <div className="settings-section">
          <h2>外观</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">主题</div>
              <p className="setting-description">为你的工作区选择一种外观。</p>
            </div>
            <fieldset className="theme-options" aria-label="主题">
              <button
                type="button"
                aria-pressed={state.theme === 'light'}
                onClick={() => dispatch({ type: 'theme', theme: 'light' })}
              >
                <Sun />
                浅色
              </button>
              <button
                type="button"
                aria-pressed={state.theme === 'dark'}
                onClick={() => dispatch({ type: 'theme', theme: 'dark' })}
              >
                <Moon />
                深色
              </button>
            </fieldset>
          </div>
        </div>
        <Notifications />
        <div className="settings-section">
          <h2>模型与电脑</h2>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <Models />
          <div className="setting-row">
            <div>
              <div className="setting-label">本地 Linux 运行环境</div>
              <p className="setting-description">
                {runtime.enabled
                  ? runtime.snapshot.error ||
                    'Bot 的真实桌面、任务和文件都运行在本机虚拟机中。关闭客户端不会关闭 Linux。'
                  : '电脑面板目前为示例预览，终端、浏览器和文件管理器尚未连接真实系统。'}
              </p>
            </div>
            {runtime.enabled ? (
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  try {
                    await runtime.command({ type: 'connect' });
                  } catch (error) {
                    setError(runtimeError(error));
                  }
                }}
              >
                {runtime.snapshot.phase === 'ready' ? '重新连接' : '重试连接'}
              </button>
            ) : (
              <span className="badge">待接入</span>
            )}
          </div>
        </div>
        <div className="settings-section">
          <h2>运行环境</h2>
          <Diagnostics />
          <RecoveryEntry open={onRecovery} />
        </div>
        <Integrations bots={state.bots} />
        <ArchiveList state={state} dispatch={dispatch} onAction={onLifecycle} />
        <div className="settings-section">
          <h2>工作区数据</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">本机工作区数据</div>
              <p className="setting-description">
                客户端保存对话缓存、草稿、偏好副本和设置。清除客户端数据会丢失草稿；运行环境中的任务、资料和偏好需另行管理。
              </p>
            </div>
            <span className="badge">本地存储</span>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">导出工作区</div>
              <p className="setting-description">
                导出私聊缓存、草稿、偏好、设置及附件引用的 JSON 副本。群聊记录、附件原件、资料库和
                Linux 产出保存在运行环境中，不包含在这个副本里。
              </p>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                download({
                  id: 'workspace-export',
                  name: 'daban-workspace.json',
                  kind: 'JSON',
                  size: '',
                  modified: '',
                  content: serialize(state),
                })
              }
            >
              <Download />
              导出
            </button>
          </div>
        </div>
        <div className="settings-section">
          <h2>关于</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">daban</div>
              <p className="setting-description">你的 AI 工作伙伴。</p>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>
              0.1.0 · {runtime.enabled ? 'Local Agent Preview' : 'UI Preview'}
            </span>
          </div>
          <p className="inline-note" style={{ marginTop: 20 }}>
            {runtime.enabled
              ? '已接入本机 Linux 与 DSH；移动端、跨设备同步和正式安装包仍在后续计划。'
              : '本轮只包含客户端界面。移动端、跨设备同步和正式安装包尚未实现。'}
          </p>
        </div>
      </div>
    </section>
  );
}
