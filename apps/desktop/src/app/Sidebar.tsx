import { agentId, agentTask, computerTarget, recoveryBlocked } from '@daban/protocol';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderPlus,
  Inbox,
  ListTodo,
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
  Store,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { type Dispatch, type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { WindowList } from '../components/collection/WindowList';
import { IconButton } from '../components/controls/Button';
import { Avatar, Brand } from '../features/bots/Avatar';
import { RecentConversations } from '../features/chat/RecentConversations';
import { t, useLocale } from '../i18n/locale';
import { useRuntime } from './Runtime';
import { SectionDialog, type SectionEdit } from './SectionDialog';
import { type SidebarAnchor, type SidebarEntry, SidebarMenu } from './SidebarMenu';
import { demoIds } from './samples';
import type { Action, Bot, State } from './state';

export function Sidebar({
  state,
  dispatch,
  query,
  setQuery,
  searchRef,
  onCreate,
  onNewChat,
  onChats,
  onImport,
  onCopy,
  onCopyGroup,
  open,
  close,
  settingsOpen = false,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  query: string;
  setQuery: (value: string) => unknown;
  searchRef: RefObject<HTMLInputElement | null>;
  onCreate: (group?: boolean) => unknown;
  onNewChat?: () => unknown;
  onChats?: () => unknown;
  onImport?: () => unknown;
  onCopy?: (bot?: string) => unknown;
  onCopyGroup?: (group?: string) => unknown;
  open: boolean;
  close: () => unknown;
  settingsOpen?: boolean;
}) {
  useLocale();
  const runtime = useRuntime();
  const platform = window.daban?.platform ?? navigator.platform;
  const searchShortcut = platform === 'darwin' || platform.startsWith('Mac') ? '⌘ K' : 'Ctrl K';
  const [menu, setMenu] = useState<{
    kind: 'bot' | 'section';
    id: string;
    focusId: string;
    anchor: SidebarAnchor;
  }>();
  const [edit, setEdit] = useState<SectionEdit>();
  const [retainedBot, setRetainedBot] = useState('');
  const organization = state.organization;
  // biome-ignore lint/correctness/useExhaustiveDependencies: View, conversation and search define the transient menu's lifetime.
  useEffect(() => {
    setMenu(undefined);
  }, [state.view, state.selected, query, settingsOpen]);
  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      setMenu(undefined);
      if (restoreFocus && menu) {
        const focusId = menu.focusId;
        queueMicrotask(() => {
          // A following editor owns focus; moving a pinned row must not steal it back.
          if (!document.getElementById('root')?.inert)
            (
              document.getElementById(focusId) || document.getElementById('sidebar-create-section')
            )?.focus();
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
    if (kind === 'bot') setRetainedBot(id);
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
  const needle = query.toLowerCase();
  const filtered = useMemo(
    () =>
      state.bots
        .filter((b) => !b.archived && b.kind !== 'chat')
        .filter((b) => {
          if (!needle) return true;
          return `${b.name} ${b.role} ${runtime.enabled ? '' : b.preview} ${(
            state.messages[b.id] || []
          )
            .filter((message) => !runtime.enabled || !demoIds.has(message.id))
            .map((message) => message.text)
            .join(' ')}`
            .toLowerCase()
            .includes(needle);
        }),
    [state.bots, state.messages, runtime.enabled, needle],
  );
  const buckets = useMemo(() => {
    const lookup = new Map(filtered.map((bot) => [bot.id, bot]));
    const pins = new Set(organization.pins);
    const sections = new Map<string, Bot[]>();
    const bots: Bot[] = [],
      groups: Bot[] = [];
    for (const bot of filtered) {
      if (pins.has(bot.id)) continue;
      const section = organization.placements[bot.id];
      if (section) {
        const rows = sections.get(section) || [];
        rows.push(bot);
        sections.set(section, rows);
      } else (bot.members ? groups : bots).push(bot);
    }
    return {
      pins: organization.pins.flatMap((id) => lookup.get(id) || []),
      sections,
      bots,
      groups,
    };
  }, [filtered, organization.pins, organization.placements]);
  const persistent = [state.selected, retainedBot];
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
    const local = runtime.snapshot.localComputer?.session;
    let preview =
      state.controls[bot.id] === 'human' ? t('sidebar.controllingBotSComputer') : bot.preview;
    if (runtime.enabled) {
      if (bot.members)
        preview =
          runtime.snapshot.phase === 'ready' &&
          runtime.snapshot.protocolVersion >= 15 &&
          runtime.snapshot.groups?.available &&
          runtime.snapshot.groups.items.some((group) => group.id === bot.id)
            ? t('sidebar.groupConnected')
            : t('sidebar.groupDisconnected');
      else if (runtime.snapshot.phase !== 'ready')
        preview = t(
          runtime.snapshot.phase === 'connecting'
            ? 'onboarding.connectingWorkspace'
            : 'sidebar.runtimeDisconnected',
        );
      else if (computer?.owner === 'human') preview = t('sidebar.controllingBotSComputer');
      else if (agentTask(runtime.snapshot, bot.id)?.running)
        preview = t('common.processingMessage');
      else if (connection?.phase === 'connecting') preview = t('common.connectingComputer');
      else if (connection?.phase === 'stopping') preview = t('common.stoppingComputer');
      else if (computer) preview = t('sidebar.localLinuxIndependentDesktop');
      else preview = bot.role || t('sidebar.readyToChat');
    }
    if (local?.bot === agentId(bot.id) && !agentTask(runtime.snapshot, bot.id)?.running)
      preview = local.owner === 'human' ? t('localComputer.paused') : t('localComputer.connected');
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
                  aria-label={t('sidebar.hasUnreadMessages', { 0: bot.name })}
                  className="sidebar-unread"
                >
                  <span className="sr-only">{t('sidebar.unread')}</span>
                </span>
              )}
            </div>
            <div className="bot-preview">{preview}</div>
          </div>
        </button>
        <IconButton
          id={`sidebar-actions-${bot.id}`}
          label={t('sidebar.organize', { 0: bot.name })}
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
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label={t('sidebar.sidebar')}>
        <header className="sidebar-header">
          {window.daban?.platform === 'win32' && (
            <span className="sidebar-brand">
              <Brand />
              <span>Daban</span>
            </span>
          )}
          <span className="spacer" />
          <IconButton label={t('common.newBot')} onClick={() => onCreate()}>
            <Plus />
          </IconButton>
          <IconButton className="sidebar-close" label={t('sidebar.closeSidebar')} onClick={close}>
            <X />
          </IconButton>
        </header>
        <div className="search-wrap">
          <Search />
          <input
            ref={searchRef}
            type="search"
            aria-label={t('sidebar.searchBotsChats')}
            placeholder={t('sidebar.searchBotsChats')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>{searchShortcut}</kbd>
        </div>
        <div className="nav-main">
          {onNewChat && (
            <button type="button" className="nav-row sidebar-new-chat" onClick={onNewChat}>
              <Plus aria-hidden="true" />
              {t('conversations.newChat')}
            </button>
          )}
          <button
            type="button"
            className={`nav-row ${state.view === 'gallery' ? 'selected' : ''}`}
            onClick={() => {
              dispatch({ type: 'view', view: 'gallery' });
              close();
            }}
          >
            <Store />
            {t('common.botGallery')}
          </button>
          <button
            type="button"
            className={`nav-row ${state.view === 'tasks' ? 'selected' : ''}`}
            aria-label={
              state.work?.pending ? t('sidebar.taskActionAwaitingConfirmation') : t('common.tasks')
            }
            onClick={() => {
              dispatch({ type: 'view', view: 'tasks' });
              close();
            }}
          >
            <ListTodo />
            {t('common.tasks')}
            {state.work?.pending && (
              <span className="nav-count">{t('common.awaitingConfirmation')}</span>
            )}
          </button>
          <button
            type="button"
            className={`nav-row ${state.view === 'inbox' ? 'selected' : ''}`}
            onClick={() => {
              dispatch({ type: 'view', view: 'inbox' });
              close();
            }}
          >
            <Inbox />
            {t('common.inbox')}
            {pending > 0 && <span className="count">{pending}</span>}
          </button>
          <button
            type="button"
            className={`nav-row ${state.view === 'chat' && state.bots.find((bot) => bot.id === state.selected)?.kind === 'chat' ? 'selected' : ''}`}
            onClick={() => {
              if (onChats) onChats();
              else dispatch({ type: 'view', view: 'chat' });
              close();
            }}
          >
            <MessageSquare />
            {t('sidebar.chats')}
          </button>
        </div>
        <div className="sidebar-scroll">
          <RecentConversations state={state} dispatch={dispatch} query={query} close={close} />
          <div className="section-label">
            <span>{t('sidebar.bots')}</span>
            <span className="spacer" />
            <IconButton
              id="sidebar-create-section"
              label={t('common.newSection')}
              onClick={() => setEdit({ kind: 'create', focusId: 'sidebar-create-section' })}
            >
              <FolderPlus />
            </IconButton>
            <IconButton label={t('sidebar.createBotGroup')} onClick={() => onCreate(true)}>
              <Users />
            </IconButton>
            <IconButton label={t('sidebar.addBot')} onClick={() => onCreate()}>
              <Plus />
            </IconButton>
          </div>
          <nav aria-label={t('sidebar.botList')}>
            {buckets.pins.length > 0 && (
              <fieldset aria-label={t('sidebar.pin')} className="sidebar-block">
                <div className="section-label">
                  <Pin aria-hidden="true" />
                  <span>{t('sidebar.pin')}</span>
                </div>
                <WindowList
                  scope={`pins:${query}`}
                  items={buckets.pins}
                  getKey={(bot) => bot.id}
                  renderItem={row}
                  persistentKeys={persistent}
                  estimate={76}
                />
              </fieldset>
            )}
            {organization.sections.map((section) => {
              const members = buckets.sections.get(section.id) || [];
              if (query && !members.length) return null;
              const expanded = !section.collapsed || !!query;
              return (
                <fieldset key={section.id} aria-label={section.name} className="sidebar-block">
                  <div className="section-label">
                    <button
                      type="button"
                      className="section-toggle"
                      disabled={!!query}
                      aria-label={`${expanded ? t('common.collapse') : t('common.expand')} ${section.name}`}
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
                      label={t('sidebar.organizeSection', { 0: section.name })}
                      aria-haspopup="menu"
                      aria-expanded={menu?.kind === 'section' && menu.id === section.id}
                      onClick={(event) => openMenu('section', section.id, event.currentTarget)}
                    >
                      <MoreHorizontal />
                    </IconButton>
                  </div>
                  {expanded &&
                    (members.length ? (
                      <WindowList
                        scope={`${section.id}:${query}`}
                        items={members}
                        getKey={(bot) => bot.id}
                        renderItem={row}
                        persistentKeys={persistent}
                        estimate={76}
                      />
                    ) : (
                      <p className="section-empty">{t('sidebar.noBotsYetUseOrganizeMenuBeside')}</p>
                    ))}
                </fieldset>
              );
            })}
            {organization.sections.length > 0 &&
              (buckets.bots.length > 0 || buckets.groups.length > 0) && (
                <div className="section-label">{t('sidebar.ungrouped')}</div>
              )}
            {state.bots.some((entry) => !entry.members) &&
              state.bots.every((entry) => entry.members || entry.archived) && (
                <p className="no-results">{t('sidebar.allBotsArchived')}</p>
              )}
            <WindowList
              scope={`bots:${query}`}
              items={buckets.bots}
              getKey={(bot) => bot.id}
              renderItem={row}
              persistentKeys={persistent}
              estimate={76}
            />
            {buckets.groups.length > 0 && (
              <div className="section-label">
                <span>{t('common.groupChat')}</span>
                <span className="spacer" />
                <IconButton label={t('sidebar.addGroup')} onClick={() => onCreate(true)}>
                  <Plus />
                </IconButton>
              </div>
            )}
            <WindowList
              scope={`groups:${query}`}
              items={buckets.groups}
              getKey={(bot) => bot.id}
              renderItem={row}
              persistentKeys={persistent}
              estimate={76}
            />
            {!state.bots.length && !query && (
              <div className="no-results">
                {t('sidebar.noBotsYet')}
                <br />
                {t('sidebar.pickPresetGalleryCreateOwnCompanion')}
              </div>
            )}
            {!filtered.length && !!query && (
              <div className="no-results">
                {t('sidebar.noResults')}
                {query}」<br />
                {t('sidebar.tryBotNameConversationText')}
              </div>
            )}
          </nav>
        </div>
        <footer className="sidebar-footer">
          {state.groupCopy && onCopyGroup && (
            <button className="bundle-import-entry" type="button" onClick={() => onCopyGroup()}>
              {t('sidebar.copyGroupCheckProgress')}
            </button>
          )}
          {state.botCopy && onCopy && (
            <button className="bundle-import-entry" type="button" onClick={() => onCopy()}>
              {t('sidebar.copyBotCheckProgress')}
            </button>
          )}
          {state.botImport && onImport && (
            <button className="bundle-import-entry" type="button" onClick={onImport}>
              {t('sidebar.importBotViewProgress')}
            </button>
          )}
          <div className="local-workspace">
            <span className="local-icon">
              <Brand />
            </span>
            <div className="workspace-info">
              <div className="workspace-name">{t('sidebar.localWorkspace')}</div>
              <div className="demo-label">
                <span className="status-dot" />
                <span className="workspace-status">
                  {runtime.enabled
                    ? runtime.snapshot.phase === 'ready'
                      ? runtime.snapshot.agent?.execution === 'local-workspace'
                        ? t('localComputer.workspace')
                        : t('sidebar.linuxConnectedRunningLocally')
                      : runtime.snapshot.phase === 'connecting'
                        ? t('onboarding.connectingWorkspace')
                        : t('sidebar.runtimeDisconnected')
                    : t('sidebar.uiDemoSavedLocally')}
                </span>
              </div>
            </div>
            <span className="spacer" />
            <IconButton
              label={t('settings.title')}
              className={settingsOpen || state.view === 'settings' ? 'active' : ''}
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
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
          label={menu.kind === 'bot' ? t('sidebar.organizeBot') : t('sidebar.organizeSections')}
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
                            label: t('common.copyGroup'),
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
                            label: t('common.copyBot'),
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
                      label: pinned ? t('sidebar.unpin') : t('sidebar.pin'),
                      icon: pinned ? <PinOff /> : <Pin />,
                      onSelect: () => dispatch({ type: 'bot-pin', bot: bot.id, pinned: !pinned }),
                    },
                    {
                      id: 'unread',
                      kind: 'action',
                      label: unread ? t('sidebar.markRead') : t('sidebar.markUnread'),
                      icon: unread ? <MailOpen /> : <Mail />,
                      onSelect: () => dispatch({ type: 'bot-read', bot: bot.id, unread: !unread }),
                    },
                    { id: 'placement-divider', kind: 'separator' },
                    { id: 'placement-label', kind: 'label', label: t('sidebar.moveSection') },
                    {
                      id: 'unassigned',
                      kind: 'action',
                      label: t('sidebar.removeCustomSection'),
                      checked: !organization.placements[bot.id],
                      onSelect: () => dispatch({ type: 'bot-section', bot: bot.id }),
                    },
                    ...organization.sections.map(
                      (section): SidebarEntry => ({
                        id: `placement-${section.id}`,
                        kind: 'action',
                        label: t('sidebar.move', { 0: section.name }),
                        checked: organization.placements[bot.id] === section.id,
                        onSelect: () =>
                          dispatch({ type: 'bot-section', bot: bot.id, section: section.id }),
                      }),
                    ),
                    { id: 'create-divider', kind: 'separator' },
                    {
                      id: 'create-section',
                      kind: 'action',
                      label: t('sidebar.newSection'),
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
                      label: t('common.renameSection'),
                      icon: <Pencil />,
                      onSelect: () =>
                        setEdit({ kind: 'rename', id: menu.id, focusId: menu.focusId }),
                    },
                    {
                      id: 'move-up',
                      kind: 'action',
                      label: t('sidebar.moveSectionUp'),
                      icon: <ArrowUp />,
                      disabled: index <= 0,
                      onSelect: () =>
                        dispatch({ type: 'section-move', id: menu.id, direction: -1 }),
                    },
                    {
                      id: 'move-down',
                      kind: 'action',
                      label: t('sidebar.moveSectionDown'),
                      icon: <ArrowDown />,
                      disabled: index < 0 || index >= organization.sections.length - 1,
                      onSelect: () => dispatch({ type: 'section-move', id: menu.id, direction: 1 }),
                    },
                    { id: 'remove-divider', kind: 'separator' },
                    {
                      id: 'remove',
                      kind: 'action',
                      label: t('common.removeSection'),
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
