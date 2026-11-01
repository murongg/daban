import type {
  AttachmentEntry,
  AttachmentPage,
  AttachmentPurge,
  DocumentOriginal,
} from '@daban/protocol';
import { Download, FileText, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from './Button';
import { downloadBlob } from './files';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';

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
          ? t('附件已恢复，旧引用可继续使用。')
          : t('已移到回收站，恢复前不能作为任务输入。'),
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
        ? t('保留内容已永久删除，额度已释放。')
        : t('保留内容已删除、额度已释放；数据库整理暂未完成。');
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
        {t('管理此 Bot 保留的聊天附件。回收站仍占保留额度；永久删除后可继续上传。')}
      </p>
      {page && (
        <p className="inline-note">
          {t('保留原件：')}
          {size(page.originalBytes)}
          {t('/ 50 MB · 提取文本：')}
          {size(page.textBytes)} / 20 MB
        </p>
      )}
      <div className="panel-heading">
        <label className="field-label">
          {t('查找附件')}
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
          label={t('刷新保留附件')}
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
        {t('显示回收站')}
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
          {t('正在读取附件…')}
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
            {t('永久删除「')}
            {purge.name}」
          </h3>
          <p>
            {t(
              '将删除此处保留的原件和提取文本，无法从回收站恢复。旧消息中的下载和任务重试可能失效。工作区副本、已下载文件与备份仍保留。',
            )}
          </p>
          <label className="request-option">
            <input
              ref={check}
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {t('我理解旧下载和任务重试可能失效')}
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
              {t('取消')}
            </button>
            <button
              type="submit"
              className="primary retained-danger"
              disabled={!confirmed || busy || !available}
            >
              {busy ? t('正在删除…') : t('永久删除保留内容')}
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
                  {t('原件')}
                  {size(entry.size)}
                  {t('· 文本')}
                  {size(entry.textSize)}
                  {entry.deleted ? t(' · 回收站') : ''}
                </div>
              </div>
            </div>
            <IconButton
              label={t('下载原件 {0}', { 0: entry.name })}
              disabled={busy}
              onClick={() => original(entry)}
            >
              <Download />
            </IconButton>
            <IconButton
              label={`${entry.deleted ? t('恢复') : t('移到回收站')} ${entry.name}`}
              disabled={busy || !!purge || loading}
              onClick={() => change(entry)}
            >
              {entry.deleted ? <RotateCcw /> : <Trash2 />}
            </IconButton>
            {entry.deleted && (
              <IconButton
                label={t('永久删除 {0}', { 0: entry.name })}
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
        <p className="panel-description">{trash ? t('回收站为空。') : t('没有匹配的保留附件。')}</p>
      )}
      {page?.next && (
        <button
          type="button"
          className="secondary"
          disabled={busy || loading || !!purge}
          onClick={more}
        >
          {t('更多附件')}
        </button>
      )}
      {!available && (
        <p className="form-error" role="alert">
          {t('连接已更新的本地运行环境后可管理附件。')}
        </p>
      )}
    </div>
  );
}
