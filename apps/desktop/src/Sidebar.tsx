import { agentId, agentTask, computerTarget, recoveryBlocked } from '@daban/protocol';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderPlus,
  Inbox,
  Laptop,
  Mail,
  MailOpen,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { type Dispatch, type RefObject, useCallback, useEffect, useState } from 'react';
import { Avatar, Brand } from './Avatar';
import { IconButton } from './Button';
import { demoIds } from './fixtures';
import { useRuntime } from './Runtime';
import { SectionDialog, type SectionEdit } from './SectionDialog';
import { type SidebarAnchor, type SidebarEntry, SidebarMenu } from './SidebarMenu';
import type { Action, Bot, State } from './state';

export function Sidebar({
  state,
  dispatch,
  query,
  setQuery,
  searchRef,
  onCreate,
  onImport,
  onCopy,
  onCopyGroup,
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
  onCopy?: (bot?: string) => unknown;
  onCopyGroup?: (group?: string) => unknown;
  open: boolean;
  close: () => unknown;
}) {
  const runtime = useRuntime();
  const [menu, setMenu] = useState<{
    kind: 'bot' | 'section';
    id: string;
    focusId: string;
    anchor: SidebarAnchor;
  }>();
  const [edit, setEdit] = useState<SectionEdit>();
  const organization = state.organization;
  // biome-ignore lint/correctness/useExhaustiveDependencies: View, conversation and search define the transient menu's lifetime.
  useEffect(() => {
    setMenu(undefined);
  }, [state.view, state.selected, query]);
  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      setMenu(undefined);
      if (restoreFocus && menu) {
        const focusId = menu.focusId;
        queueMicrotask(() => {
          // A following editor owns focus; moving a pinned row must not steal it back.
          if (!document.getElementById('root')?.inert) document.getElementById(focusId)?.focus();
        });
      }
    },
    [menu],
  );
  const closeEdit = useCallback(() => {
    setEdit(undefined);
    if (edit)
      queueMicrotask(() => {
        // Removing a section removes its trigger too; keep keyboard users in the list controls.
        (
          document.getElementById(edit.focusId) || document.getElementById('sidebar-create-section')
        )?.focus();
      });
  }, [edit]);
  function openMenu(kind: 'bot' | 'section', id: string, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    setMenu((current) =>
      current?.kind === kind && current.id === id
        ? undefined
        : {
            kind,
            id,
            focusId: element.id,
            anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          },
    );
  }
  const pending = runtime.enabled
    ? (runtime.snapshot.interactions || []).filter((item) => item.status === 'pending').length
    : state.approvals.filter((a) => a.status === 'pending').length;
  // Shipped demo previews are not runtime history; search the user's retained messages instead.
  const filtered = state.bots
    .filter((b) => !b.archived)
    .filter((b) =>
      `${b.name} ${b.role} ${runtime.enabled ? '' : b.preview} ${(state.messages[b.id] || [])
        .filter((message) => !runtime.enabled || !demoIds.has(message.id))
        .map((message) => message.text)
        .join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  function select(bot: string) {
    setMenu(undefined);
    dispatch({ type: 'select', bot });
    close();
  }
  function row(bot: Bot) {
    const unread = organization.attention.unread.includes(bot.id);
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
      <div
        key={bot.id}
        className={`bot-entry ${state.view === 'chat' && state.selected === bot.id ? 'selected' : ''}`}
      >
        <button
          type="button"
          id={`sidebar-bot-${bot.id}`}
          aria-label={bot.name}
          aria-describedby={unread ? `sidebar-unread-${bot.id}` : undefined}
          className="bot-row"
          onClick={() => select(bot.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu('bot', bot.id, event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              openMenu('bot', bot.id, event.currentTarget);
            }
          }}
          aria-current={state.view === 'chat' && state.selected === bot.id ? 'page' : undefined}
        >
          <Avatar
            bot={bot}
            human={
              runtime.enabled ? computer?.owner === 'human' : state.controls[bot.id] === 'human'
            }
          />
          <div className="bot-row-copy">
            <div className="bot-row-top">
              <span className="bot-name">{bot.name}</span>
              <span className="bot-time">{runtime.enabled ? '' : bot.time}</span>
              {unread && (
                <span
                  id={`sidebar-unread-${bot.id}`}
                  role="status"
                  aria-label={`${bot.name}有未读消息`}
                  className="sidebar-unread"
                >
                  <span className="sr-only">未读</span>
                </span>
              )}
            </div>
            <div className="bot-preview">{preview}</div>
          </div>
        </button>
        <IconButton
          id={`sidebar-actions-${bot.id}`}
          label={`整理 ${bot.name}`}
          className="bot-actions"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'bot' && menu.id === bot.id}
          onClick={(event) => openMenu('bot', bot.id, event.currentTarget)}
        >
          <MoreHorizontal />
        </IconButton>
      </div>
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
            <IconButton
              id="sidebar-create-section"
              label="新建分组"
              onClick={() => setEdit({ kind: 'create', focusId: 'sidebar-create-section' })}
            >
              <FolderPlus />
            </IconButton>
            <IconButton label="创建 Bot 群聊" onClick={() => onCreate(true)}>
              <Users />
            </IconButton>
            <IconButton label="添加 Bot" onClick={() => onCreate()}>
              <Plus />
            </IconButton>
          </div>
          <nav aria-label="Bot 列表">
            {organization.pins.some((id) => filtered.some((bot) => bot.id === id)) && (
              <fieldset aria-label="置顶" className="sidebar-block">
                <div className="section-label">
                  <Pin aria-hidden="true" />
                  <span>置顶</span>
                </div>
                {organization.pins
                  .flatMap((id) => filtered.find((bot) => bot.id === id) || [])
                  .map(row)}
              </fieldset>
            )}
            {organization.sections.map((section) => {
              const members = filtered.filter(
                (bot) =>
                  organization.placements[bot.id] === section.id &&
                  !organization.pins.includes(bot.id),
              );
              if (query && !members.length) return null;
              const expanded = !section.collapsed || !!query;
              return (
                <fieldset key={section.id} aria-label={section.name} className="sidebar-block">
                  <div className="section-label">
                    <button
                      type="button"
                      className="section-toggle"
                      disabled={!!query}
                      aria-label={`${expanded ? '收起' : '展开'} ${section.name}`}
                      aria-expanded={expanded}
                      onClick={() =>
                        dispatch({
                          type: 'section-collapse',
                          id: section.id,
                          collapsed: !section.collapsed,
                        })
                      }
                    >
                      {expanded ? (
                        <ChevronDown aria-hidden="true" />
                      ) : (
                        <ChevronRight aria-hidden="true" />
                      )}
                      <span>{section.name}</span>
                    </button>
                    <IconButton
                      id={`sidebar-section-${section.id}`}
                      label={`整理分组 ${section.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.kind === 'section' && menu.id === section.id}
                      onClick={(event) => openMenu('section', section.id, event.currentTarget)}
                    >
                      <MoreHorizontal />
                    </IconButton>
                  </div>
                  {expanded &&
                    (members.length ? (
                      members.map(row)
                    ) : (
                      <p className="section-empty">还没有 Bot，使用列表旁的整理菜单移入。</p>
                    ))}
                </fieldset>
              );
            })}
            {organization.sections.length > 0 &&
              filtered.some(
                (bot) => !organization.placements[bot.id] && !organization.pins.includes(bot.id),
              ) && <div className="section-label">未分组</div>}
            {state.bots.some((entry) => !entry.members) &&
              state.bots.every((entry) => entry.members || entry.archived) && (
                <p className="no-results">所有 Bot 都已归档</p>
              )}
            {filtered
              .filter(
                (b) =>
                  !b.members && !organization.pins.includes(b.id) && !organization.placements[b.id],
              )
              .map(row)}
            {filtered.some(
              (b) =>
                b.members && !organization.pins.includes(b.id) && !organization.placements[b.id],
            ) && (
              <div className="section-label">
                <span>群聊</span>
                <span className="spacer" />
                <IconButton label="添加群聊" onClick={() => onCreate(true)}>
                  <Plus />
                </IconButton>
              </div>
            )}
            {filtered
              .filter(
                (b) =>
                  b.members && !organization.pins.includes(b.id) && !organization.placements[b.id],
              )
              .map(row)}
            {!filtered.length && (
              <div className="no-results">
                没有找到「{query}」<br />
                试试 Bot 名称或对话内容。
              </div>
            )}
          </nav>
        </div>
        <footer className="sidebar-footer">
          {state.groupCopy && onCopyGroup && (
            <button className="bundle-import-entry" type="button" onClick={() => onCopyGroup()}>
              群聊复制 · 核对进度
            </button>
          )}
          {state.botCopy && onCopy && (
            <button className="bundle-import-entry" type="button" onClick={() => onCopy()}>
              Bot 复制 · 核对进度
            </button>
          )}
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
      {menu && (
        <SidebarMenu
          label={menu.kind === 'bot' ? 'Bot 整理' : '分组整理'}
          anchor={menu.anchor}
          focusId={menu.focusId}
          onClose={closeMenu}
          items={
            menu.kind === 'bot'
              ? (() => {
                  const bot = state.bots.find((bot) => bot.id === menu.id);
                  if (!bot || bot.archived) return [];
                  const pinned = organization.pins.includes(bot.id);
                  const unread = organization.attention.unread.includes(bot.id);
                  const items: SidebarEntry[] = [
                    ...(bot.members && onCopyGroup
                      ? [
                          {
                            id: 'copy-group',
                            kind: 'action' as const,
                            label: '复制群聊',
                            icon: <Copy />,
                            disabled:
                              !!state.groupCopy ||
                              !runtime.enabled ||
                              runtime.snapshot.phase !== 'ready' ||
                              runtime.snapshot.protocolVersion < 35 ||
                              recoveryBlocked(runtime.snapshot) ||
                              !!state.groupActions[bot.id] ||
                              !runtime.snapshot.groups?.items.some(
                                (group) => group.id === bot.id && !group.archived,
                              ),
                            onSelect: () => onCopyGroup(bot.id),
                          },
                        ]
                      : []),
                    ...(!bot.members && onCopy
                      ? [
                          {
                            id: 'copy',
                            kind: 'action' as const,
                            label: '复制 Bot',
                            icon: <Copy />,
                            disabled:
                              !!state.botCopy ||
                              !runtime.enabled ||
                              runtime.snapshot.phase !== 'ready' ||
                              runtime.snapshot.protocolVersion < 34 ||
                              recoveryBlocked(runtime.snapshot) ||
                              !!state.lifecycleRequests[bot.id] ||
                              !runtime.snapshot.profiles.some(
                                (profile) =>
                                  profile.id === agentId(bot.id) &&
                                  !profile.archived &&
                                  profile.lifecycle?.phase !== 'pending',
                              ),
                            onSelect: () => onCopy(bot.id),
                          },
                        ]
                      : []),
                    {
                      id: 'pin',
                      kind: 'action',
                      label: pinned ? '取消置顶' : '置顶',
                      icon: pinned ? <PinOff /> : <Pin />,
                      onSelect: () => dispatch({ type: 'bot-pin', bot: bot.id, pinned: !pinned }),
                    },
                    {
                      id: 'unread',
                      kind: 'action',
                      label: unread ? '标为已读' : '标为未读',
                      icon: unread ? <MailOpen /> : <Mail />,
                      onSelect: () => dispatch({ type: 'bot-read', bot: bot.id, unread: !unread }),
                    },
                    { id: 'placement-divider', kind: 'separator' },
                    { id: 'placement-label', kind: 'label', label: '移到分组' },
                    {
                      id: 'unassigned',
                      kind: 'action',
                      label: '移出自定义分组',
                      checked: !organization.placements[bot.id],
                      onSelect: () => dispatch({ type: 'bot-section', bot: bot.id }),
                    },
                    ...organization.sections.map(
                      (section): SidebarEntry => ({
                        id: `placement-${section.id}`,
                        kind: 'action',
                        label: `移到 ${section.name}`,
                        checked: organization.placements[bot.id] === section.id,
                        onSelect: () =>
                          dispatch({ type: 'bot-section', bot: bot.id, section: section.id }),
                      }),
                    ),
                    { id: 'create-divider', kind: 'separator' },
                    {
                      id: 'create-section',
                      kind: 'action',
                      label: '新建分组…',
                      icon: <FolderPlus />,
                      onSelect: () =>
                        setEdit({ kind: 'create', bot: bot.id, focusId: menu.focusId }),
                    },
                  ];
                  return items;
                })()
              : (() => {
                  const index = organization.sections.findIndex(
                    (section) => section.id === menu.id,
                  );
                  const items: SidebarEntry[] = [
                    {
                      id: 'rename',
                      kind: 'action',
                      label: '重命名分组',
                      icon: <Pencil />,
                      onSelect: () =>
                        setEdit({ kind: 'rename', id: menu.id, focusId: menu.focusId }),
                    },
                    {
                      id: 'move-up',
                      kind: 'action',
                      label: '分组上移',
                      icon: <ArrowUp />,
                      disabled: index <= 0,
                      onSelect: () =>
                        dispatch({ type: 'section-move', id: menu.id, direction: -1 }),
                    },
                    {
                      id: 'move-down',
                      kind: 'action',
                      label: '分组下移',
                      icon: <ArrowDown />,
                      disabled: index < 0 || index >= organization.sections.length - 1,
                      onSelect: () => dispatch({ type: 'section-move', id: menu.id, direction: 1 }),
                    },
                    { id: 'remove-divider', kind: 'separator' },
                    {
                      id: 'remove',
                      kind: 'action',
                      label: '移除分组',
                      icon: <Trash2 />,
                      onSelect: () =>
                        setEdit({ kind: 'remove', id: menu.id, focusId: menu.focusId }),
                    },
                  ];
                  return items;
                })()
          }
        />
      )}
      {edit && (
        <SectionDialog
          key={`${edit.kind}-${edit.id || ''}`}
          edit={edit}
          state={state}
          dispatch={dispatch}
          onClose={closeEdit}
        />
      )}
    </>
  );
}
