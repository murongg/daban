import {
  agentId,
  agentTask,
  browserApprovalProtocol,
  chatAssistantProtocol,
  isModelId,
  modelRecoveryBlocked,
  type RuntimeTask,
  recoveryBlocked,
} from '@daban/protocol';
import {
  ArrowUp,
  ArrowUpToLine,
  ChevronDown,
  CornerDownRight,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { type Dispatch, useCallback, useEffect, useMemo, useRef } from 'react';
import { useRuntime } from '../../app/Runtime';
import { demoIds } from '../../app/samples';
import {
  type Action,
  type Bot,
  chatApproval,
  chatRevision,
  lifecycleRequest,
  messageQueue,
  type State,
  type WorkspaceFile,
} from '../../app/state';
import { IconButton } from '../../components/controls/Button';
import { Tooltip } from '../../components/controls/Tooltip';
import { getLocale, t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';
import { attachmentAccept, canParseDocuments } from '../files/files';
import { LocalFiles } from '../files/LocalFiles';
import { modelName as displayModel, modelIcon } from '../models/model-options';
import { Requests } from '../requests/Requests';
import { ApprovalMode } from './ApprovalMode';
import {
  chatAssistant,
  conversationModel,
  conversationPending,
  conversationState,
  draftFolders,
  draftPrompt,
  draftTextLimit,
  responderLocked,
} from './conversations';
import { DropHint } from './DropHint';
import { Excerpt } from './Excerpt';
import { Execution } from './Execution';
import { FolderReferences } from './FolderReferences';
import { useFollow } from './follow';
import { useHistory } from './history';
import { useInputs } from './inputs';
import { Message } from './Message';
import { Plan } from './Plan';
import { Responder } from './Responder';
import { type DisplayMessage, visibleMessages } from './response';
import { Transcript, type TranscriptEntry } from './Transcript';

function resizeDraft(editor: HTMLTextAreaElement) {
  editor.style.height = 'auto';
  editor.style.height = `${Math.min(160, editor.scrollHeight)}px`;
}

function progress(task: RuntimeTask) {
  if (task.phase === 'waiting') return t('common.waitingReply');
  if (task.phase === 'paused') return t('chat.waitingHandBackControl');
  if (task.phase === 'starting') return t('chat.preparingResponse');
  const tool = task.trace.at(-1);
  if (tool?.phase !== 'running')
    return task.response?.state === 'streaming' && task.response.text
      ? t('chat.replying')
      : t(task.toolCount ? 'chat.usingTools' : 'chat.thinking');
  if (tool.surface === 'web')
    return tool.name === 'web_search' ? t('chat.searching') : t('chat.readingWebpage');
  if (tool.surface === 'browser') {
    const browser: Record<string, string> = {
      browser_navigate: t('chat.browsingWeb'),
      browser_snapshot: t('chat.readingPage'),
      browser_act: t('chat.interactingWebpage'),
      browser_tabs: t('chat.managingTabs'),
      browser_upload: t('chat.uploadingFile'),
      browser_download: t('chat.downloadingFile'),
    };
    return browser[tool.name] || t('chat.controllingBrowser');
  }
  if (tool.surface === 'desktop') return t('chat.controllingComputer');
  const labels: Record<string, string> = {
    skill: t('chat.loadingSkill'),
    schedule: t('chat.managingSchedules'),
    memory: t('chat.organizingWorkPreferences'),
    history: t('chat.findingHistory'),
    work: t('chat.organizingDos'),
    catalog: t('chat.readingTaskCatalog'),
  };
  return labels[tool.surface] || t('chat.usingTools');
}
export function Conversation({
  state,
  bot,
  dispatch,
  notify,
  preview,
  onModel,
  onSend,
  onQueue,
  onQueueEdit,
  onQueueRemove,
  onQueuePromote,
  onQueueInsert,
  onQueueRetry,
  onContinue,
  pending = false,
  onLifecycle,
  onNewChat,
  onExcerpt,
  onTrashRecovery,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (message: string) => unknown;
  preview: (file: WorkspaceFile) => unknown;
  onModel: () => unknown;
  onSend?: () => unknown;
  onQueue?: () => unknown;
  onQueueEdit?: (id: string) => unknown;
  onQueueRemove?: (id: string) => unknown;
  onQueuePromote?: (id: string) => unknown;
  onQueueInsert?: (id: string) => unknown;
  onQueueRetry?: (id: string) => unknown;
  onContinue?: () => unknown;
  pending?: boolean;
  onLifecycle?: () => unknown;
  onNewChat?: () => unknown;
  onExcerpt?: (draft: string) => unknown;
  onTrashRecovery?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const openLink = useCallback(
    (url: string) => runtime.command({ type: 'link.open', url }),
    [runtime.command],
  );
  const copyText = useCallback(
    (text: string) =>
      runtime.enabled
        ? runtime.command({ type: 'clipboard.write', text })
        : navigator.clipboard.writeText(text),
    [runtime.enabled, runtime.command],
  );
  const target = agentId(bot.id);
  const operation = lifecycleRequest(
    state,
    bot.id,
    runtime.snapshot.profiles.find((profile) => profile.id === target),
  );
  const lifecycleReadOnly = !!bot.archived || !!operation;
  const revision = chatRevision(state, bot.id, runtime.snapshot.chats);
  const hostCommands = runtime.snapshot.hostCommandFullAccess === true;
  const approval = chatApproval(
    state,
    bot.id,
    revision,
    runtime.snapshot.protocolVersion,
    hostCommands,
  );
  const browserApproval =
    runtime.snapshot.protocolVersion >= browserApprovalProtocol &&
    !runtime.snapshot.computerAccess &&
    runtime.snapshot.hostBrowser?.available === true;
  const trashPending = conversationPending(state, bot.id, revision);
  const trashed = conversationState(state, bot.id, revision, runtime.snapshot.chats)?.trashed;
  const readOnly = lifecycleReadOnly || !!state.chatRequests[bot.id] || !!trashPending || !!trashed;
  const recovering = recoveryBlocked(runtime.snapshot);
  const computerChanging =
    runtime.snapshot.computers?.items.some(
      (item) => item.bot === target && ['connecting', 'stopping'].includes(item.phase),
    ) === true;
  const live = runtime.enabled && !bot.members;
  const assistant = chatAssistant(state, bot);
  const unavailableAssistant = !!bot.assistant && (!assistant || assistant.archived);
  const assistantUnsupported =
    !!bot.assistant && runtime.snapshot.protocolVersion < chatAssistantProtocol;
  const chatUnsupported = bot.kind === 'chat' && runtime.snapshot.protocolVersion < 46;
  const sendBlocked =
    unavailableAssistant ||
    (live &&
      (runtime.snapshot.phase !== 'ready' ||
        !runtime.snapshot.model.configured ||
        chatUnsupported ||
        assistantUnsupported));
  const currentTask = live ? agentTask(runtime.snapshot, bot.id) : undefined;
  const task =
    currentTask?.conversationId || (currentTask?.chatRevision ?? 0) !== revision
      ? undefined
      : currentTask;
  const busyInGroup = currentTask?.running && currentTask.conversationId;
  const busyElsewhere =
    !!currentTask?.running &&
    !currentTask.conversationId &&
    (currentTask.chatRevision ?? 0) !== revision;
  const modelPicker = live && runtime.snapshot.protocolVersion >= 14;
  const preferredModel = assistant?.model ?? bot.model;
  const configuredModel =
    conversationModel(state, bot.id, revision) ||
    preferredModel ||
    (isModelId(runtime.snapshot.model.model) ? runtime.snapshot.model.model : undefined);
  const shownModel = task?.running ? task.model : configuredModel;
  const modelName = shownModel
    ? displayModel(shownModel, runtime.snapshot.model.connections)
    : task?.running
      ? t('chat.preparingModel')
      : t('chat.chooseModel');
  const nextModelName = displayModel(configuredModel, runtime.snapshot.model.connections);
  let modelLabel = modelPicker ? modelName : t('chat.chooseModel');
  if (modelPicker && shownModel === 'deepseek-v4-pro') modelLabel = 'V4 Pro';
  let modelCaption = t('chat.uiDemoNoModelConnected');
  if (runtime.enabled) {
    modelCaption = live ? t('common.generalAgent') : t('chat.groupCollaborationNotConnectedYet');
    if (modelPicker) {
      modelCaption = task?.running
        ? t('chat.task', {
            0: modelName,
            1: configuredModel !== task.model ? t('chat.nextTask', { 0: nextModelName }) : '',
          })
        : `${modelName} · ${conversationModel(state, bot.id, revision) ? t('conversations.model') : preferredModel ? t('chat.botSettings') : t('common.followWorkspace')}`;
    }
  }
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const editor = input.current;
    if (bot.kind === 'chat' && editor) {
      resizeDraft(editor);
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    }
  }, [bot.kind]);
  const refocus = useRef(false);
  useEffect(() => {
    if (pending || !refocus.current) return;
    refocus.current = false;
    input.current?.focus();
  }, [pending]);
  const { upload, attach, paste, transfer, dragging } = useInputs(
    state,
    bot,
    dispatch,
    notify,
    readOnly || pending,
  );
  const cached = useMemo(
    () =>
      live
        ? state.messages[bot.id].filter(
            (message) => !demoIds.has(message.id) && (message.chatRevision ?? 0) === revision,
          )
        : state.messages[bot.id],
    [live, state.messages, bot.id, revision],
  );
  const history = useHistory(
    state,
    bot.id,
    revision,
    live &&
      runtime.snapshot.phase === 'ready' &&
      runtime.snapshot.protocolVersion >= 29 &&
      !trashPending &&
      !trashed &&
      (bot.kind !== 'chat' ||
        cached.length > 0 ||
        runtime.snapshot.profiles.some((profile) => profile.id === target)),
  );
  const saved = useMemo(() => {
    const ids = new Set(cached.map((message) => message.id));
    return [...history.messages.filter((message) => !ids.has(message.id)), ...cached];
  }, [cached, history.messages]);
  const files = useMemo(
    () => [...new Map([...history.files, ...state.files].map((file) => [file.id, file])).values()],
    [history.files, state.files],
  );
  const entries = visibleMessages(saved, task);
  const draft = state.drafts[bot.id];
  const folders = draftFolders(state, bot.id);
  const attachments = state.attachments[bot.id]
    .map((id) => state.files.find((f) => f.id === id))
    .filter((f): f is WorkspaceFile => !!f);
  const queued = live ? messageQueue(state, bot.id) : [];
  const pendingIds = (runtime.snapshot.interactions || [])
    .filter((item) => item.bot === target && !item.conversationId && item.status === 'pending')
    .filter((item) => runtime.snapshot.protocolVersion < 46 || item.runId === task?.runId)
    .map((item) => item.id)
    .join(',');
  const scroll = useFollow(`${bot.id}:${revision}`, pendingIds);
  const currentIds = new Set(
    task?.runId ? [`runtime-result:${task.runId}`, `runtime-partial:${task.runId}`] : [],
  );
  const replyIndex = entries.findIndex((entry) => currentIds.has(entry.id));
  const turnId = task?.turns?.at(-1)?.id ?? task?.requestId;
  const userId = turnId === task?.requestId ? turnId : `inserted:${turnId}`;
  const userIndex = entries.findIndex((entry) => entry.id === userId);
  // Approval can precede the first text chunk; anchor it to its user turn instead of the end of the transcript.
  const split = replyIndex >= 0 ? replyIndex : userIndex >= 0 ? userIndex + 1 : entries.length;
  // Only the activity around the current reply moves; transcript entries keep their order.
  const earlier = entries.slice(0, split);
  const current = replyIndex < 0 ? [] : [entries[replyIndex]];
  const later = entries.slice(split + (replyIndex >= 0 ? 1 : 0));
  function send() {
    if (readOnly || recovering) return;
    // Enter submits through this handler too, so the disabled button alone cannot fence startup.
    if (sendBlocked) return;
    if (state.attachmentUploads[bot.id]) {
      notify(t('common.waitUntilAttachmentsReadySending'));
      return;
    }
    if (
      busyInGroup ||
      busyElsewhere ||
      computerChanging ||
      (!draft.trim() && !attachments.length && !folders.length)
    )
      return;
    if (task?.running && onQueue) {
      onQueue();
      input.current?.focus();
      return;
    }
    scroll.resume();
    if (onSend) {
      refocus.current = true;
      onSend();
      input.current?.focus();
      return;
    }
    dispatch({
      type: 'send',
      bot: bot.id,
      id: crypto.randomUUID(),
      time: new Date().toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }),
    });
    input.current?.focus();
  }
  const recordedByMessage = new Map(
    [...history.records, ...(currentTask?.history || [])]
      .filter(
        (item) =>
          !item.conversationId &&
          (item.chatRevision ?? 0) === revision &&
          item.runId !== task?.runId,
      )
      .map((item) => [`runtime-result:${item.runId}`, item]),
  );
  function renderMessage(message: DisplayMessage) {
    const recorded = message.role === 'bot' ? recordedByMessage.get(message.id) : undefined;
    return (
      <Message
        key={message.id}
        message={message}
        author={state.bots.find((item) => item.id === message.author) || bot}
        showAuthor={!!bot.members}
        files={files}
        target={target}
        revision={revision}
        recordedRun={recorded?.runId}
        recordedPhase={recorded?.phase}
        recordedElapsed={recorded?.elapsedMs}
        recordedThinking={recorded?.response?.thinking}
        dispatch={dispatch}
        preview={preview}
        openLink={openLink}
        copyText={copyText}
        notify={notify}
      />
    );
  }
  function messageRow(message: DisplayMessage): TranscriptEntry {
    return {
      id: `message:${message.id}`,
      content: renderMessage(message),
      bubbleKey:
        message.role === 'user' || message.role === 'bot'
          ? message.id.replace(/^runtime-partial:/, 'runtime-result:')
          : undefined,
    };
  }
  const rows: TranscriptEntry[] = [];
  if (history.loading || history.error || (entries.length && history.more))
    rows.push({
      id: 'older',
      anchor: false,
      content: (
        <div className="history-loader">
          {history.loading ? (
            <p className="muted" role="status">
              {t('common.loading')}
            </p>
          ) : (
            <button
              type="button"
              className="text-button"
              disabled={history.busy}
              onClick={history.load}
            >
              {history.busy
                ? t('common.loading')
                : history.error
                  ? t('chat.retryHistory')
                  : t('chat.loadEarlierMessages')}
            </button>
          )}
          {history.error && (
            <p className="form-error" role="alert">
              {history.error}
            </p>
          )}
        </div>
      ),
    });
  if (entries.length) {
    rows.push({
      id: 'date',
      anchor: false,
      content: (
        <div className="message-date">
          {live ? t('chat.localTasksConversations') : t('chat.todayExampleConversation')}
        </div>
      ),
    });
    rows.push(...earlier.map(messageRow));
  } else if (!history.loading)
    rows.push({
      id: 'empty',
      anchor: false,
      content: (
        <div className="empty-chat">
          {bot.kind === 'chat' ? (
            <MessageSquare className="chat-symbol" aria-hidden="true" />
          ) : (
            <Avatar bot={bot} size="large" />
          )}
          <h2>
            {bot.kind === 'chat'
              ? t('conversations.startTitle')
              : t('chat.collaborateWith', { 0: bot.name })}
          </h2>
          <p>
            {bot.kind === 'chat'
              ? t('conversations.startHint')
              : bot.role || t('chat.giveBotGoalStartFirstMessage')}
          </p>
          <div className="suggestions">
            {[
              t('chat.organizeReferenceMaterials'),
              t('chat.exploreIdeaTogether'),
              t('chat.planTodaySWork'),
            ].map((text) => (
              <button
                type="button"
                key={text}
                onClick={() => {
                  dispatch({ type: 'draft', bot: bot.id, text });
                  input.current?.focus();
                }}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      ),
    });
  const executionBelow = task?.phase === 'completed' && current.length > 0;
  // Keep the same row key when the disclosure moves from the live status to the completed reply.
  const executionRow: TranscriptEntry | undefined = task?.runId
    ? {
        id: `execution:${task.runId}`,
        persistent: true,
        content: (
          <Execution
            scope={{ bot: target, runId: task.runId, chatRevision: revision }}
            phase={task.phase}
            messageDetails={task.running || executionBelow}
          />
        ),
      }
    : undefined;
  if (executionRow && !task?.running && !executionBelow) rows.push(executionRow);
  const replyRows: TranscriptEntry[] = current.map((message) => ({
    ...messageRow(message),
    persistent: !!task?.running,
  }));
  if (executionRow && executionBelow) replyRows.push(executionRow);
  if (pendingIds) rows.push(...replyRows);
  if (live && task?.plan)
    rows.push({
      id: `plan:${task.runId}`,
      persistent: task.running,
      content: <Plan items={task.plan} active={task.running && task.phase === 'running'} />,
    });
  if (live)
    rows.push({
      id: 'requests',
      persistent: true,
      content: (
        <div ref={scroll.attention}>
          <Requests
            state={state}
            dispatch={dispatch}
            notify={notify}
            bot={bot.id}
            runs={
              runtime.snapshot.protocolVersion >= 46 ? (task?.runId ? [task.runId] : []) : undefined
            }
          />
        </div>
      ),
    });
  if (!pendingIds) rows.push(...replyRows);
  if (task?.running) {
    rows.push({
      id: 'progress',
      anchor: false,
      content: (
        <div className="message-progress" role="status">
          <Avatar bot={bot} size="small" />
          <span
            className="message-progress-label"
            data-active={task.phase === 'running' || task.phase === 'starting' ? true : undefined}
          >
            {progress(task)}
          </span>
          {task.executedCount > 0 && (
            <span>
              {t('chat.toolCalled')}
              {task.executedCount}
              {t('chat.times')}
            </span>
          )}
        </div>
      ),
    });
    if (executionRow) rows.push(executionRow);
  }
  rows.push(...later.map(messageRow));
  return (
    <section className="conversation" aria-label={t('common.conversation', { 0: bot.name })}>
      <Transcript
        scope={`${bot.id}:${revision}`}
        entries={rows}
        scroll={scroll}
        loading={history.loading || history.busy}
      />
      <div className="composer-wrap">
        {onExcerpt && <Excerpt viewport={scroll.viewport} open={onExcerpt} />}
        {live &&
          bot.kind === 'chat' &&
          (runtime.snapshot.phase !== 'ready' || chatUnsupported || assistantUnsupported) && (
            <p className="inline-note" role="status">
              {t(
                runtime.snapshot.phase !== 'ready'
                  ? 'conversations.connectToSend'
                  : assistantUnsupported && !chatUnsupported
                    ? 'conversations.assistantUpgrade'
                    : 'conversations.updateToSend',
              )}
            </p>
          )}
        {unavailableAssistant && (
          <p className="inline-note" role="status">
            {t('conversations.assistantUnavailable')}
          </p>
        )}
        {busyElsewhere && (
          <div className="live-task" role="status">
            <span>{t('conversations.otherTask')}</span>
            <button
              type="button"
              onClick={() =>
                dispatch({
                  type: 'chat-select',
                  bot: bot.id,
                  revision: currentTask.chatRevision ?? 0,
                })
              }
            >
              {t('conversations.openRunning')}
            </button>
          </div>
        )}
        {!!state.chatRequests[bot.id] && (
          <div className="archive-banner">
            <p>{t('chat.conversationActionNeedsVerificationHistoryDraftsRetained')}</p>
            {onNewChat && (
              <button type="button" className="secondary" onClick={onNewChat}>
                {t('common.verifyConversationAction')}
              </button>
            )}
          </div>
        )}
        {(trashPending || trashed) && (
          <div className="archive-banner">
            <p>{t(trashPending ? 'trash.pending' : 'trash.trashed')}</p>
            {onTrashRecovery && (
              <button type="button" className="secondary" onClick={onTrashRecovery}>
                {t('trash.title')}
              </button>
            )}
          </div>
        )}
        {lifecycleReadOnly && (
          <div className="archive-banner">
            <p>
              {operation
                ? t('chat.verifyBotOperationResultSendingNewTask')
                : t('chat.botArchivedHistoryUnsentDraftsRetained')}
            </p>
            {onLifecycle && (
              <button type="button" className="secondary" onClick={onLifecycle}>
                {operation ? t('chat.verifyBotState') : t('common.restoreBot')}
              </button>
            )}
          </div>
        )}
        {busyInGroup && (
          <div className="live-task" role="status">
            <span>{t('common.workingGroupTask')}</span>
            <button type="button" onClick={() => dispatch({ type: 'select', bot: busyInGroup })}>
              {t('chat.openGroup')}
            </button>
          </div>
        )}

        {live &&
          task &&
          !task.running &&
          ['failed', 'stopped', 'interrupted'].includes(task.phase) &&
          task.prompt && (
            <div className="live-task" role="status">
              <span>
                {t(
                  modelRecoveryBlocked(task)
                    ? 'models.unknownToolRecovery'
                    : 'chat.taskInterruptedSavedFilesRetained',
                )}
              </span>
              {!modelRecoveryBlocked(task) && (
                <button
                  type="button"
                  disabled={pending || runtime.snapshot.phase !== 'ready'}
                  onClick={onContinue}
                >
                  {t(task.attemptSummary ? 'models.recoverSelected' : 'chat.continueWorking')}
                </button>
              )}
            </div>
          )}
        {live && task?.running && (
          <div className="live-task">
            <IconButton
              className="task-stop"
              label={t('chat.stopTask')}
              onClick={() =>
                runtime
                  .command({ type: 'task.stop', bot: target! })
                  .catch((error) => notify(String(error)))
              }
            >
              <Square fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </IconButton>
          </div>
        )}
        {pending && (
          <div className="live-task" role="status">
            <span>{t('chat.verifyingWhetherTaskStarted')}</span>
            <button type="button" onClick={onSend}>
              {t('common.retrySend')}
            </button>
          </div>
        )}
        {live && queued.length > 0 && (
          <section className="message-queue" aria-label={t('chat.messageQueue')} aria-live="polite">
            <ul>
              {queued.map((item, index) => {
                const text =
                  draftPrompt(item.prompt, item.folders) ||
                  t('common.reviewFilesCompleteTaskIDescribed');
                return (
                  <li
                    className="queued-message"
                    key={item.id}
                    data-failed={item.error || undefined}
                    data-sending={item.sending || undefined}
                    data-verifying={item.verify ? true : undefined}
                  >
                    <CornerDownRight className="queued-message-glyph" aria-hidden="true" />
                    <div className="queued-message-copy">
                      <div className="queued-message-line">
                        <p title={text}>{text}</p>
                        {item.files.length > 0 && (
                          <span className="queued-message-count">
                            {t('chat.queuedAttachments', { 0: item.files.length })}
                          </span>
                        )}
                      </div>
                      {item.verify ? (
                        <span className="queued-message-error" role="status">
                          {t('chat.verifyingQueuedMessageInsert')}
                        </span>
                      ) : item.sending ? (
                        <span className="queued-message-status" role="status">
                          {t('chat.sendingQueuedMessage')}
                        </span>
                      ) : (
                        item.error && (
                          <span className="queued-message-error" role="status">
                            {t('chat.queuedMessageFailed')}
                          </span>
                        )
                      )}
                    </div>
                    <div className="queued-message-actions">
                      {onQueueInsert &&
                        task?.running &&
                        !item.files.length &&
                        !item.verify &&
                        !item.sending && (
                          <IconButton
                            className="queued-steer"
                            label={t('chat.insertQueuedMessage', { 0: text })}
                            onClick={() => onQueueInsert(item.id)}
                          >
                            <CornerDownRight />
                            <span>{t('chat.steer')}</span>
                          </IconButton>
                        )}
                      {index > 0 && onQueuePromote && !item.verify && !item.sending && (
                        <IconButton
                          label={t('chat.promoteQueuedMessage', { 0: text })}
                          onClick={() => onQueuePromote(item.id)}
                        >
                          <ArrowUpToLine />
                        </IconButton>
                      )}
                      {item.error && !item.verify && !item.sending && onQueueRetry && (
                        <IconButton
                          label={t('common.retrySend')}
                          onClick={() => onQueueRetry(item.id)}
                        >
                          <RotateCcw />
                        </IconButton>
                      )}
                      {onQueueEdit && !item.verify && !item.sending && (
                        <IconButton
                          label={t('chat.editQueuedMessage', { 0: text })}
                          onClick={() => {
                            onQueueEdit(item.id);
                            input.current?.focus();
                          }}
                        >
                          <Pencil />
                        </IconButton>
                      )}
                      {onQueueRemove && !item.verify && !item.sending && (
                        <IconButton
                          label={t('chat.removeQueuedMessage', { 0: text })}
                          onClick={() => onQueueRemove(item.id)}
                        >
                          <Trash2 />
                        </IconButton>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <form
          {...transfer}
          className="composer"
          data-dragging={dragging ? 'files' : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          {dragging && <DropHint />}
          {(attachments.length > 0 || folders.length > 0) && (
            <div className="attachments">
              <FolderReferences
                folders={folders}
                disabled={readOnly || pending}
                onRemove={(folder) =>
                  dispatch({ type: 'draft-folder-remove', bot: bot.id, revision, folder })
                }
              />
              {attachments.map((file) => (
                <span className="attachment" key={file.id}>
                  <Paperclip />
                  <button
                    type="button"
                    className="attachment-open"
                    aria-label={t('chat.previewAttachment', { 0: file.name })}
                    onClick={() => preview(file)}
                  >
                    {file.name}
                  </button>
                  <button
                    type="button"
                    aria-label={t('common.removeAttachment', { 0: file.name })}
                    disabled={readOnly}
                    onClick={() => dispatch({ type: 'detach', bot: bot.id, file: file.id })}
                  >
                    <X />
                  </button>
                </span>
              ))}
            </div>
          )}
          {state.attachmentUploads[bot.id] && (
            <p className="inline-note" role="status">
              {t('common.preparingAttachments')}
            </p>
          )}
          <textarea
            ref={input}
            aria-label={t('common.sendMessage')}
            placeholder={
              bot.kind === 'chat'
                ? t('conversations.placeholder')
                : t('chat.messageRecipient', { 0: bot.name })
            }
            value={draft}
            maxLength={draftTextLimit(folders)}
            rows={2}
            disabled={pending}
            readOnly={readOnly}
            onPaste={paste}
            onChange={(e) => {
              dispatch({ type: 'draft', bot: bot.id, text: e.target.value });
              resizeDraft(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-bottom">
            {!bot.members && (
              <LocalFiles key={target} bot={target} disabled={readOnly || pending} />
            )}
            <IconButton
              label={t('common.addAttachment')}
              title={
                canParseDocuments(runtime.snapshot) ? undefined : t('files.nativeAttachmentHint')
              }
              disabled={readOnly || pending || state.attachmentUploads[bot.id]}
              onClick={() => upload.current?.click()}
            >
              <Plus />
            </IconButton>
            <input
              className="sr-only"
              ref={upload}
              type="file"
              accept={attachmentAccept(runtime.snapshot)}
              multiple
              disabled={readOnly || pending || state.attachmentUploads[bot.id]}
              onChange={async (e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = '';
                await attach(files);
              }}
              tabIndex={-1}
              aria-label={t('common.chooseAttachment')}
            />
            {bot.kind === 'chat' && (
              <Responder
                chat={bot}
                bots={state.bots}
                assistant={assistant}
                locked={responderLocked(state, bot.id) || !!currentTask}
                disabled={readOnly || pending}
                dispatch={dispatch}
              />
            )}
            <Tooltip
              label={
                modelPicker
                  ? `${task?.running ? t('chat.modelTask') : t('chat.modelNextTask')}：${modelName}`
                  : undefined
              }
            >
              <button
                type="button"
                className="model-label"
                disabled={readOnly}
                onClick={onModel}
                aria-label={modelPicker ? t('chat.botModel', { 0: modelName }) : undefined}
              >
                {modelPicker && modelIcon(shownModel, runtime.snapshot.model.connections)}
                <span>{modelLabel}</span>
                <ChevronDown />
              </button>
            </Tooltip>
            {live && runtime.snapshot.protocolVersion >= 44 && (
              <ApprovalMode
                value={approval.approvalMode ?? 'auto'}
                browserApproval={browserApproval}
                browserGranted={approval.browserAutoStart}
                hostCommands={hostCommands}
                hostGranted={approval.hostCommandFullAccess}
                disabled={readOnly || pending || recovering}
                onChange={(mode) =>
                  dispatch({
                    type: 'approval-mode',
                    bot: bot.id,
                    revision,
                    mode,
                    browserAutoStart: browserApproval,
                    hostCommandFullAccess: hostCommands,
                  })
                }
              />
            )}
            <span className="spacer" />
            <button
              type="submit"
              className="send-button"
              aria-label={t('common.sendMessage')}
              disabled={
                readOnly ||
                recovering ||
                pending ||
                state.attachmentUploads[bot.id] ||
                computerChanging ||
                !!busyInGroup ||
                busyElsewhere ||
                (!draft.trim() && !attachments.length && !folders.length) ||
                sendBlocked
              }
            >
              <ArrowUp />
            </button>
          </div>
        </form>
        <div className="composer-hints">
          <span>
            {task?.running
              ? t('chat.enterQueuesMessage')
              : t('common.enterSendShiftEnterNewLinePaste')}
          </span>
          <span>{modelCaption}</span>
        </div>
      </div>
    </section>
  );
}
