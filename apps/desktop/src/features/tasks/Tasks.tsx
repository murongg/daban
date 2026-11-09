import {
  agentId,
  legacyWorkStates,
  type WorkFields,
  type WorkSummary,
  workStates,
} from '@daban/protocol';
import {
  Columns3,
  List,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { type Dispatch, useLayoutEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, State } from '../../app/state';
import { WindowList } from '../../components/collection/WindowList';
import { IconButton } from '../../components/controls/Button';
import { reducedMotionQuery } from '../../components/controls/motion';
import { Pane } from '../../components/controls/Pane';
import { Select } from '../../components/controls/Select';
import { getLocale, t, useLocale } from '../../i18n/locale';
import { Comments } from './Comments';
import { commentCard } from './comments-state';
import type { WorkController } from './work';
import { workDirty, workInitial } from './work-state';

const states = {
  todo: 'common.do',
  doing: 'common.progress',
  review: 'tasks.review',
  blocked: 'tasks.blocked',
  done: 'common.completed',
  closed: 'tasks.closed',
} as const;
const filters = {
  all: 'common.all',
  open: 'common.incomplete',
  done: 'common.completed',
  trash: 'common.trash',
} as const;
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
  const [expanded, setExpanded] = useState(false);
  const returnToList = useRef(false);
  const collection = useRef<HTMLDivElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const resumeDraft = useRef<HTMLButtonElement>(null);
  const newTask = useRef<HTMLButtonElement>(null);
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
  useLayoutEffect(() => {
    if (hasEditor) {
      const list = collection.current;
      const focused = document.activeElement;
      // In the compact layout the row that opened the editor is no longer reachable.
      if (
        list &&
        getComputedStyle(list).display === 'none' &&
        (list.contains(focused) || focused === document.body)
      )
        detailTitle.current?.focus({ preventScroll: true });
      return;
    }
    if (!returnToList.current) return;
    returnToList.current = false;
    (resumeDraft.current ?? newTask.current)?.focus({ preventScroll: true });
  }, [hasEditor]);
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
      ? t('common.you')
      : (state.bots.find((bot) => agentId(bot.id) === who.bot)?.name ?? `Bot ${who.bot}`);
  const mutate = (patch: Partial<WorkFields>) => {
    if (draft) dispatch({ type: 'work-change', key: draft.key, patch });
  };
  const latestText = latest && (
    <section
      className="task-latest-text"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded text region needs keyboard scrolling.
      tabIndex={0}
      aria-label={t('tasks.serverDescriptionProgress')}
    >
      <p>{latest.description || t('tasks.noDescription')}</p>
      <p>{latest.progress || t('tasks.noProgressRecorded')}</p>
    </section>
  );
  function card(item: WorkSummary) {
    return (
      <li key={item.id}>
        <button
          type="button"
          className={`task-card ${draft?.base?.id === item.id ? 'selected' : ''}`}
          aria-label={t('common.view', { 0: item.title })}
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
            <time dateTime={item.updatedAt}>
              {t('tasks.updatedByAt', { 0: author(item.updatedBy), 1: time(item.updatedAt) })}
            </time>
          </span>
        </button>
      </li>
    );
  }
  return (
    <section className="tasks" aria-label={t('tasks.sharedTasks')}>
      <div className="tasks-top">
        <div className="tasks-intro">
          <p>{t('tasks.shareOneDoListAllBotsSaving')}</p>
          <button
            ref={newTask}
            type="button"
            className="primary"
            disabled={!work.available}
            onClick={() => {
              setConfirm(undefined);
              work.fresh();
            }}
          >
            <Plus aria-hidden="true" />
            {t('tasks.newTask')}
          </button>
        </div>
        <div className="task-toolbar">
          <label className="task-search">
            <Search aria-hidden="true" />
            <span className="sr-only">{t('tasks.searchTasks')}</span>
            <input
              type="search"
              placeholder={t('tasks.searchTasks')}
              maxLength={200}
              value={cache.text}
              onChange={(event) =>
                dispatch({ type: 'work-options', patch: { text: event.target.value } })
              }
            />
          </label>
          <fieldset className="task-filters" aria-label={t('tasks.filterTasks')}>
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
          <fieldset className="task-layout-switch" aria-label={t('tasks.taskLayout')}>
            <button
              type="button"
              aria-label={t('tasks.list')}
              aria-pressed={!board}
              onClick={() => dispatch({ type: 'work-options', patch: { mode: 'list' } })}
            >
              <List aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t('tasks.board')}
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
            {t('common.refresh')}
          </button>
        </div>
        {cache.damaged && (
          <p role="alert" className="form-error">
            {t('tasks.someLocalTaskRecordsDamagedOtherChats')}
          </p>
        )}
        {work.blocked && (
          <p role="status" className="field-help">
            {t('tasks.runtimeRecoveringCanStillViewVerifyTasks')}
          </p>
        )}
        {pending && (
          <div className="work-pending" role="status">
            <strong>
              {t(
                work.working ? 'tasks.verifyingOperationTitle' : 'tasks.unconfirmedOperationTitle',
                { 0: pending.draft.title || pending.draft.base?.title || '' },
              )}
            </strong>
            <p>{t('tasks.originalRequestRetainedReopeningChecksResultWithout')}</p>
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
                {work.checking ? t('common.verifying') : t('common.verifyOperationResult')}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!work.available || work.blocked || work.working}
                onClick={() => work.retry().catch(() => {})}
              >
                {t('common.retrySameOperation')}
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
            {t('tasks.taskHasNewChangesCurrentEditsRetained')}
            <button
              type="button"
              className="text-button"
              disabled={work.loading}
              onClick={() => work.load().catch(() => {})}
            >
              {t('common.refreshList')}
            </button>
          </div>
        )}
        {draft && !work.editorVisible && (
          <button
            ref={resumeDraft}
            type="button"
            className="text-button"
            onClick={() => work.setEditorVisible(true)}
          >
            {draft.title
              ? t('tasks.continueDraft', { 0: draft.title })
              : t('tasks.continueUntitledDraft')}
          </button>
        )}
      </div>
      <div
        className={`work-layout ${hasEditor ? 'has-editor' : ''} ${hasEditor && expanded ? 'editor-expanded' : ''}`}
      >
        <div ref={collection} className="work-collection">
          {!work.available ? (
            <div className="task-empty">
              <h2>
                {runtime.enabled &&
                runtime.snapshot.protocolVersion > 0 &&
                runtime.snapshot.protocolVersion < 36
                  ? t('common.runtimeUpdateRequired')
                  : t('tasks.tasksUnavailable')}
              </h2>
              <p>
                {!runtime.enabled || runtime.snapshot.phase !== 'ready'
                  ? t('tasks.connectLocalRuntimeViewSharedTasksLocal')
                  : runtime.snapshot.protocolVersion < 36
                    ? t('tasks.updateRuntimeUseSharedTasksExistingChats')
                    : runtimeError(new Error(runtime.snapshot.work?.error ?? 'WORK_UNAVAILABLE'))}
              </p>
            </div>
          ) : work.loading && !work.items.length ? (
            <div className="task-loading" role="status" aria-label={t('tasks.readingTask')}>
              <span />
              <span />
              <span />
            </div>
          ) : work.listError && !work.items.length ? (
            <div className="task-empty">
              <h2>{t('tasks.taskListNotLoaded')}</h2>
              <p>{t('tasks.refreshRetryLocalDraftRetainedFailedRead')}</p>
            </div>
          ) : !work.items.length ? (
            <div className="task-empty">
              <h2>
                {cache.text
                  ? t('tasks.noMatchingTasks')
                  : cache.filter === 'trash'
                    ? t('common.trashEmpty')
                    : t('tasks.noTasksHereYet')}
              </h2>
              <p>
                {cache.text
                  ? t('tasks.tryAnotherKeywordChangeFilter')
                  : cache.filter === 'trash'
                    ? t('tasks.restoreTrashedTasksHere')
                    : t('tasks.recordThingsFollowUpThenAskBot')}
              </p>
            </div>
          ) : (
            <>
              <p className="task-count">
                {t(work.next !== undefined ? 'tasks.loadedCountMore' : 'tasks.loadedCount', {
                  0: work.items.length,
                })}
              </p>
              {board ? (
                <div className="task-board">
                  {visibleStates.map((status) => (
                    <section key={status} aria-label={t(states[status])} className="task-column">
                      <h2>
                        {t(states[status])}
                        <span>{work.items.filter((row) => row.status === status).length}</span>
                      </h2>
                      <WindowList
                        tag="ul"
                        scope={`${cache.filter}:${cache.text}:${status}`}
                        items={work.items.filter((row) => row.status === status)}
                        getKey={(row) => row.id}
                        renderItem={card}
                        estimate={140}
                      />
                      {!work.items.some((row) => row.status === status) && (
                        <p className="field-help">{t('tasks.noLoadedTasks')}</p>
                      )}
                    </section>
                  ))}
                </div>
              ) : (
                <WindowList
                  tag="ul"
                  className="task-list"
                  scope={`${cache.filter}:${cache.text}`}
                  items={work.items}
                  getKey={(row) => row.id}
                  renderItem={card}
                  estimate={120}
                />
              )}
              {work.next !== undefined && (
                <button
                  type="button"
                  className="secondary task-more"
                  disabled={work.loading}
                  onClick={() => work.load(true).catch(() => {})}
                >
                  {work.loading ? t('common.loading') : t('tasks.loadMoreTasks')}
                </button>
              )}
            </>
          )}
        </div>
        {hasEditor && (
          <Pane
            id="task-detail-editor"
            className="task-pane"
            bodyClass="task-editor"
            label={t('tasks.taskDetails')}
            resizable={!expanded}
          >
            <div className="task-editor-heading">
              <h2 ref={detailTitle} tabIndex={-1}>
                {draft?.base ? t('tasks.taskDetails') : t('tasks.newTask')}
              </h2>
              <div className="task-editor-actions">
                <IconButton
                  label={t(expanded ? 'tasks.collapseEditor' : 'tasks.expandEditor')}
                  className="task-expand"
                  aria-pressed={expanded}
                  aria-controls="task-detail-editor"
                  onClick={() => setExpanded((current) => !current)}
                >
                  {expanded ? <Minimize2 /> : <Maximize2 />}
                </IconButton>
                {draft?.base && !work.reading && (
                  <IconButton
                    label={t('tasks.viewDiscussion')}
                    aria-controls={`task-comments-${draft.base.id}`}
                    onClick={() => {
                      const target = document.getElementById(`task-comments-${draft.base!.id}`);
                      target?.scrollIntoView({
                        block: 'start',
                        behavior: window.matchMedia?.(reducedMotionQuery).matches
                          ? 'auto'
                          : 'smooth',
                      });
                      target?.focus({ preventScroll: true });
                    }}
                  >
                    <MessageSquare />
                  </IconButton>
                )}
                {draft && (
                  <IconButton
                    label={t('tasks.discardChanges')}
                    disabled={sealed || !workDirty(draft)}
                    onClick={() => {
                      setConfirm(undefined);
                      work.discard();
                    }}
                  >
                    <RotateCcw />
                  </IconButton>
                )}
                {draft && (
                  <IconButton
                    label={t('tasks.saveTask')}
                    className="primary"
                    type="submit"
                    form={formId}
                    disabled={saveDisabled}
                  >
                    <Save />
                  </IconButton>
                )}
                <IconButton
                  label={t('tasks.closeEditor')}
                  onClick={() => {
                    returnToList.current = true;
                    setExpanded(false);
                    work.setEditorVisible(false);
                  }}
                >
                  <X />
                </IconButton>
              </div>
            </div>
            {work.reading && (
              <p role="status" className="field-help">
                {t('tasks.loadingTask')}
              </p>
            )}
            {draft && (
              <>
                <p className="field-help">
                  {sealed
                    ? t('tasks.originalOperationBeingVerifiedSubmittedContentLocked')
                    : draft.base?.deleted
                      ? t('tasks.taskTrashRestoringRetainsCurrentDraftSave')
                      : workDirty(draft)
                        ? t('tasks.unsavedChangesRetainedWhenLeavePage')
                        : draft.base
                          ? t('tasks.savedCurrentRuntime')
                          : t('tasks.newTaskDraftFillSaveRuntime')}
                </p>
                {commentPending && (
                  <p role="status" className="field-help">
                    {t('tasks.commentResultTaskUnconfirmedViewDiscussionVerify')}
                  </p>
                )}
                {!work.available && (
                  <p className="field-help">
                    {t('tasks.showingLocalDraftReadOnlyReconnectContinue')}
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
                    {t('tasks.taskTitle')}
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
                    {t('tasks.taskStatus')}
                    <Select
                      label={t('tasks.taskStatus')}
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
                    {t('tasks.taskDescription')}
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
                    {t('tasks.latestProgress')}
                    <textarea
                      className="field"
                      rows={4}
                      maxLength={4000}
                      value={draft.progress}
                      readOnly={readOnly}
                      onChange={(event) => mutate({ progress: event.target.value })}
                    />
                  </label>
                  <p className="field-help">{t('tasks.markingDoneOnlyChangesDoStatusDoes')}</p>
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
                          {t('common.reviewLatestRevision')}
                        </button>
                      )}
                    </div>
                  )}
                  {latest && (
                    <div className="task-conflict">
                      <h3>{t('tasks.currentServerContent')}</h3>
                      <p>
                        {t(
                          latest.deleted
                            ? 'tasks.currentDeletedRevisionSummary'
                            : 'tasks.currentRevisionSummary',
                          { 0: latest.title, 1: t(states[latest.status]) },
                        )}
                      </p>
                      <details>
                        <summary>{t('tasks.viewServerDescriptionProgress')}</summary>
                        {latestText}
                      </details>
                      <p className="field-help">
                        {t('tasks.keepChangesUseServerValuesUneditedFields')}
                      </p>
                      <div className="task-actions">
                        <button
                          type="button"
                          className="secondary"
                          disabled={!!pending}
                          onClick={() => work.merge(true)}
                        >
                          {t('common.keepMyChanges')}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={!!pending}
                          onClick={() => work.merge(false)}
                        >
                          {t('tasks.useServerRevision')}
                        </button>
                      </div>
                    </div>
                  )}
                </form>
                {draft.base && (
                  <div className="task-history">
                    <div>
                      <p className="task-meta">
                        {t('tasks.createdUpdatedBy', {
                          0: author(draft.base.createdBy),
                          1: author(draft.base.updatedBy),
                        })}
                      </p>
                      <p className="task-meta">
                        <time dateTime={draft.base.updatedAt}>
                          {draft.base.completedAt
                            ? t('tasks.updatedAndCompletedAt', {
                                0: time(draft.base.updatedAt),
                                1: time(draft.base.completedAt),
                              })
                            : t('tasks.updatedAt', { 0: time(draft.base.updatedAt) })}
                        </time>
                      </p>
                    </div>
                    {draft.base.deleted ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={!work.available || work.blocked || !!pending || commentPending}
                        onClick={() => work.changeStatus('restore').catch(() => {})}
                      >
                        {t('tasks.restoreTask')}
                      </button>
                    ) : confirming ? (
                      <div className="task-confirm">
                        <p>{t('tasks.confirmMoveTrashTitle', { 0: draft.base.title })}</p>
                        <div className="task-actions">
                          <button
                            type="button"
                            className="secondary"
                            disabled={!!pending || work.blocked || commentPending}
                            onClick={() => work.changeStatus('trash').catch(() => {})}
                          >
                            {t('common.confirmMove')}
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => setConfirm(undefined)}
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <IconButton
                        label={t('common.moveTrash')}
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
                        <Trash2 />
                      </IconButton>
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
          </Pane>
        )}
      </div>
    </section>
  );
}
