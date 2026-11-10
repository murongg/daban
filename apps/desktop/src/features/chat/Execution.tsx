import {
  type GoalProgress,
  isModelAttempts,
  isRunStatistics,
  isTranscriptContent,
  isTranscriptPage,
  localCodexModel,
  type ModelAttempt,
  modelCatalog,
  type ReplyStream,
  type SessionStats,
  sameTranscriptScope,
  type TaskPhase,
  type TranscriptContent,
  type TranscriptItem,
  type TranscriptPage,
  type TranscriptScope,
} from '@daban/protocol';
import { ChevronDown, Info, ListChecks, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, runtimeMessage as taskError, useRuntime } from '../../app/Runtime';
import { IconButton } from '../../components/controls/Button';
import { Tooltip } from '../../components/controls/Tooltip';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import { taskPhase } from '../../i18n/tasks';

const failureLabels: Record<NonNullable<ModelAttempt['failure']>, MessageKey> = {
  auth: 'models.failure.auth',
  quota: 'models.failure.quota',
  'rate-limit': 'models.failure.rateLimit',
  unavailable: 'models.failure.unavailable',
  timeout: 'models.failure.timeout',
  unknown: 'models.failure.unknown',
};
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
  workspace_shell: 'execution.runCommand',
  screenshot: 'execution.observeScreen',
  act: 'execution.controlComputer',
  open_app: 'execution.openApplication',
  todo_write: 'execution.updatePlan',
  ask_user_question: 'execution.ask',
  skill: 'execution.loadSkill',
  run_code: 'execution.runProgram',
  get_goal: 'execution.readGoal',
  create_goal: 'execution.createGoal',
  update_goal: 'execution.updateGoal',
  subagent: 'execution.delegateTask',
  send_message: 'execution.messageWorker',
  interrupt_agent: 'execution.stopWorker',
};
function label(item: TranscriptItem, name?: string) {
  const tool = name ? t(tools[name.split('__').at(-1)!]) || name : t('execution.tool');
  if (item.kind === 'call') return t('execution.toolCall', { 0: tool });
  if (item.kind === 'result')
    return `${tool} · ${item.isError ? t('common.failed') : t('execution.result')}`;
  return {
    assistant: t('execution.interimResponse'),
    thinking: t('execution.thinking'),
    plan: t('execution.taskPlan'),
    interaction: t('execution.questionsApprovals'),
  }[item.kind];
}

function ThinkingText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 240;
  return (
    <>
      <p className="execution-thinking-text">
        {long && !expanded ? `${text.slice(0, 240)}…` : text}
      </p>
      {long && (
        <button
          type="button"
          className="text-button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {t(expanded ? 'execution.collapseThinking' : 'execution.expandThinking')}
        </button>
      )}
    </>
  );
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
          {item.kind === 'thinking' ? <ThinkingText text={content.text} /> : content.text}
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
  if (item.kind === 'thinking')
    return (
      <li className="execution-thinking">
        <p className="execution-thinking-label">{t('execution.thinking')}</p>
        <Content scope={scope} item={item} />
      </li>
    );
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

function Statistics({ scope, refresh }: { scope: TranscriptScope; refresh?: TranscriptPage }) {
  useLocale();
  const runtime = useRuntime();
  const [stats, setStats] = useState<SessionStats>();
  useEffect(() => {
    if (!refresh) return;
    let active = true;
    runtime
      .command({ type: 'transcript.statistics', query: { scope } })
      .then((value) => {
        if (active && isRunStatistics(value) && sameTranscriptScope(value, scope))
          setStats(value.stats);
      })
      .catch(() => {
        // Older services have no statistics route. Optional telemetry must not break execution-history reads.
        if (active) setStats(undefined);
      });
    return () => {
      active = false;
    };
  }, [runtime.command, scope, refresh]);
  return stats ? (
    <p className="field-help">
      {t('execution.sessionStatistics', {
        0: stats.turns,
        1: stats.steps,
        2: (stats.llmMs / 1000).toFixed(1),
        3: (stats.toolMs / 1000).toFixed(1),
        4: stats.ttftSteps ? (stats.ttftMs / stats.ttftSteps / 1000).toFixed(1) : '—',
      })}
    </p>
  ) : null;
}

function Reader({
  scope,
  thinking,
}: {
  scope: TranscriptScope;
  thinking?: ReplyStream['thinking'];
}) {
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
  // A committed native step replaces its live prefix, even when both arrive in the same poll.
  const liveThinking =
    thinking?.text &&
    !page?.nextAfter &&
    !page?.items.some((item) => item.kind === 'thinking' && item.thinkingId === thinking.id)
      ? thinking
      : undefined;
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
      <Statistics scope={target} refresh={page} />
      {page?.state === 'unavailable' && (
        <p className="inline-note">{t('execution.noExecutionDetailsWereRetainedTask')}</p>
      )}
      {page?.state === 'interrupted' && (
        <p className="form-error">{t('execution.incompleteExecutionHistory')}</p>
      )}
      {page?.state === 'interrupted' && (
        <p className="field-help">{t('execution.onlySavedPortionShownDoesNotConfirm')}</p>
      )}
      {page && page.state !== 'unavailable' && !page.items.length && !liveThinking && (
        <p className="inline-note">{t('execution.noToolInteractionStepsWereRecordedTask')}</p>
      )}
      {(!!page?.items.length || !!liveThinking) && (
        <ol className="execution-list">
          {page?.items.map((item) => (
            <Entry
              key={item.seq}
              scope={target}
              item={item}
              name={item.name || names.get(item.callId)}
            />
          ))}
          {liveThinking && (
            <li className="execution-thinking" key={`thinking:${liveThinking.id}`}>
              <p className="execution-thinking-label">{t('execution.thinking')}</p>
              <ThinkingText text={liveThinking.text} />
            </li>
          )}
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

function Disclosure({
  scope,
  phase,
  elapsedMs: savedElapsed,
  thinking: savedThinking,
}: {
  scope: TranscriptScope;
  phase?: TaskPhase;
  elapsedMs?: number;
  thinking?: ReplyStream['thinking'];
}) {
  useLocale();
  const runtime = useRuntime();
  const [open, setOpen] = useState(false);
  const ready = runtime.enabled && runtime.snapshot.phase === 'ready';
  const compatible = ready && runtime.snapshot.protocolVersion >= 33;
  const active = runtime.snapshot.agents[scope.bot];
  const sameRun =
    active?.runId === scope.runId &&
    active.conversationId === scope.conversationId &&
    (scope.conversationId !== undefined || (active.chatRevision ?? 0) === scope.chatRevision);
  const planning = sameRun && active?.planning;
  const goal = sameRun ? active?.goal : undefined;
  const goalStates: Record<GoalProgress['phase'], MessageKey> = {
    active: 'execution.goalActive',
    paused: 'execution.goalPaused',
    blocked: 'execution.goalBlocked',
    complete: 'execution.goalComplete',
  };
  const goalState =
    goal?.phase === 'active' && (!active?.running || goal.activation === 'disarmed')
      ? 'execution.goalWaiting'
      : goal
        ? goalStates[goal.phase]
        : undefined;
  const preparing = compatible && phase === 'starting';
  const available = compatible && !preparing;
  const task = runtime.snapshot.agents[scope.bot];
  const current =
    task?.runId === scope.runId &&
    task.conversationId === scope.conversationId &&
    (scope.conversationId || (task.chatRevision ?? 0) === scope.chatRevision)
      ? task
      : undefined;
  const recorded =
    current ??
    task?.history.find(
      (item) =>
        item.runId === scope.runId &&
        item.conversationId === scope.conversationId &&
        (scope.conversationId || (item.chatRevision ?? 0) === scope.chatRevision),
    );
  const elapsedMs = savedElapsed ?? recorded?.elapsedMs;
  const candidate = recorded?.response;
  const turnId = recorded?.turns?.at(-1)?.id ?? recorded?.requestId;
  // A retained prefix from an earlier turn must not describe the current turn's activity.
  const response =
    candidate && (!candidate.turnId || candidate.turnId === turnId) ? candidate : undefined;
  const thinking = savedThinking ?? response?.thinking;
  const activity =
    phase === 'running' && current?.running && response?.state === 'streaming'
      ? response.text
        ? t('chat.replying')
        : thinking?.text
          ? t('chat.thinking')
          : taskPhase(phase)
      : phase
        ? taskPhase(phase)
        : '';
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
        {planning && <span className="execution-phase">{t('execution.planningMode')}</span>}
        {goal && goalState && (
          <span className="execution-phase">
            {t('execution.goalStatus', { 0: t(goalState), 1: goal.rounds, 2: goal.limit })}
          </span>
        )}

        {phase && (
          <span className="execution-phase">
            {activity}
            {elapsedMs === undefined
              ? ''
              : ` · ${t('execution.duration', { 0: Math.floor(elapsedMs / 1000) })}`}
          </span>
        )}
        <ChevronDown className="execution-chevron" />
      </summary>
      {open && goal && (
        <p className="field-help">
          {t('execution.goalObjective', { 0: goal.objective })}
          {goal.reason ? ` · ${goal.reason}` : ''}
        </p>
      )}
      {open &&
        (preparing ? (
          <p className="field-help">
            {t('execution.taskPreparingExecutionRecordsAppearWhenStarts')}
          </p>
        ) : available ? (
          <Reader scope={scope} thinking={thinking} />
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

export function Execution(props: {
  attemptSummary?: ModelAttempt[];
  scope: TranscriptScope;
  phase?: TaskPhase;
  elapsedMs?: number;
  thinking?: ReplyStream['thinking'];
  messageDetails?: boolean;
}) {
  useLocale();
  const { scope, messageDetails } = props;
  const runtime = useRuntime();
  const active = runtime.snapshot.agents[scope.bot];
  const matching =
    active?.runId === scope.runId
      ? active
      : active?.history.find((row) => row.runId === scope.runId);
  const attempts = props.attemptSummary || matching?.attemptSummary;
  const validAttempts = isModelAttempts(attempts) ? attempts : undefined;
  const latest = validAttempts?.at(-1);
  const previous = validAttempts?.at(-2);
  const models = latest && modelCatalog(runtime.snapshot.model?.connections);
  const describe = (attempt: ModelAttempt, key: 'models.actualModel' | 'models.previousModel') => {
    const name =
      attempt.model === localCodexModel
        ? t('models.localCodex')
        : models?.find((model) => model.id === attempt.model)?.name || attempt.model;
    const label = t(key, { 0: name });
    return attempt.failure ? `${label} · ${t(failureLabels[attempt.failure])}` : label;
  };
  const modelInfo = latest
    ? [
        describe(latest, 'models.actualModel'),
        ...(previous ? [describe(previous, 'models.previousModel')] : []),
        t('models.usageUnknown'),
      ].join('\n')
    : undefined;
  return (
    <div
      className={messageDetails ? 'execution-block message-details' : 'execution-block'}
      key={JSON.stringify([
        scope.bot,
        scope.runId,
        scope.chatRevision ?? null,
        scope.conversationId ?? null,
      ])}
    >
      <Disclosure {...props} />
      {modelInfo && (
        <Tooltip label={modelInfo} showOnPress>
          <button
            type="button"
            className="icon-button execution-info"
            aria-label={t('models.info')}
          >
            <Info aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
