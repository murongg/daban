import { agentId } from '@daban/protocol';
import { RotateCcw } from 'lucide-react';
import { useRuntime } from '../../app/Runtime';
import type { State } from '../../app/state';
import { WindowList } from '../../components/collection/WindowList';
import { Dialog } from '../../components/controls/Dialog';
import { t } from '../../i18n/locale';
import { conversationKey, conversationPending, conversationState } from './conversations';
import type { TrashController } from './useTrash';

export function TrashList({
  state,
  trash,
  onLifecycle,
}: {
  state: State;
  trash: TrashController;
  onLifecycle?: (bot: string) => unknown;
}) {
  const runtime = useRuntime();
  const entries = new Map<
    string,
    { bot: string; revision: number; title: string; updatedAt: string }
  >();
  for (const bot of state.bots.filter((bot) => !bot.members)) {
    const scopes = [
      ...Object.values(state.conversationStates ?? {}),
      ...(runtime.snapshot.chats?.lifecycle ?? []),
    ];
    for (const scope of scopes) {
      if (
        scope.bot !== agentId(bot.id) ||
        !conversationState(state, bot.id, scope.revision, runtime.snapshot.chats)?.trashed
      )
        continue;
      entries.set(conversationKey(bot.id, scope.revision), {
        bot: bot.id,
        revision: scope.revision,
        title: conversationState(state, bot.id, scope.revision, runtime.snapshot.chats)!.title,
        updatedAt: scope.updatedAt,
      });
    }
    for (const request of Object.values(state.conversationRequests ?? {})) {
      if (request.bot === agentId(bot.id))
        entries.set(conversationKey(bot.id, request.revision), {
          bot: bot.id,
          revision: request.revision,
          title: request.title,
          updatedAt: '',
        });
    }
  }
  const rows = [...entries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="settings-section">
      <div className="settings-group">
        <p className="inline-note">{t('trash.retention')}</p>
        {!trash.available && (
          <p className="inline-note" role="status">
            {t('trash.unavailable')}
          </p>
        )}
        {!rows.length && trash.available && <p className="inline-note">{t('trash.empty')}</p>}
        <WindowList
          scope="conversation-trash"
          items={rows}
          estimate={92}
          getKey={(row) => conversationKey(row.bot, row.revision)}
          renderItem={(row) => {
            const bot = state.bots.find((bot) => bot.id === row.bot)!;
            const pending = conversationPending(state, row.bot, row.revision);
            return (
              <div className="setting-row archive-row">
                <div className="archive-copy">
                  <div className="setting-label">{row.title || t('conversations.untitled')}</div>
                  <p className="setting-description">
                    {bot.name}
                    {pending ? ` · ${t('trash.pending')}` : ''}
                  </p>
                </div>
                {pending ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={trash.busy || !trash.available}
                    onClick={() => trash.verify(row.bot, row.revision)}
                  >
                    {t('common.verifyOperationResult')}
                  </button>
                ) : bot.archived ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => onLifecycle?.(bot.id)}
                    disabled={!onLifecycle}
                  >
                    {t('common.restoreBot')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    disabled={trash.busy || !trash.available}
                    onClick={() => trash.restore(row.bot, row.revision, row.title)}
                  >
                    <RotateCcw aria-hidden="true" />
                    {t('trash.restore')}
                  </button>
                )}
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}
export function TrashProblem({
  state,
  trash,
  onTask,
  onLifecycle,
}: {
  state: State;
  trash: TrashController;
  onTask: (bot: string, revision: number) => unknown;
  onLifecycle: (bot: string) => unknown;
}) {
  const issue = trash.issue;
  if (!issue) return null;
  const pending = conversationPending(state, issue.bot, issue.revision);
  return (
    <Dialog title={t('trash.title')} onClose={trash.close}>
      <p className="setting-label">{issue.title}</p>
      <p className="form-error" role="alert">
        {issue.error}
      </p>
      {pending && <p className="inline-note">{t('trash.pending')}</p>}
      <div className="dialog-actions">
        <button type="button" className="text-button" onClick={trash.close}>
          {t('common.close')}
        </button>
        {issue.task ? (
          <button
            type="button"
            className="primary"
            onClick={() => {
              trash.close();
              onTask(issue.bot, issue.revision);
            }}
          >
            {t('trash.viewTask')}
          </button>
        ) : issue.archived ? (
          <button
            type="button"
            className="primary"
            onClick={() => {
              trash.close();
              onLifecycle(issue.bot);
            }}
          >
            {t('common.restoreBot')}
          </button>
        ) : (
          <>
            {pending && (
              <button
                type="button"
                className="secondary"
                disabled={trash.busy || !trash.available}
                onClick={() => trash.verify(issue.bot, issue.revision)}
              >
                {t('common.verifyOperationResult')}
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={trash.busy || !trash.available}
              onClick={trash.retry}
            >
              {trash.busy
                ? t('common.processing')
                : pending
                  ? t('common.retrySameOperation')
                  : t('trash.retry')}
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
