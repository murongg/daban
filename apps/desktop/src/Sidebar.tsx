import { agentTask, computerTarget } from '@daban/protocol';
import { Inbox, Laptop, MessageSquare, Plus, Search, Settings, Users, X } from 'lucide-react';
import type { Dispatch, RefObject } from 'react';
import { Avatar, Brand } from './Avatar';
import { IconButton } from './Button';
import { useRuntime } from './Runtime';
import type { Action, Bot, State } from './state';

export function Sidebar({
  state,
  dispatch,
  query,
  setQuery,
  searchRef,
  onCreate,
  onImport,
  open,
  close,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  query: string;
  setQuery: (value: string) => unknown;
  searchRef: RefObject<HTMLInputElement | null>;
  onCreate: (group?: boolean) => unknown;
  onImport?: () => unknown;
  open: boolean;
  close: () => unknown;
}) {
  const runtime = useRuntime();
  const pending = runtime.enabled
    ? (runtime.snapshot.interactions || []).filter((item) => item.status === 'pending').length
    : state.approvals.filter((a) => a.status === 'pending').length;
  const filtered = state.bots
    .filter((b) => !b.archived)
    .filter((b) =>
      `${b.name} ${b.role} ${b.preview} ${(state.messages[b.id] || []).map((m) => m.text).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  function select(bot: string) {
    dispatch({ type: 'select', bot });
    close();
  }
  function row(bot: Bot) {
    const target = computerTarget(runtime.snapshot, bot.id);
    const computer = target ? runtime.snapshot.bots[target] : undefined;
    const connection = runtime.snapshot.computers?.items.find((item) => item.bot === target);
    let preview = state.controls[bot.id] === 'human' ? '你正在接管这位 Bot 的电脑' : bot.preview;
    if (runtime.enabled) {
      if (bot.members)
        preview =
          runtime.snapshot.phase === 'ready' &&
          runtime.snapshot.protocolVersion >= 15 &&
          runtime.snapshot.groups?.available &&
          runtime.snapshot.groups.items.some((group) => group.id === bot.id)
            ? '群聊 · 已连接'
            : '群聊 · 未连接';
      else if (computer?.owner === 'human') preview = '你正在接管这位 Bot 的电脑';
      else if (agentTask(runtime.snapshot, bot.id)?.running) preview = '正在处理你的消息';
      else if (connection?.phase === 'connecting') preview = '正在连接电脑';
      else if (connection?.phase === 'stopping') preview = '正在停止电脑';
      else if (computer) preview = '本机 Linux · 独立桌面';
      else preview = '可对话 · 未连接电脑';
    }
    return (
      <button
        type="button"
        key={bot.id}
        aria-label={bot.name}
        className={`bot-row ${state.view === 'chat' && state.selected === bot.id ? 'selected' : ''}`}
        onClick={() => select(bot.id)}
        aria-current={state.view === 'chat' && state.selected === bot.id ? 'page' : undefined}
      >
        <Avatar
          bot={bot}
          human={runtime.enabled ? computer?.owner === 'human' : state.controls[bot.id] === 'human'}
        />
        <div className="bot-row-copy">
          <div className="bot-row-top">
            <span className="bot-name">{bot.name}</span>
            <span className="bot-time">{runtime.enabled ? '' : bot.time}</span>
          </div>
          <div className="bot-preview">{preview}</div>
        </div>
      </button>
    );
  }
  return (
    <>
      {open && <div className="sidebar-scrim" onClick={close} aria-hidden="true" />}
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="侧栏">
        <header className="sidebar-brand">
          <Brand />
          <span className="wordmark">daban</span>
          <span className="brand-beta">preview</span>
          <span className="spacer" />
          <IconButton label="新建 Bot" onClick={() => onCreate()}>
            <Plus />
          </IconButton>
          <IconButton className="sidebar-close" label="关闭侧栏" onClick={close}>
            <X />
          </IconButton>
        </header>
        <div className="search-wrap">
          <Search />
          <input
            ref={searchRef}
            type="search"
            aria-label="搜索 Bot 和对话"
            placeholder="搜索 Bot 和对话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌘ K</kbd>
        </div>
        <div className="nav-main">
          <button
            type="button"
            className={`nav-row ${state.view === 'inbox' ? 'selected' : ''}`}
            onClick={() => {
              dispatch({ type: 'view', view: 'inbox' });
              close();
            }}
          >
            <Inbox />
            收件箱{pending > 0 && <span className="count">{pending}</span>}
          </button>
          <button
            type="button"
            className={`nav-row ${state.view === 'chat' ? 'selected' : ''}`}
            onClick={() => {
              dispatch({ type: 'view', view: 'chat' });
              close();
            }}
          >
            <MessageSquare />
            对话
          </button>
        </div>
        <div className="sidebar-scroll">
          <div className="section-label">
            <span>你的 Bot</span>
            <span className="spacer" />
            <IconButton label="创建 Bot 群聊" onClick={() => onCreate(true)}>
              <Users />
            </IconButton>
            <IconButton label="添加 Bot" onClick={() => onCreate()}>
              <Plus />
            </IconButton>
          </div>
          <nav aria-label="Bot 列表">
            {state.bots.some((entry) => !entry.members) &&
              state.bots.every((entry) => entry.members || entry.archived) && (
                <p className="no-results">所有 Bot 都已归档</p>
              )}
            {filtered.filter((b) => !b.members).map(row)}
            {filtered.some((b) => b.members) && (
              <div className="section-label">
                <span>群聊</span>
                <span className="spacer" />
                <IconButton label="添加群聊" onClick={() => onCreate(true)}>
                  <Plus />
                </IconButton>
              </div>
            )}
            {filtered.filter((b) => b.members).map(row)}
            {!filtered.length && (
              <div className="no-results">
                没有找到「{query}」<br />
                试试 Bot 名称或对话内容。
              </div>
            )}
          </nav>
        </div>
        <footer className="sidebar-footer">
          {state.botImport && onImport && (
            <button className="bundle-import-entry" type="button" onClick={onImport}>
              Bot 导入 · 查看进度
            </button>
          )}
          <div className="local-workspace">
            <span className="local-icon">
              <Laptop />
            </span>
            <div>
              <div className="workspace-name">本机工作区</div>
              <div className="demo-label">
                <span className="status-dot" />
                {runtime.enabled
                  ? runtime.snapshot.phase === 'ready'
                    ? 'Linux 已连接 · 本机运行'
                    : runtime.snapshot.phase === 'connecting'
                      ? '正在启动 Linux…'
                      : '运行环境连接中断'
                  : '界面演示 · 本机保存'}
              </div>
            </div>
            <span className="spacer" />
            <IconButton
              label="设置"
              className={state.view === 'settings' ? 'active' : ''}
              onClick={() => {
                dispatch({ type: 'view', view: 'settings' });
                close();
              }}
            >
              <Settings />
            </IconButton>
          </div>
        </footer>
      </aside>
    </>
  );
}
