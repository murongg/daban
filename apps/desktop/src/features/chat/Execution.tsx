import {
  isTranscriptContent,
  isTranscriptPage,
  sameTranscriptScope,
  type TaskPhase,
  type TranscriptContent,
  type TranscriptItem,
  type TranscriptPage,
  type TranscriptScope,
} from '@daban/protocol';
import { ChevronDown, ListChecks, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, runtimeMessage as taskError, useRuntime } from '../../app/Runtime';
import { IconButton } from '../../components/controls/Button';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import { taskPhase } from '../../i18n/tasks';

const tools: Record<string, MessageKey> = {
  group_directory: 'execution.groupDirectory',
  group_create: 'execution.groupCreate',
  group_history: 'execution.groupHistory',
  group_handoff: 'execution.groupHandoff',
  web_search: 'execution.searchWeb',
  web_fetch: 'execution.readWebpage',
  read_file: 'execution.readFile',
  read_image: 'execution.readImage',
  write_file: 'execution.writeFile',
  list_files: 'common.viewFiles',
  shell: 'execution.runCommand',
  screenshot: 'execution.observeScreen',
  act: 'execution.controlComputer',
  open_app: 'execution.openApplication',
  todo_write: 'execution.updatePlan',
  ask_user_question: 'execution.ask',
  skill: 'execution.loadSkill',
};
function label(item: TranscriptItem, name?: string) {
  const tool = name ? t(tools[name.split('__').at(-1)!]) || name : t('execution.tool');
  if (item.kind === 'call') return t('execution.toolCall', { 0: tool });
  if (item.kind === 'result')
    return `${tool} · ${item.isError ? t('common.failed') : t('execution.result')}`;
  return {
    assistant: t('execution.interimResponse'),
    plan: t('execution.taskPlan'),
    interaction: t('execution.questionsApprovals'),
  }[item.kind];
}

function Content({ scope, item }: { scope: TranscriptScope; item: TranscriptItem }) {
  useLocale();
  const runtime = useRuntime();
  const [content, setContent] = useState<Pick<TranscriptContent, 'text' | 'nextOffset'>>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0),
    working = useRef(false),
    saved = useRef<Pick<TranscriptContent, 'text' | 'nextOffset'> | undefined>(undefined);
  const read = useCallback(
    async (offset = 0) => {
      if (working.current) return;
      const ticket = epoch.current;
      working.current = true;
      setBusy(true);
      setError('');
      try {
        const value = await runtime.command({
          type: 'transcript.content',
          query: { scope, seq: item.seq, offset },
        });
        if (
          !isTranscriptContent(value) ||
          !sameTranscriptScope(value, scope) ||
          value.seq !== item.seq ||
          value.offset !== offset ||
          value.total !== item.characters ||
          (offset > 0 && saved.current?.nextOffset !== offset)
        )
          throw new Error('INVALID_TRANSCRIPT_CONTENT');
        if (ticket !== epoch.current) return;
        const next = {
          nextOffset: value.nextOffset,
          text: offset ? saved.current!.text + value.text : value.text,
        };
        saved.current = next;
        setContent(next);
      } catch (error) {
        if (ticket === epoch.current) setError(runtimeError(error));
      } finally {
        if (ticket === epoch.current) {
          working.current = false;
          setBusy(false);
        }
      }
    },
    [runtime.command, scope, item.seq, item.characters],
  );
  useEffect(() => {
    const ticket = ++epoch.current;
    read().catch((error) => {
      if (ticket === epoch.current) setError(runtimeError(error));
    });
    return () => {
      epoch.current++;
      working.current = false;
    };
  }, [read]);
  const regionLabel = t('execution.contentRecord', { 0: item.seq });
  return (
    <div className="execution-body">
      {content && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Long read-only output needs a named keyboard-scrollable region.
        <section className="execution-content" aria-label={regionLabel} tabIndex={0}>
          {content.text}
        </section>
      )}
      {busy && (
        <p className="inline-note" role="status">
          {t('execution.loadingContent')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {content?.nextOffset !== undefined && (
        <p className="field-help">{t('execution.onlyPartLongContentShownContinueReading')}</p>
      )}
      {(error || content?.nextOffset !== undefined) && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={async () => {
            await read(error ? (saved.current?.nextOffset ?? 0) : content?.nextOffset);
          }}
        >
          {error ? t('execution.readContentAgain') : t('execution.continueReading')}
        </button>
      )}
    </div>
  );
}

function Entry({
  scope,
  item,
  name,
}: {
  scope: TranscriptScope;
  item: TranscriptItem;
  name?: string;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details className="execution-entry" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <ChevronDown className="execution-chevron" />
          <span>{label(item, name)}</span>
          <span className="execution-sequence">{t('execution.record', { 0: item.seq })}</span>
          {item.code && <span className="form-error">{taskError(item.code)}</span>}
        </summary>
        {open && <Content scope={scope} item={item} />}
      </details>
    </li>
  );
}

function Reader({ scope }: { scope: TranscriptScope }) {
  useLocale();
  const runtime = useRuntime();
  const [target] = useState(() => ({ ...scope }));
  const [page, setPage] = useState<TranscriptPage>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0),
    working = useRef(false),
    saved = useRef<TranscriptPage | undefined>(undefined),
    failed = useRef(false);
  const read = useCallback(
    async (after = 0) => {
      if (working.current) return;
      const ticket = epoch.current;
      working.current = true;
      setBusy(true);
      setError('');
      failed.current = false;
      try {
        const value = await runtime.command({
          type: 'transcript.list',
          query: { scope: target, after },
        });
        if (
          !isTranscriptPage(value) ||
          !sameTranscriptScope(value, target) ||
          value.items.some((item) => item.seq <= after)
        )
          throw new Error('INVALID_TRANSCRIPT_PAGE');
        if (ticket !== epoch.current) return;
        const next = {
          ...value,
          items: after ? [...(saved.current?.items ?? []), ...value.items] : value.items,
        };
        saved.current = next;
        setPage(next);
      } catch (error) {
        if (ticket === epoch.current) {
          failed.current = true;
          setError(runtimeError(error));
        }
      } finally {
        if (ticket === epoch.current) {
          working.current = false;
          setBusy(false);
        }
      }
    },
    [runtime.command, target],
  );
  useEffect(() => {
    const ticket = ++epoch.current;
    const report = (error: unknown) => {
      if (ticket === epoch.current) setError(runtimeError(error));
    };
    read().catch(report);
    const timer = window.setInterval(() => {
      const current = saved.current;
      // Only follow the tail already reached by this reader; polling must never skip an unread page or reset expanded content.
      if (current?.state === 'recording' && !current.nextAfter && !failed.current)
        read(current.items.at(-1)?.seq ?? 0).catch(report);
    }, 1500);
    return () => {
      epoch.current++;
      working.current = false;
      window.clearInterval(timer);
    };
  }, [read]);
  const names = new Map(
    page?.items
      .filter((item) => item.kind === 'call' && item.callId)
      .map((item) => [item.callId, item.name]),
  );
  return (
    <div className="execution-reader">
      {/* Keep this outside summary: refreshing must never toggle the execution disclosure. */}
      <IconButton
        className="execution-refresh"
        label={error ? t('execution.readRecordsAgain') : t('execution.refreshRecords')}
        title={`${error ? t('execution.readRecordsAgain') : t('execution.refreshRecords')} · ${t('execution.readOnlyExecutionHistoryToolsNotRerun')}`}
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          await read();
        }}
      >
        <RefreshCw />
      </IconButton>
      {page?.state === 'unavailable' && (
        <p className="inline-note">{t('execution.noExecutionDetailsWereRetainedTask')}</p>
      )}
      {page?.state === 'interrupted' && (
        <p className="form-error">{t('execution.incompleteExecutionHistory')}</p>
      )}
      {page?.state === 'interrupted' && (
        <p className="field-help">{t('execution.onlySavedPortionShownDoesNotConfirm')}</p>
      )}
      {page && page.state !== 'unavailable' && !page.items.length && (
        <p className="inline-note">{t('execution.noToolInteractionStepsWereRecordedTask')}</p>
      )}
      {!!page?.items.length && (
        <ol className="execution-list">
          {page.items.map((item) => (
            <Entry
              key={item.seq}
              scope={target}
              item={item}
              name={item.name || names.get(item.callId)}
            />
          ))}
        </ol>
      )}
      {busy && !page && (
        <p className="inline-note" role="status">
          {t('execution.loadingRecords')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {page?.nextAfter && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={async () => {
            await read(page.nextAfter);
          }}
        >
          {t('execution.loadSubsequentRecords')}
        </button>
      )}
    </div>
  );
}

function Disclosure({ scope, phase }: { scope: TranscriptScope; phase?: TaskPhase }) {
  useLocale();
  const runtime = useRuntime();
  const [open, setOpen] = useState(false);
  const ready = runtime.enabled && runtime.snapshot.phase === 'ready';
  const compatible = ready && runtime.snapshot.protocolVersion >= 33;
  const preparing = compatible && phase === 'starting';
  const available = compatible && !preparing;
  return (
    <details
      className="activity execution"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <ListChecks />
        <span>{t('execution.execution')}</span>
        {phase && <span className="execution-phase">{taskPhase(phase)}</span>}
        <ChevronDown className="execution-chevron" />
      </summary>
      {open &&
        (preparing ? (
          <p className="field-help">
            {t('execution.taskPreparingExecutionRecordsAppearWhenStarts')}
          </p>
        ) : available ? (
          <Reader scope={scope} />
        ) : (
          <p className="field-help">
            {ready
              ? t('execution.updateLocalEnvironmentViewExecutionHistory')
              : t('execution.reconnectLocalEnvironmentViewExecutionHistory')}
          </p>
        ))}
    </details>
  );
}

export function Execution(props: { scope: TranscriptScope; phase?: TaskPhase }) {
  useLocale();
  const { scope } = props;
  return (
    <Disclosure
      key={JSON.stringify([
        scope.bot,
        scope.runId,
        scope.chatRevision ?? null,
        scope.conversationId ?? null,
      ])}
      {...props}
    />
  );
}
