import { type NoteFields, noteStates } from '@daban/protocol';
import { ArrowLeft, Plus, RefreshCw, Search, StickyNote } from 'lucide-react';
import { type Dispatch, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, Bot, State } from '../../app/state';
import { IconButton } from '../../components/controls/Button';
import { Select } from '../../components/controls/Select';
import { getLocale, t, useLocale } from '../../i18n/locale';
import { useNotes } from './note-controller';
import { noteDirty, noteInitial } from './notes-state';

const states = { open: 'common.do', parked: 'notes.later', done: 'common.completed' } as const;
const filters = {
  active: 'common.incomplete',
  all: 'common.all',
  open: 'common.do',
  parked: 'notes.later',
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

// Existing monochrome workspace extension: list → inline editor; drafts stay private to this Bot.
export function Notes({
  state,
  bot,
  dispatch,
  notify,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (text: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const notes = useNotes(state, bot, dispatch, notify);
  const cache = state.notes?.[bot.id] ?? noteInitial();
  const { draft, pending } = cache;
  const [confirm, setConfirm] = useState<{ key: string; id: string; revision: number }>();
  const confirming =
    !!draft?.base &&
    confirm?.key === draft.key &&
    confirm.id === draft.base.id &&
    confirm.revision === draft.base.revision;
  const sealed = !!draft && pending?.draft.key === draft.key;
  const readOnly = !notes.available || notes.history || sealed || notes.reading;
  const latest = notes.latest?.key === draft?.key ? notes.latest?.item : undefined;
  const editor = notes.editorVisible && (!!draft || notes.reading);
  const run = (operation: Promise<unknown>) =>
    operation.catch((error) => notify(runtimeError(error)));
  const mutate = (patch: Partial<NoteFields>) => {
    if (draft && !readOnly) dispatch({ type: 'notes-change', bot: bot.id, key: draft.key, patch });
  };
  return (
    <section className="panel-section notes-panel" aria-label={t('notes.notes', { 0: bot.name })}>
      <header className="notes-heading">
        <div>
          <h2>{t('common.notes')}</h2>
          <p>
            {t('notes.only')}
            {bot.name}
            {t('notes.viewEdit')}
          </p>
        </div>
        <div className="notes-actions">
          <IconButton
            label={t('notes.refreshNotes')}
            disabled={!notes.available || notes.loading}
            onClick={() => run(notes.load())}
          >
            <RefreshCw />
          </IconButton>
          <button
            type="button"
            className="secondary"
            disabled={!notes.available || notes.history || !!pending}
            onClick={() => {
              setConfirm(undefined);
              notes.fresh();
            }}
          >
            <Plus size={14} />
            {t('notes.newNote')}
          </button>
        </div>
      </header>
      <p className="inline-note">{t('notes.notesRecordItemsSavingMarkingThemDone')}</p>
      {!notes.available && (
        <div className="notes-notice" role="status">
          <strong>
            {runtime.enabled && runtime.snapshot.protocolVersion < 37
              ? t('common.runtimeUpdateRequired')
              : t('notes.notesUnavailable')}
          </strong>
          <p>
            {runtime.snapshot.notes?.available === false
              ? runtimeError(Error(runtime.snapshot.notes.error))
              : t('notes.connectRuntimeNotesSupportViewSaveNotes')}
          </p>
        </div>
      )}
      {notes.history && (
        <p className="notes-notice">{t('notes.botArchivedBeingArchivedNotesReadOnly')}</p>
      )}
      {notes.blocked && !notes.history && (
        <p className="notes-notice">
          {t('notes.runtimeRecoveringOnlyViewingEditingDraftsAvailable')}
        </p>
      )}
      {cache.damaged && (
        <p className="notes-notice" role="status">
          {t('notes.someLocalNoteCachesCouldNotRestored')}
        </p>
      )}
      {pending && (
        <section className="notes-notice" aria-label={t('notes.unconfirmedNoteOperation')}>
          <strong>
            {notes.working ? t('notes.submittingNote') : t('notes.operationSResultUnconfirmed')}
          </strong>
          <p>{t('notes.originalRequestSavedLocallyReopeningOnlyChecks')}</p>
          {notes.operationError && <p role="status">{notes.operationError}</p>}
          <div className="notes-actions">
            <button
              type="button"
              className="secondary"
              disabled={!notes.available || notes.checking}
              onClick={() => run(notes.check())}
            >
              {notes.checking ? t('common.verifying') : t('common.verifyOperationResult')}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={!notes.available || notes.blocked || notes.working}
              onClick={() => run(notes.retry())}
            >
              {t('common.retrySameOperation')}
            </button>
          </div>
        </section>
      )}
      {notes.error && (
        <p className="error-text" role="alert">
          {notes.error}
        </p>
      )}
      {editor ? (
        <section className="note-editor" aria-label={t('notes.noteEditor')}>
          <button
            type="button"
            className="text-button note-back"
            onClick={() => {
              notes.setEditorVisible(false);
              setConfirm(undefined);
            }}
          >
            <ArrowLeft size={14} />
            {t('notes.backNotes')}
          </button>
          {notes.reading && <p role="status">{t('notes.loadingNotes')}</p>}
          {draft && (
            <>
              <div className="note-meta" role="status">
                {sealed
                  ? t('notes.awaitingConfirmationOriginalTextLocked')
                  : noteDirty(draft)
                    ? t('notes.changesLocalHaveNotBeenSavedNote')
                    : draft.base
                      ? t('notes.savedNotes')
                      : t('notes.notEntered')}
                {draft.base && (
                  <span>
                    {draft.base.deleted
                      ? t('notes.alreadyTrash')
                      : t('common.numberedRevision', { 0: draft.base.revision })}{' '}
                    · {draft.base.updatedBy.kind === 'human' ? t('common.you') : bot.name}
                    {t('notes.updated')}{' '}
                    <time dateTime={draft.base.updatedAt}>{time(draft.base.updatedAt)}</time>
                  </span>
                )}
              </div>
              <label className="field-label">
                {t('notes.noteTitle')}
                <input
                  className="field"
                  value={draft.title}
                  readOnly={readOnly}
                  maxLength={200}
                  placeholder={t('notes.thingsRemember')}
                  onChange={(event) => mutate({ title: event.target.value })}
                />
              </label>
              <label className="field-label">
                {t('notes.noteBody')}
                <textarea
                  className="field note-body"
                  rows={8}
                  value={draft.body}
                  readOnly={readOnly}
                  maxLength={4000}
                  placeholder={t('notes.addDetailsProgressIdea')}
                  onChange={(event) => mutate({ body: event.target.value })}
                />
              </label>
              <div className="field-label">
                {t('notes.noteStatus')}
                <Select
                  label={t('notes.noteStatus')}
                  value={draft.status}
                  disabled={readOnly}
                  onValueChange={(value) => mutate({ status: value as NoteFields['status'] })}
                  options={noteStates.map((status) => ({
                    value: status,
                    label: t(states[status]),
                  }))}
                />
              </div>
              {draft.base?.completedAt && (
                <p className="inline-note">
                  {t('notes.completed')}{' '}
                  <time dateTime={draft.base.completedAt}>{time(draft.base.completedAt)}</time>
                </p>
              )}
              {latest && (
                <section className="note-conflict" aria-label={t('notes.reviewNoteRevisions')}>
                  <h3>{t('notes.compareRevisions')}</h3>
                  <p>{t('notes.editsRemainAboveKeepChangesMergesEdited')}</p>
                  {/* This bounded comparison needs keyboard scrolling without moving focus into the editor. */}
                  <section
                    className="note-versions"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded version comparison needs keyboard scrolling without focusing its editor.
                    tabIndex={0}
                    aria-label={t('notes.originalLatestNoteContent')}
                  >
                    <h4>
                      {t('notes.editsRevision')}
                      {draft.base?.revision}
                    </h4>
                    <strong>{draft.base?.title}</strong>
                    <p>{draft.base?.body || t('notes.noContent')}</p>
                    <p>{draft.base && t(states[draft.base.status])}</p>
                    <h4>
                      {t('notes.latestRevision')}
                      {latest.revision}
                      {latest.deleted ? t('notes.alreadyInTrashSuffix') : ''}
                    </h4>
                    <strong>{latest.title}</strong>
                    <p>{latest.body || t('notes.noContent')}</p>
                    <p>{t(states[latest.status])}</p>
                  </section>
                  <div className="notes-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={!!pending || notes.history}
                      onClick={() => notes.merge(true)}
                    >
                      {t('common.keepMyChanges')}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!!pending}
                      onClick={() => notes.merge(false)}
                    >
                      {t('notes.useLatestRevision')}
                    </button>
                  </div>
                </section>
              )}
              <div className="notes-actions note-save">
                <button
                  type="button"
                  className="primary"
                  disabled={
                    readOnly ||
                    notes.blocked ||
                    !!pending ||
                    !noteDirty(draft) ||
                    !!draft.base?.deleted ||
                    !!latest
                  }
                  onClick={() => run(notes.save())}
                >
                  {t('notes.saveNote')}
                </button>
                {noteDirty(draft) && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={sealed || notes.reading}
                    onClick={() => {
                      setConfirm(undefined);
                      notes.discard();
                    }}
                  >
                    {t('notes.discardChanges')}
                  </button>
                )}
              </div>
              {draft.base && (
                <div className="note-maintenance">
                  <button
                    type="button"
                    className="text-button"
                    disabled={!notes.available || !!pending || notes.reading}
                    onClick={() => run(notes.open(draft.base!.id, true))}
                  >
                    {t('common.reviewLatestRevision')}
                  </button>
                  {draft.base.deleted ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        notes.blocked || !notes.available || !!pending || notes.reading || !!latest
                      }
                      onClick={() => run(notes.changeStatus('restore'))}
                    >
                      {t('notes.restoreNote')}
                    </button>
                  ) : confirming ? (
                    <fieldset
                      className="note-trash-confirm"
                      aria-label={t('notes.confirmMoveTrash')}
                    >
                      <p>{t('notes.noteWillMoveTrashCanRestoredLater')}</p>
                      <button
                        type="button"
                        className="secondary danger-text"
                        disabled={
                          notes.blocked ||
                          !!pending ||
                          !notes.available ||
                          noteDirty(draft) ||
                          !!latest
                        }
                        onClick={() => run(notes.changeStatus('trash'))}
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
                    </fieldset>
                  ) : (
                    <button
                      type="button"
                      className="text-button danger-text"
                      disabled={
                        notes.blocked ||
                        !notes.available ||
                        !!pending ||
                        noteDirty(draft) ||
                        notes.reading ||
                        !!latest
                      }
                      onClick={() =>
                        setConfirm({
                          key: draft.key,
                          id: draft.base!.id,
                          revision: draft.base!.revision,
                        })
                      }
                    >
                      {t('common.moveTrash')}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      ) : (
        <section className="notes-collection" aria-label={t('common.noteList')}>
          {draft && (
            <button
              type="button"
              className="text-button note-resume"
              onClick={() => notes.setEditorVisible(true)}
            >
              {t('notes.continue')}
              {noteDirty(draft) ? t('notes.unsavedEdits') : t('notes.lastViewedNotes')}
            </button>
          )}
          <div className="notes-filters">
            <label className="note-search">
              <Search size={14} />
              <input
                className="field"
                aria-label={t('notes.searchNotes')}
                placeholder={t('notes.searchTitlesContent')}
                maxLength={200}
                value={cache.text}
                onChange={(event) =>
                  dispatch({
                    type: 'notes-options',
                    bot: bot.id,
                    patch: { text: event.target.value },
                  })
                }
              />
            </label>
            <Select
              label={t('notes.filterNotes')}
              value={cache.filter}
              onValueChange={(value) =>
                dispatch({
                  type: 'notes-options',
                  bot: bot.id,
                  patch: { filter: value as typeof cache.filter },
                })
              }
              options={Object.entries(filters).map(([value, label]) => ({
                value,
                label: t(label),
              }))}
            />
          </div>
          {notes.listError && (
            <p className="error-text" role="alert">
              {notes.listError}
            </p>
          )}
          {(notes.loading || (notes.available && !notes.loaded && !notes.listError)) && (
            <p className="inline-note" role="status">
              {t('notes.loadingNotes')}
            </p>
          )}
          <ul className="notes-list">
            {notes.items.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="note-row"
                  disabled={!!pending}
                  aria-label={t('notes.viewNote', { 0: row.title })}
                  onClick={() => {
                    setConfirm(undefined);
                    run(notes.open(row.id));
                  }}
                >
                  <span className="note-row-heading">
                    <strong>{row.title}</strong>
                    <span>{t(states[row.status])}</span>
                  </span>
                  {row.body && (
                    <span className="note-preview">
                      {row.body}
                      {row.bodyTruncated ? '…' : ''}
                    </span>
                  )}
                  <time className="note-meta" dateTime={row.updatedAt}>
                    {time(row.updatedAt)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
          {notes.next !== undefined && (
            <button
              type="button"
              className="text-button"
              disabled={notes.loading}
              onClick={() => run(notes.load(true))}
            >
              {t('notes.loadEarlierNotes')}
            </button>
          )}
          {notes.available &&
            notes.loaded &&
            !notes.loading &&
            !notes.listError &&
            !notes.items.length && (
              <div className="empty-panel">
                <StickyNote />
                <h3>
                  {cache.text
                    ? t('notes.noMatchingNotes')
                    : cache.filter === 'trash'
                      ? t('common.trashEmpty')
                      : t('notes.noNotesHereYet')}
                </h3>
                <p>
                  {cache.text
                    ? t('notes.tryAnotherSearchTermFilter')
                    : t('notes.writeNotesHereAskBotRememberItems')}
                </p>
              </div>
            )}
        </section>
      )}
    </section>
  );
}
