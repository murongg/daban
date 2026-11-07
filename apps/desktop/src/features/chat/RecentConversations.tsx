import { agentTask } from '@daban/protocol';
import { MessageSquare } from 'lucide-react';
import type { Dispatch } from 'react';
import { useRuntime } from '../../app/Runtime';
import { type Action, chatRevision, type State } from '../../app/state';
import { WindowList } from '../../components/collection/WindowList';
import { t } from '../../i18n/locale';
import { conversationKey, recentConversations } from './conversations';
import './conversations.css';

export function RecentConversations({
  state,
  dispatch,
  query,
  close,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  query: string;
  close: () => unknown;
}) {
  const runtime = useRuntime();
  if (runtime.enabled && runtime.snapshot.protocolVersion < 46) return null;
  const needle = query.trim().toLowerCase();
  const rows = recentConversations(state, runtime.snapshot.chats).filter((row) => {
    const bot = state.bots.find((bot) => bot.id === row.bot);
    return !needle || `${row.title} ${bot?.name ?? ''}`.toLowerCase().includes(needle);
  });
  if (!rows.length) return null;
  return (
    <section className="recent-conversations" aria-label={t('conversations.recent')}>
      <div className="section-label">
        <span>{t('conversations.recent')}</span>
      </div>
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
            return (
              <button
                type="button"
                className={`recent-conversation ${selected ? 'selected' : ''}`}
                aria-current={selected ? 'page' : undefined}
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
            );
          }}
        />
      </nav>
    </section>
  );
}
