import {
  agentId,
  legacyWorkStates,
  type WorkFields,
  type WorkSummary,
  workStates,
} from '@daban/protocol';
import { Columns3, List, MessageSquare, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { type Dispatch, useState } from 'react';
import { Comments } from './Comments';
import { commentCard } from './comments-state';
import { getLocale, t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';
import { Select } from './Select';
import type { Action, State } from './state';
import { Tooltip } from './Tooltip';
import type { WorkController } from './work';
import { workDirty, workInitial } from './work-state';

const states = {
  todo: '待处理',
  doing: '进行中',
  review: '待审核',
  blocked: '受阻',
  done: '已完成',
  closed: '已关闭',
};
const filters = { all: '全部', open: '未完成', done: '已完成', trash: '回收站' } as const;
const time = (value: string) =>
  new Date(value).toLocaleString(getLocale(), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export function Tasks({
  state,
  dispatch,
  work,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  work: WorkController;
}) {
  useLocale();
  const runtime = useRuntime();
  const visibleStates = runtime.snapshot.protocolVersion >= 39 ? workStates : legacyWorkStates;
  const cache = state.work ?? workInitial(),
    draft = cache.draft;
  const board = cache.mode === 'board' && cache.filter !== 'trash';
  const [confirm, setConfirm] = useState<{ key: string; id: string; revision: number }>();
  // A saved revision change invalidates consent, including a trash/restore round trip.
  const confirming =
    !!draft?.base &&
    confirm?.key === draft.key &&
    confirm.id === draft.base.id &&
    confirm.revision === draft.base.revision;
  const pending = cache.pending,
    sealed = !!draft && pending?.draft.key === draft.key;
  const commentPending = !!draft?.base && !!commentCard(state.comments, draft.base.id).pending;
  const readOnly = !work.available || sealed || work.reading;
  const hasEditor = work.editorVisible && (!!draft || work.reading);
  const latest = work.latest?.key === draft?.key ? work.latest?.item : undefined;
  const formId = draft ? `shared-work-${draft.key}` : undefined;
  const saveDisabled =
    readOnly ||
    work.blocked ||
    !!pending ||
    commentPending ||
    !workDirty(draft) ||
    !!draft?.base?.deleted ||
    !!latest;
  const author = (who: WorkSummary['updatedBy']) =>
    who.kind === 'human'
      ? t('你')
      : (state.bots.find((bot) => agentId(bot.id) === who.bot)?.name ?? `Bot ${who.bot}`);
  const mutate = (patch: Partial<WorkFields>) => {
    if (draft) dispatch({ type: 'work-change', key: draft.key, patch });
  };
  const latestText = latest && (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded text region needs keyboard scrolling.
    <section className="task-latest-text" tabIndex={0} aria-label={t('后台说明和进展')}>
      <p>{latest.description || t('没有说明')}</p>
      <p>{latest.progress || t('没有进展记录')}</p>
    </section>
  );
  function card(item: WorkSummary) {
    return (
      <li key={item.id}>
        <button
          type="button"
          className={`task-card ${draft?.base?.id === item.id ? 'selected' : ''}`}
          aria-label={t('查看 {0}', { 0: item.title })}
          aria-current={draft?.base?.id === item.id ? 'true' : undefined}
          onClick={() => {
            setConfirm(undefined);
            work.open(item.id).catch(() => {});
          }}
        >
          <span className="task-card-heading">
            <span className="task-title">{item.title}</span>
            <span className={`task-state ${item.status}`}>{t(states[item.status])}</span>
          </span>
          {item.progress && (
            <span className="task-preview">
              {item.progress}
              {item.progressTruncated ? '…' : ''}
            </span>
          )}
          <span className="task-meta">
            {author(item.updatedBy)}
            {t('更新 ·')} <time dateTime={item.updatedAt}>{time(item.updatedAt)}</time>
          </span>
        </button>
      </li>
    );
  }
  return (
    <section className="tasks" aria-label={t('共享任务')}>
      <div className="tasks-top">
        <div className="tasks-intro">
          <p>{t('和所有 Bot 共用一份待办。保存任务不会自动执行。')}</p>
          <button
            type="button"
            className="primary"
            disabled={!work.available}
            onClick={() => {
              setConfirm(undefined);
              work.fresh();
            }}
          >
            <Plus aria-hidden="true" />
            {t('新建任务')}
          </button>
        </div>
        <div className="task-toolbar">
          <label className="task-search">
            <Search aria-hidden="true" />
            <span className="sr-only">{t('搜索任务')}</span>
            <input
              type="search"
              placeholder={t('搜索任务')}
              maxLength={200}
              value={cache.text}
              onChange={(event) =>
                dispatch({ type: 'work-options', patch: { text: event.target.value } })
              }
            />
          </label>
          <fieldset className="task-filters" aria-label={t('任务筛选')}>
            {Object.entries(filters).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={cache.filter === value}
                onClick={() =>
                  dispatch({
                    type: 'work-options',
                    patch: { filter: value as keyof typeof filters },
                  })
                }
              >
                {t(label)}
              </button>
            ))}
          </fieldset>
          <fieldset className="task-layout-switch" aria-label={t('任务布局')}>
            <button
              type="button"
              aria-label={t('列表')}
              aria-pressed={!board}
              onClick={() => dispatch({ type: 'work-options', patch: { mode: 'list' } })}
            >
              <List aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t('看板')}
              aria-pressed={board}
              disabled={cache.filter === 'trash'}
              onClick={() => dispatch({ type: 'work-options', patch: { mode: 'board' } })}
            >
              <Columns3 aria-hidden="true" />
            </button>
          </fieldset>
          <button
            type="button"
            className="text-button"
            disabled={!work.available || work.loading}
            onClick={() => work.load().catch(() => {})}
          >
            <RefreshCw aria-hidden="true" />
            {t('刷新')}
          </button>
        </div>
        {cache.damaged && (
          <p role="alert" className="form-error">
            {t('部分本机任务记录损坏，其他聊天和草稿已保留。没有重发操作，请核对任务列表。')}
          </p>
        )}
        {work.blocked && (
          <p role="status" className="field-help">
            {t('运行环境正在恢复，仍可查看和核对任务；完成恢复后再保存。')}
          </p>
        )}
        {pending && (
          <div className="work-pending" role="status">
            <strong>
              {work.working ? t('正在确认操作') : t('操作结果待确认')} ·{' '}
              {pending.draft.title || pending.draft.base?.title}
            </strong>
            <p>{t('原请求已保留。重开只核对结果，不会重新保存或启动任务。')}</p>
            {work.operationError && (
              <p className="form-error" role="alert">
                {work.operationError}
              </p>
            )}
            <div className="task-actions">
              <button
                type="button"
                className="secondary"
                disabled={!work.available || work.checking}
                onClick={() => work.check().catch(() => {})}
              >
                {work.checking ? t('正在核对…') : t('核对操作结果')}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!work.available || work.blocked || work.working}
                onClick={() => work.retry().catch(() => {})}
              >
                {t('重试同一次操作')}
              </button>
            </div>
          </div>
        )}
        {work.listError && (
          <p role="alert" className="form-error">
            {work.listError}
          </p>
        )}
        {work.changed && (
          <div className="task-updated" role="status">
            {t('任务有新更改，当前编辑仍保留。')}
            <button
              type="button"
              className="text-button"
              disabled={work.loading}
              onClick={() => work.load().catch(() => {})}
            >
              {t('刷新列表')}
            </button>
          </div>
        )}
        {draft && !work.editorVisible && (
          <button type="button" className="text-button" onClick={() => work.setEditorVisible(true)}>
            {t('继续编辑')}
            {draft.title ? `「${draft.title}」` : t('任务草稿')}
          </button>
        )}
      </div>
      <div className={`work-layout ${hasEditor ? 'has-editor' : ''}`}>
        <div className="work-collection">
          {!work.available ? (
            <div className="task-empty">
              <h2>
                {runtime.enabled &&
                runtime.snapshot.protocolVersion > 0 &&
                runtime.snapshot.protocolVersion < 36
                  ? t('需要更新运行环境')
                  : t('任务暂不可用')}
              </h2>
              <p>
                {!runtime.enabled || runtime.snapshot.phase !== 'ready'
                  ? t('连接本地运行环境后，可以查看共享任务。本机任务草稿仍保留。')
                  : runtime.snapshot.protocolVersion < 36
                    ? t('更新运行环境后使用共享任务；已有聊天和本机任务草稿仍保留。')
                    : runtimeError(new Error(runtime.snapshot.work?.error ?? 'WORK_UNAVAILABLE'))}
              </p>
            </div>
          ) : work.loading && !work.items.length ? (
            <div className="task-loading" role="status" aria-label={t('正在读取任务')}>
              <span />
              <span />
              <span />
            </div>
          ) : work.listError && !work.items.length ? (
            <div className="task-empty">
              <h2>{t('任务列表尚未读取')}</h2>
              <p>{t('请刷新重试。本机草稿仍保留，读取失败不代表没有任务。')}</p>
            </div>
          ) : !work.items.length ? (
            <div className="task-empty">
              <h2>
                {cache.text
                  ? t('没有找到匹配的任务')
                  : cache.filter === 'trash'
                    ? t('回收站是空的')
                    : t('这里还没有任务')}
              </h2>
              <p>
                {cache.text
                  ? t('试试其他关键词，或切换筛选查看。')
                  : cache.filter === 'trash'
                    ? t('移入回收站的任务可以在这里恢复。')
                    : t('把需要跟进的事情记下来，之后可在对话中让 Bot 处理。')}
              </p>
            </div>
          ) : (
            <>
              <p className="task-count">
                {t('已载入')}
                {work.items.length}
                {t('项')}
                {work.next !== undefined ? t(' · 还有更多任务') : ''}
              </p>
              {board ? (
                <div className="task-board">
                  {visibleStates.map((status) => (
                    <section key={status} aria-label={t(states[status])} className="task-column">
                      <h2>
                        {t(states[status])}
                        <span>{work.items.filter((row) => row.status === status).length}</span>
                      </h2>
                      <ul>{work.items.filter((row) => row.status === status).map(card)}</ul>
                      {!work.items.some((row) => row.status === status) && (
                        <p className="field-help">{t('暂无已载入任务')}</p>
                      )}
                    </section>
                  ))}
                </div>
              ) : (
                <ul className="task-list">{work.items.map(card)}</ul>
              )}
              {work.next !== undefined && (
                <button
                  type="button"
                  className="secondary task-more"
                  disabled={work.loading}
                  onClick={() => work.load(true).catch(() => {})}
                >
                  {work.loading ? t('正在读取…') : t('加载更多任务')}
                </button>
              )}
            </>
          )}
        </div>
        {hasEditor && (
          <aside className="task-editor" aria-label={t('任务详情')}>
            <div className="task-editor-heading">
              <h2>{draft?.base ? t('任务详情') : t('新建任务')}</h2>
              {draft?.base && !work.reading && (
                <Tooltip label={t('查看讨论')}>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('查看讨论')}
                    aria-controls={`task-comments-${draft.base.id}`}
                    onClick={() => {
                      const target = document.getElementById(`task-comments-${draft.base!.id}`);
                      target?.scrollIntoView({ block: 'start' });
                      target?.focus({ preventScroll: true });
                    }}
                  >
                    <MessageSquare aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
              {draft && (
                <button className="primary" type="submit" form={formId} disabled={saveDisabled}>
                  {t('保存任务')}
                </button>
              )}
              <button
                type="button"
                className="text-button"
                onClick={() => work.setEditorVisible(false)}
              >
                {t('返回任务列表')}
              </button>
            </div>
            {work.reading && (
              <p role="status" className="field-help">
                {t('正在读取任务…')}
              </p>
            )}
            {draft && (
              <>
                <p className="field-help">
                  {sealed
                    ? t('原操作正在核对，提交内容已锁定。')
                    : draft.base?.deleted
                      ? t('任务在回收站。恢复会保留当前草稿，之后再保存修改。')
                      : workDirty(draft)
                        ? t('有未保存的修改，离开此页仍会保留。')
                        : draft.base
                          ? t('已保存到当前运行环境。')
                          : t('新任务草稿，填写后保存到运行环境。')}
                </p>
                {commentPending && (
                  <p role="status" className="field-help">
                    {t('这张任务的评论结果待确认。请先查看讨论并核对结果，再保存任务。')}
                  </p>
                )}
                {!work.available && (
                  <p className="field-help">
                    {t('当前只读显示本机草稿，连接后可继续编辑和保存。')}
                  </p>
                )}
                <form
                  id={formId}
                  onSubmit={(event) => {
                    event.preventDefault();
                    work.save().catch(() => {});
                  }}
                >
                  <label className="field-label">
                    {t('任务标题')}
                    <input
                      className="field"
                      required
                      maxLength={500}
                      value={draft.title}
                      readOnly={readOnly}
                      onChange={(event) => mutate({ title: event.target.value })}
                    />
                  </label>
                  <div className="field-label">
                    {t('任务状态')}
                    <Select
                      label={t('任务状态')}
                      value={draft.status}
                      disabled={readOnly}
                      onValueChange={(value) => mutate({ status: value as WorkFields['status'] })}
                      options={visibleStates.map((status) => ({
                        value: status,
                        label: t(states[status]),
                      }))}
                    />
                  </div>
                  <label className="field-label">
                    {t('任务说明')}
                    <textarea
                      className="field"
                      rows={5}
                      maxLength={4000}
                      value={draft.description}
                      readOnly={readOnly}
                      onChange={(event) => mutate({ description: event.target.value })}
                    />
                  </label>
                  <label className="field-label">
                    {t('最新进展')}
                    <textarea
                      className="field"
                      rows={4}
                      maxLength={4000}
                      value={draft.progress}
                      readOnly={readOnly}
                      onChange={(event) => mutate({ progress: event.target.value })}
                    />
                  </label>
                  <p className="field-help">
                    {t('标记完成只更新待办状态，不会代替实际执行或验证。')}
                  </p>
                  {work.error && (
                    <div className="task-error">
                      <p role="alert" className="form-error">
                        {work.error}
                      </p>
                      {draft.base && !pending && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={!work.available || work.reading}
                          onClick={() => work.open(draft.base!.id, true).catch(() => {})}
                        >
                          {t('核对最新版本')}
                        </button>
                      )}
                    </div>
                  )}
                  {latest && (
                    <div className="task-conflict">
                      <h3>{t('后台当前内容')}</h3>
                      <p>
                        {latest.title} · {t(states[latest.status])}
                        {latest.deleted ? t(' · 回收站') : ''}
                      </p>
                      <details>
                        <summary>{t('查看后台说明和进展')}</summary>
                        {latestText}
                      </details>
                      <p className="field-help">
                        {t('保留你的更改，并让未修改的字段跟随后台版本。核对后再保存。')}
                      </p>
                      <div className="task-actions">
                        <button
                          type="button"
                          className="secondary"
                          disabled={!!pending}
                          onClick={() => work.merge(true)}
                        >
                          {t('保留我的更改')}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={!!pending}
                          onClick={() => work.merge(false)}
                        >
                          {t('使用后台版本')}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="task-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={sealed || !workDirty(draft)}
                      onClick={() => {
                        setConfirm(undefined);
                        work.discard();
                      }}
                    >
                      {t('放弃修改')}
                    </button>
                  </div>
                </form>
                {draft.base && (
                  <div className="task-history">
                    <p className="task-meta">
                      {t('由')}
                      {author(draft.base.createdBy)}
                      {t('创建 · 最近由')}
                      {author(draft.base.updatedBy)}
                      {t('更新')}
                    </p>
                    <p className="task-meta">
                      <time dateTime={draft.base.updatedAt}>{time(draft.base.updatedAt)}</time>
                      {draft.base.completedAt
                        ? t(' · 完成于 {0}', { 0: time(draft.base.completedAt) })
                        : ''}
                    </p>
                    {draft.base.deleted ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={!work.available || work.blocked || !!pending || commentPending}
                        onClick={() => work.changeStatus('restore').catch(() => {})}
                      >
                        {t('恢复任务')}
                      </button>
                    ) : confirming ? (
                      <div className="task-confirm">
                        <p>
                          {t('将「')}
                          {draft.base.title}
                          {t('」移入回收站？内容会保留，可以恢复。')}
                        </p>
                        <div className="task-actions">
                          <button
                            type="button"
                            className="secondary"
                            disabled={!!pending || work.blocked || commentPending}
                            onClick={() => work.changeStatus('trash').catch(() => {})}
                          >
                            {t('确认移入')}
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => setConfirm(undefined)}
                          >
                            {t('取消')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="text-button"
                        disabled={
                          !work.available ||
                          work.blocked ||
                          !!pending ||
                          commentPending ||
                          workDirty(draft)
                        }
                        onClick={() =>
                          setConfirm({
                            key: draft.key,
                            id: draft.base!.id,
                            revision: draft.base!.revision,
                          })
                        }
                      >
                        <Trash2 aria-hidden="true" />
                        {t('移入回收站')}
                      </button>
                    )}
                  </div>
                )}
                {draft.base && !work.reading && (
                  <Comments
                    key={draft.base.id}
                    state={state}
                    dispatch={dispatch}
                    item={draft.base}
                    observe={work.observe}
                    author={author}
                  />
                )}
              </>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
