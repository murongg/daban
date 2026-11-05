import {
  compareReviewPaths,
  isReviewCurrent,
  isReviewDiff,
  isReviewPage,
  isTranscriptScope,
  type ReviewChange,
  type ReviewCurrent,
  type ReviewDiff,
  type ReviewFile,
  type ReviewFileQuery,
  type ReviewPage,
  type ReviewReason,
  type ReviewSnapshot,
  type ReviewState,
  reviewFileKey,
  sameTranscriptScope,
  type TranscriptScope,
} from '@daban/protocol';
import { Files } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRemote } from '../../app/Remote';
import { useRuntime } from '../../app/Runtime';
import { reviewTarget } from '../../app/state';
import { WindowList } from '../../components/collection/WindowList';
import { Dialog } from '../../components/controls/Dialog';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import './file-review.css';

const reasonKeys: Record<ReviewReason | 'binary' | 'diff-limit', MessageKey> = {
  permission: 'fileReview.reason.permission',
  'size-limit': 'fileReview.reason.sizeLimit',
  'entry-limit': 'fileReview.reason.entryLimit',
  'text-limit': 'fileReview.reason.textLimit',
  'time-limit': 'fileReview.reason.timeLimit',
  excluded: 'fileReview.reason.excluded',
  unstable: 'fileReview.reason.unstable',
  'root-moved': 'fileReview.reason.rootMoved',
  'unbounded-writer': 'fileReview.reason.unboundedWriter',
  'background-writer': 'fileReview.reason.backgroundWriter',
  'drain-failed': 'fileReview.reason.drainFailed',
  cancelled: 'fileReview.reason.cancelled',
  disconnected: 'fileReview.reason.disconnected',
  unsupported: 'fileReview.reason.unsupported',
  'baseline-missing': 'fileReview.reason.baselineMissing',
  'storage-limit': 'fileReview.reason.storageLimit',
  corrupt: 'fileReview.reason.corrupt',
  expired: 'fileReview.reason.expired',
  binary: 'fileReview.reason.binary',
  'diff-limit': 'fileReview.reason.diffLimit',
};
const stateKeys: Record<ReviewState, MessageKey> = {
  'capturing-before': 'fileReview.state.capturingBefore',
  recording: 'fileReview.state.recording',
  'capturing-after': 'fileReview.state.capturingAfter',
  complete: 'fileReview.state.complete',
  interrupted: 'fileReview.state.interrupted',
  unavailable: 'fileReview.state.unavailable',
  expired: 'fileReview.state.expired',
};

function errorKey(error: unknown): MessageKey {
  return error instanceof Error && error.message === 'STALE_FILE_REVIEW'
    ? 'fileReview.stale'
    : 'fileReview.readFailed';
}

function Evidence({ file }: { file: ReviewFile }) {
  if (file.state === 'absent') return <span>{t('fileReview.absent')}</span>;
  if (file.state === 'unknown')
    return (
      <span>
        {t('fileReview.unknown')} · {t(reasonKeys[file.reason])}
      </span>
    );
  return (
    <span>
      {t('fileReview.bytes', { 0: file.bytes })} · <code>{file.sha256}</code>
    </span>
  );
}

function Snapshots({ side, items }: { side: 'before' | 'after'; items?: ReviewSnapshot[] }) {
  if (!items?.length) return null;
  return (
    <section className="file-review-captures">
      <h3>{t(`fileReview.${side}`)}</h3>
      {items.map((item) => (
        <div key={item.area}>
          <strong>{t(`fileReview.${item.area}`)}</strong>
          {side === 'before' && item.area === 'task' && <p>{t('fileReview.preparedInputs')}</p>}
          <p>
            <time>{item.startedAt}</time> — <time>{item.endedAt}</time>
          </p>
          <p>
            {t('fileReview.coverage', {
              0: t(`fileReview.coverage.${item.capture}`),
              1: item.omitted,
            })}
          </p>
          {item.reasons.map((reason) => (
            <p key={reason}>{t(reasonKeys[reason])}</p>
          ))}
        </div>
      ))}
    </section>
  );
}

function Item({
  change,
  query,
  side,
}: {
  change: ReviewChange;
  query: ReviewFileQuery;
  side: 'changes' | 'before' | 'after';
}) {
  const { command } = useRuntime();
  const [diff, setDiff] = useState<ReviewDiff>();
  const [current, setCurrent] = useState<ReviewCurrent>();
  const [busy, setBusy] = useState<'diff' | 'current'>();
  const [error, setError] = useState<MessageKey>();
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function read(kind: 'diff' | 'current') {
    const ticket = ++epoch.current;
    setBusy(kind);
    setError(undefined);
    try {
      const value = await command({ type: `files.review.${kind}`, query });
      if (ticket !== epoch.current) return;
      if (kind === 'diff') {
        if (
          !isReviewDiff(value) ||
          !sameTranscriptScope(value.scope, query.scope) ||
          value.revision !== query.revision ||
          value.area !== query.area ||
          value.path !== query.path
        )
          throw Error('INVALID_FILE_REVIEW');
        setDiff(value);
      } else {
        if (
          !isReviewCurrent(value) ||
          !sameTranscriptScope(value.scope, query.scope) ||
          value.revision !== query.revision ||
          value.area !== query.area ||
          value.path !== query.path
        )
          throw Error('INVALID_FILE_REVIEW');
        setCurrent(value);
      }
    } catch (error) {
      if (ticket === epoch.current) setError(errorKey(error));
    } finally {
      if (ticket === epoch.current) setBusy(undefined);
    }
  }
  return (
    <>
      <div className="file-review-heading">
        <h3>{query.path}</h3>
        <span>{t(`fileReview.kind.${change.kind}`)}</span>
      </div>
      <p className="field-help">{t(`fileReview.${query.area}`)}</p>
      <dl className="file-review-evidence">
        {side !== 'after' && (
          <div>
            <dt>{t('fileReview.before')}</dt>
            <dd>
              <Evidence file={change.before} />
            </dd>
          </div>
        )}
        {side !== 'before' && (
          <div>
            <dt>{t('fileReview.after')}</dt>
            <dd>
              <Evidence file={change.after} />
            </dd>
          </div>
        )}
      </dl>
      <div className="file-review-actions">
        <button
          type="button"
          className="text-button"
          disabled={!!busy}
          onClick={() => read('diff').catch(() => setError('fileReview.readFailed'))}
        >
          {t('fileReview.diff', { 0: query.path })}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={!!busy}
          onClick={() => read('current').catch(() => setError('fileReview.readFailed'))}
        >
          {t('fileReview.current', { 0: query.path })}
        </button>
      </div>
      {busy && <p role="status">{t('fileReview.loading')}</p>}
      {error && <p role="alert">{t(error)}</p>}
      {current && <p role="status">{t(`fileReview.current.${current.state}`)}</p>}
      {diff?.state === 'unavailable' && <p role="status">{t(reasonKeys[diff.reason])}</p>}
      {diff?.state === 'text' && (
        <section
          className="file-review-diff"
          aria-label={t('fileReview.diff', { 0: query.path })}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Long read-only evidence needs a named keyboard-scrollable region.
          tabIndex={0}
        >
          <WindowList
            scope={`diff:${query.revision}:${query.area}:${query.path}`}
            estimate={28}
            items={diff.lines.map((line, index) => ({ ...line, number: index + 1 }))}
            getKey={(line) => String(line.number)}
            renderItem={(line) => {
              const ending = line.text.endsWith('\r\n')
                ? 'CRLF'
                : line.text.endsWith('\n')
                  ? 'LF'
                  : t('fileReview.noNewline');
              return (
                <div className={`file-review-line file-review-line-${line.kind}`}>
                  <code>
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                    {line.text}
                  </code>
                  <abbr
                    className="file-review-ending"
                    title={t('fileReview.lineEnding', { 0: ending })}
                  >
                    {ending}
                  </abbr>
                </div>
              );
            }}
          />
        </section>
      )}
    </>
  );
}

function Panel({ scope, onClose }: { scope: TranscriptScope; onClose: () => unknown }) {
  const runtime = useRuntime();
  const [view, setView] = useState<ReviewPage>();
  const report = useRef<ReviewPage | undefined>(undefined);
  const [side, setSide] = useState<'changes' | 'before' | 'after'>('changes');
  const [unchanged, setUnchanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey>();
  const epoch = useRef(0);
  const read = useCallback(
    async (cursor?: string) => {
      const ticket = ++epoch.current;
      setBusy(true);
      setError(undefined);
      if (!cursor) {
        report.current = undefined;
        setView(undefined);
      }
      try {
        const value = await runtime.command({
          type: 'files.review.read',
          query: { scope, ...(cursor ? { cursor } : {}) },
        });
        if (ticket !== epoch.current) return;
        if (!isReviewPage(value) || !sameTranscriptScope(value.scope, scope))
          throw Error('INVALID_FILE_REVIEW');
        const previous = report.current;
        // Pagination belongs to one immutable report; a refresh retires every pending page from the old generation.
        if (
          cursor &&
          (!previous ||
            previous.next !== cursor ||
            previous.revision !== value.revision ||
            (['created', 'modified', 'deleted', 'unchanged', 'unknown'] as const).some(
              (kind) => previous.counts[kind] !== value.counts[kind],
            ) ||
            (previous.items.length > 0 &&
              value.items.length > 0 &&
              compareReviewPaths(
                reviewFileKey(previous.items.at(-1)!.before),
                reviewFileKey(value.items[0].before),
              ) >= 0))
        )
          throw Error('STALE_FILE_REVIEW');
        const next = {
          ...value,
          items: cursor ? [...previous!.items, ...value.items] : value.items,
        };
        report.current = next;
        setView(next);
      } catch (error) {
        if (ticket === epoch.current) setError(errorKey(error));
      } finally {
        if (ticket === epoch.current) setBusy(false);
      }
    },
    [runtime.command, scope],
  );
  useEffect(() => {
    read().catch(() => setError('fileReview.readFailed'));
    return () => {
      epoch.current++;
    };
  }, [read]);
  const items =
    view?.items.filter((item) => side !== 'changes' || unchanged || item.kind !== 'unchanged') ??
    [];
  const noChanges =
    view?.state === 'complete' &&
    view.counts.created + view.counts.modified + view.counts.deleted + view.counts.unknown === 0 &&
    !!view.before?.length &&
    !!view.after?.length &&
    [...view.before, ...view.after].every((item) => item.capture === 'complete');
  const incompleteBaseline =
    view?.state === 'recording' &&
    (!view.before?.length || view.before.some((item) => item.capture !== 'complete'));
  return (
    <Dialog title={t('fileReview.title')} onClose={onClose} wide className="file-review">
      <p className="field-help">{t('fileReview.boundary')}</p>
      <p className="field-help">{t('fileReview.attribution')}</p>
      <button
        type="button"
        className="secondary"
        aria-busy={busy}
        onClick={() => read().catch(() => setError('fileReview.readFailed'))}
      >
        {t('fileReview.refresh')}
      </button>
      {busy && <p role="status">{t('fileReview.loading')}</p>}
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
      {view && (
        <>
          <div className="file-review-heading">
            <p>{t('fileReview.revision', { 0: view.revision })}</p>
            <p role="status">
              {t(incompleteBaseline ? 'fileReview.baselineIncomplete' : stateKeys[view.state])}
            </p>
          </div>
          {view.reasons.map((reason) => (
            <p className="field-help" key={reason}>
              {t(reasonKeys[reason])}
            </p>
          ))}
          {view.state === 'unavailable' ? (
            <p>{t('fileReview.unavailable')}</p>
          ) : view.state === 'expired' ? (
            <p>{t('fileReview.expired')}</p>
          ) : (
            <>
              <p className="field-help">
                {t('fileReview.writers', { 0: t(`fileReview.writers.${view.writers}`) })}
              </p>
              <p className="field-help">
                {t('fileReview.effects', { 0: t(`fileReview.coverage.${view.effects}`) })}
              </p>
              <div className="file-review-snapshots">
                <Snapshots side="before" items={view.before} />
                <Snapshots side="after" items={view.after} />
              </div>
              <dl className="file-review-counts">
                {(['created', 'modified', 'deleted', 'unchanged', 'unknown'] as const).map(
                  (kind) => (
                    <div key={kind}>
                      <dt>{t(`fileReview.kind.${kind}`)}</dt>
                      <dd>{view.counts[kind]}</dd>
                    </div>
                  ),
                )}
              </dl>
              <nav className="file-review-actions" aria-label={t('fileReview.title')}>
                {(['changes', 'before', 'after'] as const).map((tab) => (
                  <button
                    type="button"
                    key={tab}
                    className="text-button"
                    aria-pressed={side === tab}
                    onClick={() => setSide(tab)}
                  >
                    {t(`fileReview.${tab}`)}
                  </button>
                ))}
              </nav>
              {side === 'changes' && (
                <label className="file-review-toggle">
                  <input
                    type="checkbox"
                    checked={unchanged}
                    onChange={(event) => setUnchanged(event.target.checked)}
                  />
                  {t('fileReview.unchanged')}
                </label>
              )}
              <WindowList
                tag="ul"
                className="file-review-items"
                scope={`${JSON.stringify(scope)}:${view.revision}:${side}`}
                items={items}
                getKey={(item) => `${item.before.area}:${item.before.path}`}
                renderItem={(item) => (
                  <li>
                    <Item
                      key={`${view.revision}:${reviewFileKey(item.before)}`}
                      change={item}
                      side={side}
                      query={{
                        scope,
                        revision: view.revision,
                        area: item.before.area,
                        path: item.before.path,
                      }}
                    />
                  </li>
                )}
              />
              {!items.length && (
                <p className="field-help">
                  {t(noChanges ? 'fileReview.noChanges' : 'fileReview.empty')}
                </p>
              )}
              {view.next && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => read(view.next).catch(() => setError('fileReview.readFailed'))}
                >
                  {t('fileReview.more')}
                </button>
              )}
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

function Review({ scope }: { scope: TranscriptScope }) {
  const runtime = useRuntime();
  const [target] = useState(() => structuredClone(scope));
  const [open, setOpen] = useState(false);
  const disabled =
    !runtime.enabled ||
    runtime.snapshot.phase !== 'ready' ||
    !runtime.snapshot.fileReview?.available ||
    !isTranscriptScope(target);
  const reason = !isTranscriptScope(target)
    ? 'fileReview.noScope'
    : runtime.snapshot.phase !== 'ready'
      ? 'fileReview.offline'
      : 'fileReview.unsupported';
  return (
    <>
      <button
        type="button"
        className="context-trigger"
        disabled={disabled}
        title={disabled ? t(reason) : undefined}
        onClick={() => setOpen(true)}
      >
        <Files size={14} aria-hidden="true" />
        {t('fileReview.title')}
      </button>
      {open && <Panel scope={target} onClose={() => setOpen(false)} />}
    </>
  );
}

export function FileReview({ scope }: { scope: TranscriptScope }) {
  useLocale();
  const target = reviewTarget(useRemote().state);
  return <Review key={JSON.stringify([target, scope])} scope={scope} />;
}
