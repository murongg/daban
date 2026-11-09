import type { WorkAuthor, WorkItem } from '@daban/protocol';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { type Dispatch, Fragment } from 'react';
import { useRuntime } from '../../app/Runtime';
import type { Action, State } from '../../app/state';
import { WindowList } from '../../components/collection/WindowList';
import { IconButton } from '../../components/controls/Button';
import { getLocale, t, useLocale } from '../../i18n/locale';
import { commentCard } from './comments-state';
import { useComments } from './discussion';

const time = (value: string) =>
  new Date(value).toLocaleString(getLocale(), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export function Comments({
  state,
  dispatch,
  item,
  observe,
  author,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  item: WorkItem;
  observe: (item: WorkItem) => unknown;
  author: (who: WorkAuthor) => string;
}) {
  useLocale();
  const discussion = useComments(state, dispatch, item, observe),
    runtime = useRuntime();
  const card = commentCard(state.comments, item.id),
    body = card.pending?.draft.body ?? card.draft?.body ?? '';
  const sealed = !!card.pending || discussion.working;
  const disabled =
    !discussion.available ||
    discussion.blocked ||
    discussion.busyParent ||
    sealed ||
    item.deleted ||
    !body.trim() ||
    body.length > 10000 ||
    body.includes('\0');
  const history = (
    <Fragment key="history">
      {discussion.listError && (
        <p role="alert" className="form-error">
          {discussion.listError}
        </p>
      )}
      {discussion.available && !discussion.loaded && discussion.loading && (
        <div className="comment-loading" role="status" aria-label={t('comments.readingDiscussion')}>
          <span />
          <span />
        </div>
      )}
      {!!discussion.rows.length && (
        <section
          className="comment-history"
          aria-label={t('comments.taskDiscussionHistory')}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded history needs a keyboard scrolling target.
          tabIndex={0}
        >
          <WindowList
            tag="ol"
            scope={item.id}
            items={discussion.rows}
            getKey={(comment) => comment.id}
            renderItem={(comment) => (
              <li key={comment.id}>
                <div className="comment-meta">
                  <strong className="comment-author">{author(comment.createdBy)}</strong>
                  <time dateTime={comment.createdAt}>{time(comment.createdAt)}</time>
                </div>
                <p>{comment.body}</p>
              </li>
            )}
          />
        </section>
      )}
      {discussion.available &&
        discussion.loaded &&
        !discussion.listError &&
        !discussion.rows.length && <p className="comment-empty">{t('comments.noDiscussionYet')}</p>}
      {discussion.next !== undefined && (
        <button
          type="button"
          className="text-button"
          disabled={discussion.loading}
          onClick={() => discussion.load(true).catch(() => {})}
        >
          {t('comments.loadEarlierComments')}
        </button>
      )}
    </Fragment>
  );
  const composer = (
    <form
      key="composer"
      className="comment-composer"
      onSubmit={(event) => {
        event.preventDefault();
        discussion.publish().catch(() => {});
      }}
    >
      <label className="field-label">
        {t('comments.commentBody')}
        <textarea
          className="field"
          rows={3}
          maxLength={10000}
          value={body}
          readOnly={sealed}
          placeholder={t('comments.addDetailsProgress')}
          onChange={(event) => discussion.change(event.target.value)}
        />
      </label>
      {body.length >= 9000 && (
        <p className="field-help">
          {t('comments.characterCount', { 0: body.length.toLocaleString(getLocale()) })}
        </p>
      )}
      {item.deleted && (
        <p role="status" className="field-help">
          {t('comments.taskTrashDiscussionRetainedRestorePostMore')}
        </p>
      )}
      {discussion.blocked && (
        <p role="status" className="field-help">
          {t('comments.runtimeRecoveringCanEditTextVerifyResults')}
        </p>
      )}
      {discussion.busyParent && (
        <p role="status" className="field-help">
          {t('comments.verifyTaskSSaveResultPostingComment')}
        </p>
      )}
      {card.pending && (
        <div className="comment-pending" role="status">
          <strong>
            {discussion.working
              ? t('comments.postingComment')
              : t('comments.commentResultAwaitingConfirmation')}
          </strong>
          <p>{t('comments.textOriginalCommentRequestRetainedReopeningOnly')}</p>
          <div className="task-actions">
            <button
              type="button"
              className="secondary"
              disabled={!discussion.available || discussion.checking || discussion.working}
              onClick={() => discussion.check().catch(() => {})}
            >
              {discussion.checking ? t('common.verifying') : t('comments.verifyCommentResult')}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={
                !discussion.available ||
                discussion.blocked ||
                discussion.busyParent ||
                discussion.working
              }
              onClick={() => discussion.retry().catch(() => {})}
            >
              {t('comments.retrySameComment')}
            </button>
          </div>
        </div>
      )}
      {discussion.error && (
        <p role="alert" className="form-error">
          {discussion.error}
        </p>
      )}
      {discussion.status && (
        <p role="status" className="field-help">
          {discussion.status}
        </p>
      )}
      {!card.pending && (
        <div className="task-actions">
          <button type="submit" className="primary" disabled={disabled}>
            {discussion.working && !card.pending
              ? t('comments.verifyingTask')
              : t('comments.postComment')}
          </button>
        </div>
      )}
    </form>
  );
  return (
    <section
      id={`task-comments-${item.id}`}
      className="task-discussion"
      aria-label={t('comments.taskDiscussion')}
      tabIndex={-1}
    >
      <div className="comment-heading">
        <h3>{t('comments.discussionTitle', { 0: item.title })}</h3>
        <IconButton
          label={t('comments.refreshDiscussion')}
          aria-busy={discussion.loading}
          disabled={!discussion.available || discussion.loading}
          onClick={() => discussion.load().catch(() => {})}
        >
          {discussion.loading ? <LoaderCircle className="setup-spinner" /> : <RefreshCw />}
        </IconButton>
      </div>
      <p className="field-help">{t('comments.sharedAllBotsPostingCommentDoesNot')}</p>
      {!discussion.available && (
        <p role="status" className="field-help">
          {runtime.enabled && runtime.snapshot.protocolVersion < 38
            ? t('comments.updateRuntimeReadPostCommentsLocalText')
            : t('comments.discussionServiceNotConnectedLocalTextRetained')}
        </p>
      )}
      {state.comments?.damaged && (
        <p role="alert" className="form-error">
          {t('comments.someLocalCommentRecordsUnreadableOtherText')}
        </p>
      )}
      {!card.pending && history}
      {composer}
      {card.pending && history}
    </section>
  );
}
