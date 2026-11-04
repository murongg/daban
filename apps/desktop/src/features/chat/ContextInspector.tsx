import {
  type ContextCapture,
  type ContextQuery,
  type ContextRef,
  type ContextView,
  isContextView,
  isTranscriptContent,
  isTranscriptScope,
  sameTranscriptScope,
  type TranscriptScope,
} from '@daban/protocol';
import { ScanText } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import './context-inspector.css';

function errorKey(error: unknown): MessageKey {
  const code = error instanceof Error ? error.message : '';
  if (code === 'CONTEXT_CAPTURE_EXPIRED') return 'context.expired';
  if (code === 'CONTEXT_SOURCE_UNAVAILABLE') return 'context.sourceUnavailable';
  return 'context.readFailed';
}

function SourceText({
  scope,
  revision,
  reference,
}: {
  scope: TranscriptScope;
  revision: number;
  reference: ContextRef;
}) {
  const { command } = useRuntime();
  const [text, setText] = useState('');
  const [next, setNext] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey>();
  const epoch = useRef(0);
  const total = useRef<number | undefined>(undefined);
  const read = useCallback(
    async (offset = 0) => {
      const ticket = ++epoch.current;
      setBusy(true);
      setError(undefined);
      try {
        const value = await command({
          type: 'context.source',
          query: { scope, revision, ref: reference, offset },
        });
        if (ticket !== epoch.current) return;
        if (
          !isTranscriptContent(value) ||
          !sameTranscriptScope(value, reference.scope) ||
          value.seq !== reference.seq ||
          value.offset !== offset ||
          (total.current !== undefined && total.current !== value.total)
        )
          throw Error('INVALID_CONTEXT_SOURCE');
        total.current = value.total;
        setText((previous) => (offset === 0 ? value.text : previous + value.text));
        setNext(value.nextOffset);
      } catch (error) {
        if (ticket === epoch.current) setError(errorKey(error));
      } finally {
        if (ticket === epoch.current) setBusy(false);
      }
    },
    [command, scope, revision, reference],
  );
  useEffect(() => {
    read().catch(() => setError('context.readFailed'));
    return () => {
      epoch.current++;
    };
  }, [read]);
  return (
    <section className="context-source-text" aria-busy={busy}>
      <h3>{t('context.sourceText')}</h3>
      {error && <p role="alert">{t(error)}</p>}
      <pre className="execution-content">{text}</pre>
      {(next !== undefined || error) && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() =>
            read(error ? text.length : next).catch(() => setError('context.readFailed'))
          }
        >
          {t('context.more')}
        </button>
      )}
    </section>
  );
}

function Capture({ capture, scope }: { capture: ContextCapture; scope: TranscriptScope }) {
  const [tab, setTab] = useState<'overview' | 'sources'>('overview');
  const [reference, setReference] = useState<ContextRef>();
  const number = (value?: number | null) =>
    value === undefined || value === null ? t('context.unknown') : value.toLocaleString();
  const pressure = capture.pressure;
  const breakdown = capture.breakdown;
  const gaps: Record<ContextCapture['gaps'][number], MessageKey> = {
    'sdk-envelope': 'context.sdkGap',
    images: 'context.imageGap',
    retention: 'context.retentionGap',
    'capture-failed': 'context.captureGap',
  };
  return (
    <>
      <nav className="context-tabs" aria-label={t('context.title')}>
        <button type="button" aria-pressed={tab === 'overview'} onClick={() => setTab('overview')}>
          {t('context.overview')}
        </button>
        <button type="button" aria-pressed={tab === 'sources'} onClick={() => setTab('sources')}>
          {t('context.sources')}
        </button>
      </nav>
      {tab === 'overview' ? (
        <>
          <dl className="context-numbers">
            {(
              [
                ['context.pressure', pressure?.pressureTokens],
                ['context.projected', pressure?.projectedTokens],
                ['context.sdkWindow', pressure?.contextWindow],
                ['context.configuredWindow', capture.configuredWindow],
                ['context.configuredOutput', capture.configuredOutput],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{t(label)}</dt>
                <dd>{number(value)}</dd>
              </div>
            ))}
          </dl>
          {pressure && (
            <p className="field-help">{t('context.sample', { 0: pressure.seq, 1: pressure.at })}</p>
          )}
          <h3>{t('context.breakdown')}</h3>
          <dl className="context-numbers">
            {(['systemTokens', 'toolsTokens', 'messageTokens'] as const).map((key) => (
              <div key={key}>
                <dt>{t(`context.${key}`)}</dt>
                <dd>{number(breakdown?.[key])}</dd>
              </div>
            ))}
          </dl>
          {breakdown && (
            <p className="field-help">
              {t('context.sample', { 0: breakdown.seq, 1: breakdown.at })}
            </p>
          )}
          <p className="field-help">{t('context.sdkBoundary')}</p>
          {capture.boundary && (
            <section>
              <h3>
                {t(capture.boundary.kind === 'summary' ? 'context.summary' : 'context.prune')}
              </h3>
              <p className="field-help">
                {t('context.boundary', {
                  0: capture.boundary.endSeq,
                  1: capture.boundary.shadowedSeqs.join(', '),
                  2: capture.boundary.omittedSeqs,
                })}
              </p>
            </section>
          )}
        </>
      ) : (
        <>
          <p className="field-help">{t('context.hostMethod')}</p>
          <p className="field-help">{t('context.hostBoundary')}</p>
          <ul className="context-sources">
            {capture.sources.map((source) => (
              <li key={source.category}>
                <div className="context-source-heading">
                  <h3>{t(`context.category.${source.category}`)}</h3>
                  <span>
                    {source.hostTokens === null
                      ? t('context.unknown')
                      : source.evidence === 'not-injected'
                        ? t('context.notInjected')
                        : t('context.estimated', { 0: source.hostTokens })}
                  </span>
                </div>
                <p className="field-help">
                  {t(
                    source.membership === 'host-injected'
                      ? 'context.hostInjected'
                      : source.membership === 'saved-only'
                        ? 'context.savedOnly'
                        : 'context.unknown',
                  )}
                </p>
                <p className="field-help">
                  {t('context.savedCharacters', { 0: source.savedCharacters })}
                </p>
                <div className="context-refs">
                  {source.refs.map((ref) => (
                    <button
                      key={`${ref.scope.runId}:${ref.seq}`}
                      type="button"
                      onClick={() => setReference(ref)}
                    >
                      {t('context.sourceRef', { 0: ref.seq })}
                    </button>
                  ))}
                </div>
                {source.omittedRefs > 0 && (
                  <p className="field-help">
                    {t('context.omittedRefs', { 0: source.omittedRefs })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {reference && (
        <SourceText
          key={`${reference.scope.runId}:${reference.seq}`}
          scope={scope}
          revision={capture.revision}
          reference={reference}
        />
      )}
      <ul className="context-gaps">
        {capture.gaps.map((gap) => (
          <li key={gap}>{t(gaps[gap])}</li>
        ))}
      </ul>
    </>
  );
}

function Panel({ scope, onClose }: { scope: TranscriptScope; onClose: () => unknown }) {
  const runtime = useRuntime();
  const [query, setQuery] = useState<ContextQuery>({ scope });
  const revision = query.revision;
  const [view, setView] = useState<ContextView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey>();
  const epoch = useRef(0);
  useEffect(() => {
    const ticket = ++epoch.current;
    setView(undefined);
    setError(undefined);
    if (runtime.snapshot.phase !== 'ready' || runtime.snapshot.contextInspector !== 1) {
      setBusy(false);
      setError(runtime.snapshot.phase !== 'ready' ? 'context.offline' : 'context.unsupported');
      return;
    }
    setBusy(true);
    runtime
      .command({ type: 'context.inspect', query })
      .then((value) => {
        if (ticket !== epoch.current) return;
        if (
          !isContextView(value) ||
          !sameTranscriptScope(value.scope, query.scope) ||
          (query.revision !== undefined &&
            value.state === 'captured' &&
            value.selected.revision !== query.revision)
        )
          throw Error('INVALID_CONTEXT_VIEW');
        setView(value);
      })
      .catch((error) => {
        if (ticket === epoch.current) setError(errorKey(error));
      })
      .finally(() => {
        if (ticket === epoch.current) setBusy(false);
      });
    return () => {
      epoch.current++;
    };
  }, [runtime.command, runtime.snapshot.phase, runtime.snapshot.contextInspector, query]);
  return (
    <Dialog title={t('context.title')} onClose={onClose} wide className="context-inspector">
      <div className="context-toolbar">
        {view?.state === 'captured' && (
          <Select
            label={t('context.history')}
            value={revision === undefined ? 'latest' : String(revision)}
            onValueChange={(value) =>
              setQuery({ scope, ...(value === 'latest' ? {} : { revision: Number(value) }) })
            }
            options={[
              { value: 'latest', label: t('context.latest') },
              ...view.revisions.map((item) => ({
                value: String(item),
                label: t('context.captured', { 0: item }),
              })),
            ]}
          />
        )}
        <button
          type="button"
          className="secondary"
          aria-busy={busy}
          onClick={() => {
            setQuery({ scope });
          }}
        >
          {t('context.refresh')}
        </button>
      </div>
      {busy && <p role="status">{t('context.loading')}</p>}
      {error && <p role="alert">{t(error)}</p>}
      {view?.state === 'unavailable' && (
        <p role="status">
          {t(
            view.reason === 'legacy'
              ? 'context.legacy'
              : view.reason === 'not-captured'
                ? 'context.notCaptured'
                : 'context.unavailable',
          )}
        </p>
      )}
      {view?.state === 'captured' && (
        <>
          <p className="field-help">{t('context.partial', { 0: view.selected.at })}</p>
          {revision !== undefined && <p>{t('context.captured', { 0: view.selected.revision })}</p>}
          {view.health === 'capture-failed' && <p role="status">{t('context.failed')}</p>}
          <Capture key={view.selected.revision} capture={view.selected} scope={scope} />
        </>
      )}
    </Dialog>
  );
}

function Inspector({ scope }: { scope: TranscriptScope }) {
  const runtime = useRuntime();
  const [target] = useState(() => structuredClone(scope));
  const [open, setOpen] = useState(false);
  const disabled =
    !runtime.enabled ||
    runtime.snapshot.phase !== 'ready' ||
    runtime.snapshot.contextInspector !== 1 ||
    !isTranscriptScope(target);
  const reason = !isTranscriptScope(target)
    ? 'context.noScope'
    : runtime.snapshot.phase !== 'ready'
      ? 'context.offline'
      : 'context.unsupported';
  return (
    <>
      <button
        type="button"
        className="context-trigger"
        disabled={disabled}
        title={disabled ? t(reason) : undefined}
        onClick={() => setOpen(true)}
      >
        <ScanText size={14} aria-hidden="true" />
        {t('context.title')}
      </button>
      {open && <Panel scope={target} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ContextInspector({ scope }: { scope: TranscriptScope }) {
  useLocale();
  return <Inspector key={JSON.stringify(scope)} scope={scope} />;
}
