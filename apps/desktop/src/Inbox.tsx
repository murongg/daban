import { Check, FileText, Inbox as InboxIcon, Monitor, X } from 'lucide-react';
import { type Dispatch, useState } from 'react';
import { Avatar } from './Avatar';
import { t, useLocale } from './locale';
import { Requests } from './Requests';
import { useRuntime } from './Runtime';
import type { Action, State, WorkspaceFile } from './state';

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
            <p>{t('已定位桌面提醒对应的请求。')}</p>
            <button className="secondary" type="button" onClick={clearFocus}>
              {t('查看全部')}
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
    <section className="full-page" aria-label={t('收件箱')}>
      <div className="page-inner">
        <h2 className="page-heading">{t('需要你看一眼')}</h2>
        <p className="page-subtitle">{t('确认、补充，或接手一步。让 Bot 知道接下来怎么做。')}</p>
        <div className="filter-tabs" role="tablist" aria-label={t('收件箱筛选')}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'pending'}
            onClick={() => setFilter('pending')}
          >
            {t('待处理')}
            {pending.length > 0 && `· ${pending.length}`}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'done'}
            onClick={() => setFilter('done')}
          >
            {t('已处理')}
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
                <span>{t('示例请求')}</span>
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
                          notify(t('已进入接管状态（演示）'));
                        }}
                      >
                        <Monitor />
                        {t('前往接管')}
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          dispatch({ type: 'approval', id: approval.id, status: 'approved' })
                        }
                      >
                        {t('标为已处理')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          dispatch({ type: 'approval', id: approval.id, status: 'approved' });
                          notify(t('已记录确认（演示），不会写入外部文件'));
                        }}
                      >
                        <Check />
                        {t('确认草稿')}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          const file = state.files.find((f) => f.id === approval.file);
                          if (file) preview(file);
                        }}
                      >
                        {t('查看文件')}
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          dispatch({ type: 'approval', id: approval.id, status: 'rejected' });
                          notify(t('已记录退回（演示）'));
                        }}
                      >
                        {t('退回修改')}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="approval-actions">
                  <span className="approval-state">
                    {approval.status === 'approved' ? <Check /> : <X />}
                    {approval.status === 'approved' ? t('已处理') : t('已退回修改')}
                    {t('· 仅记录于本机')}
                  </span>
                </div>
              )}
            </article>
          );
        })}
        {!entries.length && (
          <div className="empty-panel">
            <InboxIcon />
            <h3>{filter === 'pending' ? t('暂时没有需要确认的事') : t('还没有处理记录')}</h3>
            <p>
              {filter === 'pending'
                ? t('需要你接手或确认时，会集中显示在这里。')
                : t('处理后的请求会保留在这里，方便回看。')}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
