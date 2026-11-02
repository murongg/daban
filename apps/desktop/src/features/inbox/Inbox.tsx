import { Check, FileText, Inbox as InboxIcon, Monitor, X } from 'lucide-react';
import { type Dispatch, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import type { Action, State, WorkspaceFile } from '../../app/state';
import { t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';
import { Requests } from '../requests/Requests';

export function Inbox({
  state,
  dispatch,
  preview,
  notify,
  focus,
  clearFocus,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  preview: (file: WorkspaceFile) => unknown;
  notify: (text: string) => unknown;
  focus?: string;
  clearFocus?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const [filter, setFilter] = useState<'pending' | 'done'>('pending');
  if (runtime.enabled)
    return (
      <>
        {focus && (
          <div className="archive-banner">
            <p>{t('inbox.openedRequestLinkedDesktopNotification')}</p>
            <button className="secondary" type="button" onClick={clearFocus}>
              {t('inbox.viewAll')}
            </button>
          </div>
        )}
        <Requests state={state} dispatch={dispatch} notify={notify} focus={focus} />
      </>
    );
  const pending = state.approvals.filter((a) => a.status === 'pending');
  const entries = state.approvals.filter((a) =>
    filter === 'pending' ? a.status === 'pending' : a.status !== 'pending',
  );
  return (
    <section className="full-page" aria-label={t('common.inbox')}>
      <div className="page-inner">
        <h2 className="page-heading">{t('common.needsAttention')}</h2>
        <p className="page-subtitle">{t('inbox.confirmClarifyTakeOverStepLetBot')}</p>
        <div className="filter-tabs" role="tablist" aria-label={t('common.inboxFilter')}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'pending'}
            onClick={() => setFilter('pending')}
          >
            {t('common.do')}
            {pending.length > 0 && `· ${pending.length}`}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'done'}
            onClick={() => setFilter('done')}
          >
            {t('common.handled')}
          </button>
        </div>
        {entries.map((approval) => {
          const bot = state.bots.find((b) => b.id === approval.bot);
          if (!bot) return null;
          return (
            <article className="approval" key={approval.id}>
              <div className="approval-author">
                <Avatar bot={bot} size="small" />
                <span>{bot.name}</span>
                <span className="spacer" />
                <span>{t('inbox.exampleRequest')}</span>
              </div>
              <h3 className="approval-title">{approval.title}</h3>
              <p className="approval-description">{approval.description}</p>
              <div className="approval-detail">
                {approval.handoff ? <Monitor /> : <FileText />}
                {approval.detail}
              </div>
              {approval.status === 'pending' ? (
                <div className="approval-actions">
                  {approval.handoff ? (
                    <>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          dispatch({ type: 'select', bot: bot.id });
                          dispatch({ type: 'panel', panel: 'computer' });
                          dispatch({ type: 'control', bot: bot.id, owner: 'human' });
                          notify(t('inbox.takeoverEnabledDemo'));
                        }}
                      >
                        <Monitor />
                        {t('inbox.takeOver')}
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          dispatch({ type: 'approval', id: approval.id, status: 'approved' })
                        }
                      >
                        {t('inbox.markHandled')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          dispatch({ type: 'approval', id: approval.id, status: 'approved' });
                          notify(t('inbox.confirmationRecordedDemoNoExternalFilesWritten'));
                        }}
                      >
                        <Check />
                        {t('inbox.confirmDraft')}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          const file = state.files.find((f) => f.id === approval.file);
                          if (file) preview(file);
                        }}
                      >
                        {t('common.viewFiles')}
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          dispatch({ type: 'approval', id: approval.id, status: 'rejected' });
                          notify(t('inbox.revisionRequestRecordedDemo'));
                        }}
                      >
                        {t('inbox.requestRevision')}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="approval-actions">
                  <span className="approval-state">
                    {approval.status === 'approved' ? <Check /> : <X />}
                    {approval.status === 'approved'
                      ? t('common.handled')
                      : t('inbox.returnedRevision')}
                    {t('inbox.recordedLocallyOnly')}
                  </span>
                </div>
              )}
            </article>
          );
        })}
        {!entries.length && (
          <div className="empty-panel">
            <InboxIcon />
            <h3>
              {filter === 'pending'
                ? t('common.nothingNeedsAttentionRightNow')
                : t('common.noHandledRequestsYet')}
            </h3>
            <p>
              {filter === 'pending'
                ? t('inbox.requestsNeedingTakeoverConfirmationAppearHere')
                : t('inbox.handledRequestsStayHereLaterReview')}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
