import { agentTask } from '@daban/protocol';
import { MessageSquare, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { type Dispatch, useCallback, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { type SidebarAnchor, SidebarMenu } from '../../app/SidebarMenu';
import { type Action, chatRevision, type State } from '../../app/state';
import { WindowList } from '../../components/collection/WindowList';
import { IconButton } from '../../components/controls/Button';
import { t } from '../../i18n/locale';
import { conversationKey, recentConversations } from './conversations';
import './conversations.css';

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
      {!!rows.length && (
        <nav aria-label={t('conversations.recentList')}>
          <WindowList
            scope={`conversations:${query}`}
            items={rows}
            estimate={58}
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
              const selected =
                state.view === 'chat' &&
                state.selected === row.bot &&
                chatRevision(state, row.bot, runtime.snapshot.chats) === row.revision;
              const focusId = `conversation-menu-${conversationKey(row.bot, row.revision)}`;
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
                    type="button"
                    className="recent-conversation"
                    aria-current={selected ? 'page' : undefined}
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
                            if (
                              event.key === 'ContextMenu' ||
                              (event.shiftKey && event.key === 'F10')
                            ) {
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
                    <MessageSquare aria-hidden="true" />
                    <span className="recent-conversation-copy">
                      <span className="recent-conversation-title">{row.title}</span>
                      {(bot.kind !== 'chat' || active) && (
                        <span className="recent-conversation-detail">
                          {bot.kind !== 'chat' && bot.name}
                          {bot.kind !== 'chat' && active && ' · '}
                          {active &&
                            t(
                              task.phase === 'waiting'
                                ? 'common.awaitingConfirmation'
                                : 'common.processingMessage',
                            )}
                        </span>
                      )}
                    </span>
                  </button>
                  {onTrash && (
                    <IconButton
                      id={focusId}
                      className="recent-menu"
                      label={t('conversations.actions', { 0: row.title })}
                      aria-haspopup="menu"
                      aria-expanded={menu?.bot === row.bot && menu.revision === row.revision}
                      onClick={(event) => openMenu(event.currentTarget)}
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </IconButton>
                  )}
                </div>
              );
            }}
          />
        </nav>
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
