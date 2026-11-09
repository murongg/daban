import { agentTask } from '@daban/protocol';
import { Archive, ArchiveRestore, LoaderCircle, Pin, Plus, Trash2 } from 'lucide-react';
import { type Dispatch, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { type SidebarAnchor, SidebarMenu } from '../../app/SidebarMenu';
import { type Action, type ConversationPlacement, chatRevision, type State } from '../../app/state';
import { WindowList } from '../../components/collection/WindowList';
import { IconButton } from '../../components/controls/Button';
import { t } from '../../i18n/locale';
import { conversationKey, recentConversations } from './conversations';
import './conversations.css';

const previewLimit = 5;

export function RecentConversations({
  state,
  dispatch,
  query,
  close,
  onNewChat,
  onTrash,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  query: string;
  close: () => unknown;
  onNewChat?: () => unknown;
  onTrash?: (bot: string, revision: number, title: string) => unknown;
}) {
  const runtime = useRuntime();
  const [expanded, setExpanded] = useState(false);
  const overflowId = useId();
  const expandId = `${overflowId}-toggle`;
  const archiveId = useId();
  const placementFocus = useRef<string>(null);
  useLayoutEffect(() => {
    const id = placementFocus.current;
    if (!id) return;
    placementFocus.current = null;
    // Restore focus before the next keypress if reordering moved or unmounted the button.
    (
      document.getElementById(id) ??
      document.getElementById(expandId) ??
      document.getElementById(archiveId) ??
      document.getElementById('recent-new-chat')
    )?.focus();
  });
  const [menu, setMenu] = useState<{
    bot: string;
    revision: number;
    title: string;
    anchor: SidebarAnchor;
    focusId: string;
  }>();
  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus && menu) {
        const focusId = menu.focusId;
        requestAnimationFrame(() =>
          (document.getElementById(focusId) ?? document.getElementById('recent-new-chat'))?.focus(),
        );
      }
      setMenu(undefined);
    },
    [menu],
  );
  const needle = query.trim().toLowerCase();
  // Local ordinary chats can be reopened before the backend supports conversation history.
  const unified = !runtime.enabled || runtime.snapshot.protocolVersion >= 46;
  const rows = recentConversations(state, unified ? runtime.snapshot.chats : undefined).filter(
    (row) => {
      const bot = state.bots.find((bot) => bot.id === row.bot);
      return (
        (unified || bot?.kind === 'chat') &&
        (!needle || `${row.title} ${bot?.name ?? ''}`.toLowerCase().includes(needle))
      );
    },
  );
  if (!rows.length && !onNewChat) return null;
  const pinned: typeof rows = [];
  const ordinary: typeof rows = [];
  const archived: typeof rows = [];
  for (const row of rows) {
    const placement = state.conversationPlacements?.[conversationKey(row.bot, row.revision)];
    if (placement === 'archived') archived.push(row);
    else if (placement === 'pinned') pinned.push(row);
    else ordinary.push(row);
  }
  const recent = [...pinned, ...ordinary];
  const limit = Math.max(previewLimit, pinned.length);
  const canExpand = !needle && recent.length > limit;
  function place(row: (typeof rows)[number], placement: ConversationPlacement, focusId: string) {
    placementFocus.current = focusId;
    dispatch({ type: 'conversation-place', bot: row.bot, revision: row.revision, placement });
  }
  const renderRows = (items: typeof rows, scope: string) => (
    <WindowList
      scope={`conversations:${scope}:${query}`}
      items={items}
      estimate={48}
      getKey={(row) => conversationKey(row.bot, row.revision)}
      persistentKeys={[
        conversationKey(
          state.selected,
          chatRevision(state, state.selected, runtime.snapshot.chats),
        ),
        ...(menu ? [conversationKey(menu.bot, menu.revision)] : []),
      ]}
      renderItem={(row) => {
        const bot = state.bots.find((bot) => bot.id === row.bot)!;
        const task = agentTask(runtime.snapshot, row.bot);
        const active =
          task?.running && !task.conversationId && (task.chatRevision ?? 0) === row.revision;
        const processing = active && (task.phase === 'starting' || task.phase === 'running');
        const status = active
          ? t(
              task.phase === 'waiting'
                ? 'common.awaitingConfirmation'
                : task.phase === 'paused'
                  ? 'chat.waitingHandBackControl'
                  : 'common.processingMessage',
            )
          : undefined;
        const detail = [bot.kind !== 'chat' && bot.name, !processing && status]
          .filter(Boolean)
          .join(' · ');
        const selected =
          state.view === 'chat' &&
          state.selected === row.bot &&
          chatRevision(state, row.bot, runtime.snapshot.chats) === row.revision;
        const key = conversationKey(row.bot, row.revision);
        const placement = state.conversationPlacements?.[key];
        const focusId = `conversation-row-${key}`;
        const pinId = `conversation-pin-${key}`;
        const openMenu = (element: HTMLElement) =>
          setMenu({
            bot: row.bot,
            revision: row.revision,
            title: row.title,
            anchor: element.getBoundingClientRect(),
            focusId,
          });
        return (
          <div className={`recent-entry ${selected ? 'selected' : ''}`}>
            <button
              id={focusId}
              type="button"
              className="recent-conversation"
              aria-current={selected ? 'page' : undefined}
              aria-keyshortcuts={onTrash ? 'Shift+F10' : undefined}
              onContextMenu={
                onTrash
                  ? (event) => {
                      event.preventDefault();
                      openMenu(event.currentTarget);
                    }
                  : undefined
              }
              onKeyDown={
                onTrash
                  ? (event) => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        openMenu(event.currentTarget);
                      }
                    }
                  : undefined
              }
              onClick={() => {
                if (runtime.snapshot.chats?.available)
                  dispatch({
                    type: 'chats',
                    items: runtime.snapshot.chats.items,
                    keepSelection: true,
                  });
                dispatch({ type: 'chat-select', bot: row.bot, revision: row.revision });
                dispatch({ type: 'bot-read', bot: row.bot, unread: false });
                close();
              }}
            >
              <span className="recent-conversation-copy">
                <span className="recent-conversation-title">{row.title}</span>
                {detail && <span className="recent-conversation-detail">{detail}</span>}
                {processing && <span className="sr-only">{status}</span>}
              </span>
            </button>
            <div className="recent-actions">
              {placement === 'archived' ? (
                <IconButton
                  className="recent-action"
                  label={t('common.restoreNamedItem', { 0: row.title })}
                  onClick={() => place(row, 'recent', focusId)}
                >
                  <ArchiveRestore aria-hidden="true" />
                </IconButton>
              ) : (
                <>
                  <IconButton
                    id={pinId}
                    className="recent-action"
                    label={t('conversations.pinNamed', { 0: row.title })}
                    title={t(
                      placement === 'pinned'
                        ? 'conversations.unpinNamed'
                        : 'conversations.pinNamed',
                      { 0: row.title },
                    )}
                    aria-pressed={placement === 'pinned'}
                    onClick={() => place(row, placement === 'pinned' ? 'recent' : 'pinned', pinId)}
                  >
                    <Pin aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    className="recent-action"
                    label={t('conversations.archiveNamed', { 0: row.title })}
                    onClick={() => place(row, 'archived', archiveId)}
                  >
                    <Archive aria-hidden="true" />
                  </IconButton>
                </>
              )}
            </div>
            {processing && (
              <LoaderCircle
                className="recent-progress setup-spinner"
                size={14}
                aria-hidden="true"
              />
            )}
          </div>
        );
      }}
    />
  );
  return (
    <section className="recent-conversations" aria-label={t('conversations.recent')}>
      <div className="section-label">
        <span>{t('conversations.recent')}</span>
        <span className="spacer" />
        {onNewChat && (
          <IconButton id="recent-new-chat" label={t('conversations.add')} onClick={onNewChat}>
            <Plus aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {!!recent.length && (
        <nav aria-label={t('conversations.recentList')}>
          {renderRows(canExpand ? recent.slice(0, limit) : recent, 'recent')}
          {canExpand && (
            <>
              {/* Keep the toggle before the revealed rows so Tab leads into them. */}
              <button
                id={expandId}
                type="button"
                className="text-button recent-toggle"
                aria-expanded={expanded}
                aria-controls={overflowId}
                onClick={() => setExpanded((current) => !current)}
              >
                {t(expanded ? 'common.collapse' : 'conversations.showMore')}
              </button>
              <div id={overflowId} hidden={!expanded}>
                {expanded && renderRows(recent.slice(limit), 'overflow')}
              </div>
            </>
          )}
        </nav>
      )}
      {!!archived.length && (
        <section aria-label={t('conversations.archived')}>
          <details open={needle ? true : undefined}>
            <summary id={archiveId} className="recent-archive">
              {t('conversations.archived')}
            </summary>
            {renderRows(archived, 'archived')}
          </details>
        </section>
      )}
      {menu && onTrash && (
        <SidebarMenu
          label={t('conversations.actions', { 0: menu.title })}
          anchor={menu.anchor}
          focusId={menu.focusId}
          onClose={closeMenu}
          items={[
            {
              id: 'trash',
              kind: 'action',
              label: t('trash.move'),
              icon: <Trash2 />,
              onSelect: () => onTrash(menu.bot, menu.revision, menu.title),
            },
          ]}
        />
      )}
    </section>
  );
}
