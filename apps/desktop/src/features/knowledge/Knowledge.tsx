import {
  agentId,
  type DocumentOriginal,
  documentLimit,
  isDocumentName,
  isKnowledgeContent,
  isKnowledgePath,
  isKnowledgeWrite,
  type KnowledgeDocument,
  type KnowledgeFile,
  type KnowledgeVersion,
} from '@daban/protocol';
import { Download, FileText, History, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import {
  type Action,
  type Bot,
  type KnowledgeDraft,
  knowledgeDirty,
  knowledgeDraft,
  type State,
} from '../../app/state';
import { IconButton } from '../../components/controls/Button';
import { getLocale, t, useLocale } from '../../i18n/locale';
import {
  canParseDocuments,
  documentUpload,
  download,
  downloadBlob,
  knowledgeAccept,
  readUtf8,
} from '../files/files';

export function Knowledge({
  state,
  bot,
  dispatch,
  notify,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (value: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime(),
    picker = useRef<HTMLInputElement>(null),
    editor = useRef<HTMLFormElement>(null);
  const [lists, setLists] = useState<Record<string, KnowledgeFile[]>>({});
  const [filters, setFilters] = useState<Record<string, { query?: string; trash?: boolean }>>({});
  const [statuses, setStatuses] = useState<
    Record<
      string,
      {
        busy?: boolean;
        error?: string;
        conflict?: KnowledgeDocument;
        versions?: KnowledgeVersion[];
        versionId?: string;
      }
    >
  >({});
  const [refresh, setRefresh] = useState(0);
  const draft = state.knowledgeDrafts[bot.id],
    status = statuses[bot.id] || {},
    files = lists[bot.id] || [];
  const { query = '', trash = false } = filters[bot.id] || {};
  const selected = draft ? `${bot.id}:${draft.id || 'new'}` : '';
  const original = files.find((file) => file.id === draft?.id)?.source;
  useEffect(() => {
    if (selected) editor.current?.scrollIntoView?.({ block: 'start' });
  }, [selected]);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 9 &&
    runtime.snapshot.knowledge?.available &&
    !bot.members;
  const feedback = (target: string, patch: (typeof statuses)[string]) =>
    setStatuses((current) => ({ ...current, [target]: { ...current[target], ...patch } }));
  const change = (patch: Partial<KnowledgeDraft>) =>
    dispatch({ type: 'knowledge-change', bot: bot.id, draft: patch });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Draft edits must not trigger reloads; reducer base checks fence delayed document responses.
  useEffect(() => {
    if (!available) return;
    let active = true;
    const target = bot.id,
      previous = state.knowledgeDrafts[target];
    const timer = setTimeout(
      () => {
        runtime
          .command<KnowledgeFile[]>({
            type: 'knowledge.list',
            bot: agentId(target),
            query,
            includeDeleted: trash,
          })
          .then(async (value) => {
            if (!active) return;
            setLists((current) => ({ ...current, [target]: value }));
            if (
              previous?.id &&
              !knowledgeDirty(previous) &&
              value.some((file) => file.id === previous.id && file.revision !== previous.revision)
            ) {
              const document = await runtime.command<KnowledgeDocument>({
                type: 'knowledge.read',
                bot: agentId(target),
                id: previous.id,
              });
              if (active) dispatch({ type: 'knowledge-load', bot: target, previous, document });
            }
          })
          .catch((error) => {
            if (active) feedback(target, { error: runtimeError(error) });
          });
      },
      query ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    available,
    bot.id,
    query,
    trash,
    refresh,
    runtime.snapshot.knowledge?.revision,
    runtime.command,
    dispatch,
  ]);
  function blocked(target = bot.id) {
    const current = state.knowledgeDrafts[target];
    if (current && knowledgeDirty(current)) {
      feedback(target, { error: t('knowledge.saveDiscardUnsavedDocumentEditsFirstDraft') });
      return true;
    }
    return false;
  }
  async function open(file: KnowledgeFile) {
    const target = bot.id,
      previous = state.knowledgeDrafts[target];
    if (previous?.id === file.id && knowledgeDirty(previous)) return;
    if (blocked(target)) return;
    feedback(target, { busy: true, error: '', conflict: undefined });
    try {
      const document = await runtime.command<KnowledgeDocument>({
        type: 'knowledge.read',
        bot: agentId(target),
        id: file.id,
      });
      dispatch({ type: 'knowledge-load', bot: target, previous, document });
    } catch (error) {
      feedback(target, { error: runtimeError(error) });
    } finally {
      feedback(target, { busy: false });
    }
  }
  async function save(value: KnowledgeDraft, target: string) {
    const document = {
      path: value.path,
      revision: value.revision,
      content: value.content,
      ...(value.id ? { id: value.id } : {}),
    };
    if (!isKnowledgeWrite(document)) {
      feedback(target, {
        error: t('knowledge.checkDocumentNameContentNamesMustNot'),
      });
      return;
    }
    feedback(target, { busy: true, error: '', conflict: undefined });
    try {
      const saved = await runtime.command<KnowledgeDocument>({
        type: 'knowledge.write',
        bot: agentId(target),
        document,
      });
      dispatch({ type: 'knowledge-load', bot: target, previous: value, document: saved });
      setRefresh((current) => current + 1);
      notify(t('knowledge.saved', { 0: saved.path }));
    } catch (error) {
      let conflict: KnowledgeDocument | undefined;
      if (value.id && error instanceof Error && error.message === 'KNOWLEDGE_CONFLICT') {
        try {
          conflict = await runtime.command<KnowledgeDocument>({
            type: 'knowledge.read',
            bot: agentId(target),
            id: value.id,
          });
        } catch (refreshError) {
          feedback(target, { error: runtimeError(refreshError) });
          return;
        }
      }
      feedback(target, { error: runtimeError(error), conflict });
    } finally {
      feedback(target, { busy: false });
    }
  }
  async function remove(file: KnowledgeFile) {
    const target = bot.id,
      previous = state.knowledgeDrafts[target];
    feedback(target, { busy: true, error: '' });
    try {
      const document = await runtime.command<KnowledgeDocument>({
        type: 'knowledge.remove',
        bot: agentId(target),
        id: file.id,
        revision: file.revision,
      });
      if (previous?.id === file.id && !knowledgeDirty(previous))
        dispatch({ type: 'knowledge-load', bot: target, previous, document });
      setRefresh((current) => current + 1);
      notify(t('knowledge.documentMovedTrashRevisionHistoryRetained'));
    } catch (error) {
      feedback(target, { error: runtimeError(error) });
    } finally {
      feedback(target, { busy: false });
    }
  }
  async function history(before?: number) {
    if (!draft?.id) return;
    const target = bot.id,
      id = draft.id;
    feedback(target, { busy: true, error: '' });
    try {
      const versions = await runtime.command<KnowledgeVersion[]>({
        type: 'knowledge.versions',
        bot: agentId(target),
        id,
        ...(before ? { before } : {}),
      });
      feedback(target, {
        versions: before ? [...(status.versions || []), ...versions] : versions,
        versionId: id,
      });
    } catch (error) {
      feedback(target, { error: runtimeError(error) });
    } finally {
      feedback(target, { busy: false });
    }
  }
  async function restore(version: KnowledgeVersion) {
    if (!draft?.id || blocked()) return;
    const target = bot.id,
      previous = draft;
    feedback(target, { busy: true, error: '' });
    try {
      const document = await runtime.command<KnowledgeDocument>({
        type: 'knowledge.restore',
        bot: agentId(target),
        id: draft.id,
        revision: draft.revision,
        targetRevision: version.revision,
      });
      dispatch({ type: 'knowledge-load', bot: target, previous, document });
      feedback(target, { versions: undefined });
      setRefresh((current) => current + 1);
      notify(t('knowledge.restoredNewRevisionSubsequentHistoryRetained'));
    } catch (error) {
      feedback(target, { error: runtimeError(error) });
    } finally {
      feedback(target, { busy: false });
    }
  }
  return (
    <div className="panel-section">
      <div className="panel-heading">
        <h2>{t('knowledge.longTermReferences')}</h2>
        <IconButton
          label={t('knowledge.refreshDocumentLibrary')}
          disabled={!available}
          onClick={() => setRefresh((current) => current + 1)}
        >
          <RefreshCw />
        </IconButton>
        <IconButton
          label={t('knowledge.newDocument')}
          disabled={!available || status.busy}
          onClick={() => {
            if (!blocked()) {
              dispatch({ type: 'knowledge-set', bot: bot.id, draft: knowledgeDraft() });
              feedback(bot.id, { error: '', conflict: undefined });
            }
          }}
        >
          <Plus />
        </IconButton>
        <IconButton
          label={t('knowledge.importDocument')}
          disabled={!available || status.busy}
          onClick={() => {
            if (!blocked()) picker.current?.click();
          }}
        >
          <Upload />
        </IconButton>
      </div>
      <p className="panel-description">
        {t('knowledge.only')}
        {bot.name}
        {t(
          canParseDocuments(runtime.snapshot)
            ? 'knowledge.sLongTermReferenceDocumentsSupportsText'
            : 'knowledge.textOnlyReference',
        )}
      </p>
      {!available && (
        <p className="form-error" role="alert">
          {bot.members
            ? t('knowledge.groupDocumentLibraryNotConnectedYetSelect')
            : !runtime.enabled
              ? t('knowledge.documentLibraryRequiresLocalRuntimeConnection')
              : runtime.snapshot.protocolVersion < 9
                ? t('knowledge.updateLocalRuntimeUseDocumentLibrary')
                : runtimeError(
                    new Error(runtime.snapshot.knowledge?.error || 'KNOWLEDGE_UNAVAILABLE'),
                  )}
        </p>
      )}
      {status.error && (
        <p className="form-error" role="alert">
          {status.error}
        </p>
      )}
      <input
        type="file"
        hidden
        ref={picker}
        aria-label={t('knowledge.chooseDocumentFile')}
        accept={knowledgeAccept(runtime.snapshot)}
        onChange={async (event) => {
          const target = bot.id,
            previous = state.knowledgeDrafts[target],
            file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          if (blocked(target)) return;
          feedback(target, { busy: true, error: '' });
          try {
            if (isDocumentName(file.name)) {
              if (!canParseDocuments(runtime.snapshot)) throw new Error('DOCUMENT_UNAVAILABLE');
              if (runtime.snapshot.protocolVersion < 10)
                throw new Error('DOCUMENT_RUNTIME_TOO_OLD');
              if (!file.size || file.size > documentLimit) throw new Error('INVALID_DOCUMENT');
              const document = await runtime.command<KnowledgeDocument>({
                type: 'knowledge.import',
                bot: agentId(target),
                file: await documentUpload(file),
              });
              dispatch({ type: 'knowledge-load', bot: target, previous, document });
              setRefresh((current) => current + 1);
              notify(t('knowledge.textImportedOriginalRetained'));
              return;
            }
            if (
              !/\.(md|txt|csv|json)$/i.test(file.name) ||
              !isKnowledgePath(file.name) ||
              file.size > 200 * 1024
            )
              throw new Error('INVALID_KNOWLEDGE');
            const content = await readUtf8(file);
            if (!isKnowledgeContent(content)) throw new Error('INVALID_KNOWLEDGE');
            const imported = { ...knowledgeDraft(), path: file.name, content };
            dispatch({ type: 'knowledge-stage', bot: target, previous, draft: imported });
            await save(imported, target);
          } catch (error) {
            feedback(target, { error: runtimeError(error) });
          } finally {
            feedback(target, { busy: false });
          }
        }}
      />
      <label className="field-label">
        {t('knowledge.findReferences')}
        <input
          className="field"
          type="search"
          aria-label={t('knowledge.searchDocuments')}
          value={query}
          maxLength={200}
          disabled={!available}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              [bot.id]: { ...current[bot.id], query: event.target.value },
            }))
          }
        />
      </label>
      <label className="request-option">
        <input
          type="checkbox"
          checked={trash}
          disabled={!available}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              [bot.id]: { ...current[bot.id], trash: event.target.checked },
            }))
          }
        />
        {t('common.showTrash')}
      </label>
      <div className="file-list">
        {files.map((file) => (
          <div className="file-row" key={file.id}>
            <button
              type="button"
              className="file-open"
              aria-label={t('knowledge.openDocument', { 0: file.path })}
              onClick={() => open(file)}
            >
              <span className="file-symbol">
                <FileText />
              </span>
              <div>
                <div className="artifact-name">{file.path}</div>
                <div className="artifact-meta">
                  v{file.revision} · {(file.size / 1024).toFixed(1)} KB
                  {file.deleted ? t('common.trashSuffix') : ''}
                </div>
              </div>
            </button>
            {!file.deleted && (
              <IconButton
                label={t('knowledge.moveTrash', { 0: file.path })}
                disabled={status.busy}
                onClick={() => remove(file)}
              >
                <Trash2 />
              </IconButton>
            )}
          </div>
        ))}
      </div>
      {!files.length && available && (
        <p className="panel-description">
          {query
            ? t('knowledge.noMatchingDocuments')
            : t('knowledge.noDocumentsYetImportTextAskBot')}
        </p>
      )}
      {draft && (
        <form
          ref={editor}
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!status.busy && available && !draft.deleted) await save(draft, bot.id);
          }}
        >
          <fieldset
            className="schedule-fields"
            disabled={!available || status.busy || draft.deleted}
          >
            <label className="field-label">
              {t('knowledge.documentName')}
              <input
                className="field"
                value={draft.path}
                required
                maxLength={240}
                onChange={(event) => change({ path: event.target.value })}
              />
            </label>
            <label className="field-label">
              {t('knowledge.documentContent')}
              <textarea
                className="field knowledge-editor"
                value={draft.content}
                aria-label={t('knowledge.documentContent')}
                rows={10}
                maxLength={204800}
                onChange={(event) => change({ content: event.target.value })}
              />
            </label>
          </fieldset>
          <p className="inline-note">
            {draft.deleted
              ? t('knowledge.documentTrashCanRestoredRevisionHistory')
              : knowledgeDirty(draft)
                ? t('common.unsavedChangesDraftRetained')
                : t('knowledge.savedV', { 0: draft.revision })}
          </p>
          {original && (
            <p className="inline-note" style={{ overflowWrap: 'anywhere' }}>
              {t('knowledge.importedOriginal')}
              {original.name} · {(original.size / 1024).toFixed(1)}{' '}
              {t('knowledge.kbBodyContainsExtractedTextImagesLayout')}
            </p>
          )}
          {status.conflict && (
            <div className="knowledge-conflict">
              <p className="inline-note">
                {t('knowledge.currentSavedRevisionV')}
                {status.conflict.revision}：{status.conflict.path}
                {status.conflict.deleted ? t('knowledge.alreadyTrash') : ''}
              </p>
              <pre>{status.conflict.content}</pre>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  change({ revision: status.conflict!.revision });
                  feedback(bot.id, { conflict: undefined, error: '' });
                }}
              >
                {t('common.keepDraftRetryRevision')}
              </button>
            </div>
          )}
          <div className="inline-form-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => dispatch({ type: 'knowledge-set', bot: bot.id })}
            >
              {knowledgeDirty(draft)
                ? t('knowledge.discardUnsavedChanges')
                : t('knowledge.closeDocument')}
            </button>
            {draft.id && (
              <IconButton
                label={t('knowledge.viewDocumentRevisions')}
                disabled={!available || status.busy}
                onClick={() => history()}
              >
                <History />
              </IconButton>
            )}
            {draft.id && !draft.deleted && (
              <IconButton
                label={t('knowledge.downloadSavedRevision')}
                disabled={!available || status.busy}
                onClick={async () => {
                  const target = bot.id;
                  try {
                    const document = await runtime.command<KnowledgeDocument>({
                      type: 'knowledge.read',
                      bot: agentId(target),
                      id: draft.id!,
                      version: draft.revision,
                    });
                    download({
                      id: document.id,
                      name: document.path.split('/').at(-1)!,
                      content: document.content,
                      kind: t('common.text'),
                      size: `${document.size} B`,
                      modified: document.updatedAt,
                    });
                  } catch (error) {
                    feedback(target, { error: runtimeError(error) });
                  }
                }}
              >
                <Download />
              </IconButton>
            )}
            {draft.id && original && (
              <IconButton
                label={t('knowledge.downloadImportedOriginal')}
                disabled={!available || runtime.snapshot.protocolVersion < 10 || status.busy}
                onClick={async () => {
                  const target = bot.id;
                  try {
                    const result = await runtime.command<DocumentOriginal>({
                      type: 'knowledge.source',
                      bot: agentId(target),
                      id: draft.id!,
                    });
                    const bytes = Uint8Array.from(atob(result.file.data), (character) =>
                      character.charCodeAt(0),
                    );
                    downloadBlob(
                      result.file.name,
                      new Blob([bytes], { type: 'application/octet-stream' }),
                    );
                  } catch (error) {
                    feedback(target, { error: runtimeError(error) });
                  }
                }}
              >
                <Download />
              </IconButton>
            )}
            <button
              type="submit"
              className="primary"
              disabled={!available || status.busy || draft.deleted}
            >
              {status.busy ? t('common.processing') : t('common.saveDocument')}
            </button>
          </div>
          {status.versionId === draft.id && status.versions && (
            <div className="schedule-history">
              <p>{t('knowledge.revisionHistory')}</p>
              {status.versions.map((version) => (
                <div className="knowledge-version" key={version.revision}>
                  <span>
                    v{version.revision} · {version.actor === 'bot' ? 'Bot' : t('common.you')} ·{' '}
                    {new Date(version.at).toLocaleString(getLocale())}
                    {version.deleted ? t('knowledge.deleted') : ''}
                  </span>
                  {!version.deleted && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={status.busy}
                      onClick={() => restore(version)}
                    >
                      {t('knowledge.restoreV')}
                      {version.revision}
                    </button>
                  )}
                </div>
              ))}
              {status.versions.length >= 20 && status.versions.at(-1)!.revision > 1 && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => history(status.versions!.at(-1)!.revision)}
                >
                  {t('knowledge.earlierRevisions')}
                </button>
              )}
            </div>
          )}
        </form>
      )}
      <p className="inline-note" style={{ marginTop: 24 }}>
        {t('knowledge.importsSaveTextSnapshotLaterEditsSource')}
      </p>
    </div>
  );
}
