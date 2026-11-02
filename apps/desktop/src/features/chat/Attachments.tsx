import type {
  AttachmentEntry,
  AttachmentPage,
  AttachmentPurge,
  DocumentOriginal,
} from '@daban/protocol';
import { Download, FileText, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { IconButton } from '../../components/controls/Button';
import { t, useLocale } from '../../i18n/locale';
import { downloadBlob } from '../files/files';

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
export function Attachments({
  bot,
  notify,
}: {
  bot: string;
  notify: (message: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const [page, setPage] = useState<AttachmentPage>();
  const [query, setQuery] = useState('');
  const [trash, setTrash] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [purge, setPurge] = useState<AttachmentEntry>();
  const [confirmed, setConfirmed] = useState(false);
  const check = useRef<HTMLInputElement>(null);
  const available =
    runtime.enabled && runtime.snapshot.phase === 'ready' && runtime.snapshot.protocolVersion >= 12;
  useEffect(() => {
    if (purge) check.current?.focus();
  }, [purge]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The refresh counter intentionally reloads committed catalog state.
  useEffect(() => {
    if (!available) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const timer = setTimeout(
      () => {
        runtime
          .command<AttachmentPage>({ type: 'attachment.list', bot, query: { trash, query } })
          .then((value) => {
            if (active) setPage(value);
          })
          .catch((failure) => {
            if (active) setError(runtimeError(failure));
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [available, runtime.command, bot, trash, query, refresh]);
  async function more() {
    if (!page?.next || busy || loading) return;
    setBusy(true);
    try {
      const value = await runtime.command<AttachmentPage>({
        type: 'attachment.list',
        bot,
        query: { trash, query, before: page.next },
      });
      setPage({ ...value, items: [...page.items, ...value.items] });
    } catch (failure) {
      setError(runtimeError(failure));
    } finally {
      setBusy(false);
    }
  }
  async function change(entry: AttachmentEntry) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await runtime.command<AttachmentEntry>({
        type: entry.deleted ? 'attachment.restore' : 'attachment.trash',
        bot,
        id: entry.id,
        version: entry.version,
      });
      setNote(
        entry.deleted
          ? t('attachments.attachmentRestoredOldReferencesWorkAgain')
          : t('attachments.movedTrashCannotUsedTaskInputUntil'),
      );
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(runtimeError(failure));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!purge || !confirmed || busy || !available) return;
    const reviewed = purge;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const result = await runtime.command<AttachmentPurge>({
        type: 'attachment.purge',
        bot,
        id: reviewed.id,
        version: reviewed.version,
        confirmation: reviewed.name,
      });
      setPurge(undefined);
      setConfirmed(false);
      const message = result.checkpointed
        ? t('attachments.retainedContentPermanentlyDeletedQuotaReleased')
        : t('attachments.retainedContentDeletedQuotaReleasedDatabaseCompaction');
      setNote(message);
      notify(message);
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(runtimeError(failure));
      if (failure instanceof Error && failure.message === 'ATTACHMENT_CONFLICT') {
        setPurge(undefined);
        setConfirmed(false);
        setRefresh((value) => value + 1);
      }
    } finally {
      setBusy(false);
    }
  }
  async function original(entry: AttachmentEntry) {
    setBusy(true);
    setError('');
    try {
      const source = await runtime.command<DocumentOriginal>({
        type: 'attachment.source',
        bot,
        id: entry.id,
      });
      const bytes = Uint8Array.from(atob(source.file.data), (character) => character.charCodeAt(0));
      downloadBlob(source.file.name, new Blob([bytes], { type: 'application/octet-stream' }));
    } catch (failure) {
      setError(runtimeError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="retained-panel">
      <p className="panel-description">
        {t('attachments.manageRetainedChatAttachmentsBotTrashStill')}
      </p>
      {page && (
        <p className="inline-note">
          {t('attachments.retainOriginal')}
          {size(page.originalBytes)}
          {t('attachments.mbExtractedText')}
          {size(page.textBytes)} / 20 MB
        </p>
      )}
      <div className="panel-heading">
        <label className="field-label">
          {t('attachments.findAttachments')}
          <input
            className="field"
            type="search"
            maxLength={200}
            value={query}
            disabled={busy || !!purge}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <IconButton
          label={t('attachments.refreshRetainedAttachments')}
          disabled={busy || !!purge}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw />
        </IconButton>
      </div>
      <label className="request-option">
        <input
          type="checkbox"
          checked={trash}
          disabled={busy || !!purge}
          onChange={(event) => setTrash(event.target.checked)}
        />
        {t('common.showTrash')}
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="inline-note" role="status">
          {note}
        </p>
      )}
      {loading && (
        <p className="inline-note" role="status">
          {t('attachments.readingAttachments')}
        </p>
      )}
      {purge && (
        <form
          className="retained-confirm"
          onSubmit={async (event) => {
            event.preventDefault();
            await remove();
          }}
        >
          <h3>
            {t('attachments.permanentlyDeletePrefix')}
            {purge.name}」
          </h3>
          <p>{t('attachments.permanentlyDeletesRetainedOriginalsExtractedTextHere')}</p>
          <label className="request-option">
            <input
              ref={check}
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {t('attachments.iUnderstandOldDownloadsTaskRetriesMay')}
          </label>
          <div className="inline-form-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setPurge(undefined);
                setConfirmed(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="primary retained-danger"
              disabled={!confirmed || busy || !available}
            >
              {busy ? t('attachments.deleting') : t('attachments.permanentlyDeleteRetainedContent')}
            </button>
          </div>
        </form>
      )}
      <div className="file-list">
        {page?.items.map((entry) => (
          <div className="file-row" key={entry.id}>
            <div className="retained-details">
              <span className="file-symbol">
                <FileText />
              </span>
              <div>
                <div className="artifact-name">{entry.name}</div>
                <div className="artifact-meta">
                  {t('attachments.original')}
                  {size(entry.size)}
                  {t('attachments.text')}
                  {size(entry.textSize)}
                  {entry.deleted ? t('common.trashSuffix') : ''}
                </div>
              </div>
            </div>
            <IconButton
              label={t('attachments.downloadOriginal', { 0: entry.name })}
              disabled={busy}
              onClick={() => original(entry)}
            >
              <Download />
            </IconButton>
            <IconButton
              label={`${entry.deleted ? t('common.restore') : t('attachments.moveTrash')} ${entry.name}`}
              disabled={busy || !!purge || loading}
              onClick={() => change(entry)}
            >
              {entry.deleted ? <RotateCcw /> : <Trash2 />}
            </IconButton>
            {entry.deleted && (
              <IconButton
                label={t('attachments.permanentlyDelete', { 0: entry.name })}
                disabled={busy || !!purge || loading}
                onClick={() => {
                  setPurge(entry);
                  setConfirmed(false);
                  setError('');
                }}
              >
                <Trash2 />
              </IconButton>
            )}
          </div>
        ))}
      </div>
      {page && !page.items.length && !loading && (
        <p className="panel-description">
          {trash ? t('attachments.trashEmpty') : t('attachments.noMatchingRetainedAttachments')}
        </p>
      )}
      {page?.next && (
        <button
          type="button"
          className="secondary"
          disabled={busy || loading || !!purge}
          onClick={more}
        >
          {t('attachments.moreAttachments')}
        </button>
      )}
      {!available && (
        <p className="form-error" role="alert">
          {t('attachments.connectUpdatedLocalRuntimeManageAttachments')}
        </p>
      )}
    </div>
  );
}
