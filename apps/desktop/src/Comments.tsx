import type { WorkAuthor, WorkItem } from '@daban/protocol';
import { RefreshCw } from 'lucide-react';
import { type Dispatch, Fragment } from 'react';
import { commentCard } from './comments-state';
import { useComments } from './discussion';
import { useRuntime } from './Runtime';
import type { Action, State } from './state';

const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
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
        <div className="comment-loading" role="status" aria-label="正在读取讨论">
          <span />
          <span />
        </div>
      )}
      {!!discussion.rows.length && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded history needs a keyboard scrolling target.
        <section className="comment-history" aria-label="任务讨论记录" tabIndex={0}>
          <ol>
            {discussion.rows.map((comment) => (
              <li key={comment.id}>
                <div className="comment-meta">
                  <strong>{author(comment.createdBy)}</strong>
                  <time dateTime={comment.createdAt}>{time(comment.createdAt)}</time>
                </div>
                <p>{comment.body}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
      {discussion.available &&
        discussion.loaded &&
        !discussion.listError &&
        !discussion.rows.length && <p className="comment-empty">还没有讨论</p>}
      {discussion.next !== undefined && (
        <button
          type="button"
          className="text-button"
          disabled={discussion.loading}
          onClick={() => discussion.load(true).catch(() => {})}
        >
          加载更早的评论
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
        评论正文
        <textarea
          className="field"
          rows={3}
          maxLength={10000}
          value={body}
          readOnly={sealed}
          placeholder="补充信息或记录进展…"
          onChange={(event) => discussion.change(event.target.value)}
        />
      </label>
      {body.length >= 9000 && (
        <p className="field-help">{body.length.toLocaleString()} / 10,000 字符</p>
      )}
      {item.deleted && (
        <p role="status" className="field-help">
          任务在回收站，讨论仍保留。恢复后可继续发表评论。
        </p>
      )}
      {discussion.blocked && (
        <p role="status" className="field-help">
          运行环境正在恢复，可以编辑正文和核对结果，恢复完成后再发表。
        </p>
      )}
      {discussion.busyParent && (
        <p role="status" className="field-help">
          请先核对这张任务的保存结果，再发表评论。
        </p>
      )}
      {card.pending && (
        <div className="comment-pending" role="status">
          <strong>{discussion.working ? '正在发表评论…' : '评论结果待确认'}</strong>
          <p>正文和原评论请求已保留。重开只核对结果，不会重复发表。</p>
          <div className="task-actions">
            <button
              type="button"
              className="secondary"
              disabled={!discussion.available || discussion.checking || discussion.working}
              onClick={() => discussion.check().catch(() => {})}
            >
              {discussion.checking ? '正在核对…' : '核对发表结果'}
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
              重试同一条评论
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
            {discussion.working && !card.pending ? '正在核对任务…' : '发表评论'}
          </button>
        </div>
      )}
    </form>
  );
  return (
    <section
      id={`task-comments-${item.id}`}
      className="task-discussion"
      aria-label="任务讨论"
      tabIndex={-1}
    >
      <div className="comment-heading">
        <h3>讨论 · {item.title}</h3>
        <button
          type="button"
          className="text-button"
          disabled={!discussion.available || discussion.loading}
          onClick={() => discussion.load().catch(() => {})}
          aria-label="刷新讨论"
        >
          <RefreshCw aria-hidden="true" />
          {discussion.loading ? '正在读取…' : '刷新'}
        </button>
      </div>
      <p className="field-help">与所有 Bot 共享。发表评论不会启动任务。</p>
      {!discussion.available && (
        <p role="status" className="field-help">
          {runtime.enabled && runtime.snapshot.protocolVersion < 38
            ? '更新运行环境后可以读取和发表评论。本机正文仍会保留。'
            : '暂未连接讨论服务。本机正文仍会保留，连接后可继续。'}
        </p>
      )}
      {state.comments?.damaged && (
        <p role="alert" className="form-error">
          部分本机评论记录无法读取，其他正文仍保留。没有重新发表，请核对讨论内容。
        </p>
      )}
      {!card.pending && history}
      {composer}
      {card.pending && history}
    </section>
  );
}
