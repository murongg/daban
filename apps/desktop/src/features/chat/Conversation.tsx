import { agentId, agentTask, isModelId, type RuntimeTask, recoveryBlocked } from '@daban/protocol';
import {
  ArrowUp,
  ArrowUpToLine,
  Check,
  ChevronDown,
  CornerDownRight,
  ExternalLink,
  FileText,
  Info,
  Mic,
  Monitor,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { type Dispatch, useCallback, useEffect, useRef } from 'react';
import { useRuntime } from '../../app/Runtime';
import { demoIds } from '../../app/samples';
import {
  type Action,
  type Bot,
  chatRevision,
  lifecycleRequest,
  messageQueue,
  type State,
  type WorkspaceFile,
} from '../../app/state';
import { Markdown } from '../../components/content/Markdown';
import { IconButton } from '../../components/controls/Button';
import { Tooltip } from '../../components/controls/Tooltip';
import { getLocale, t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';
import { attachmentAccept, canParseDocuments } from '../files/files';
import { modelName as displayModel, modelIcon } from '../models/model-options';
import { Requests } from '../requests/Requests';
import { Execution } from './Execution';
import { useFollow } from './follow';
import { useInputs } from './inputs';
import { Plan } from './Plan';
import { type DisplayMessage, visibleMessages } from './response';

function progress(task: RuntimeTask) {
  if (task.phase === 'waiting') return t('common.waitingReply');
  if (task.phase === 'paused') return t('chat.waitingHandBackControl');
  if (task.phase === 'starting') return t('chat.preparingResponse');
  if (task.response?.state === 'streaming' && task.response.text) return t('chat.replying');
  if (!task.toolCount) return t('chat.thinking');
  const tool = task.trace.at(-1);
  if (tool?.surface === 'web')
    return tool.name === 'web_search' ? t('chat.searching') : t('chat.readingWebpage');
  if (tool?.surface === 'browser') {
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
  if (tool?.surface === 'desktop') return t('chat.controllingComputer');
  const labels: Record<string, string> = {
    skill: t('chat.loadingSkill'),
    schedule: t('chat.managingSchedules'),
    memory: t('chat.organizingWorkPreferences'),
    history: t('chat.findingHistory'),
    work: t('chat.organizingDos'),
    catalog: t('chat.readingTaskCatalog'),
  };
  return labels[tool?.surface || ''] || t('chat.usingTools');
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
  const readOnly = lifecycleReadOnly || !!state.chatRequests[bot.id];
  const revision = chatRevision(state, bot.id, runtime.snapshot.chats);
  const recovering = recoveryBlocked(runtime.snapshot);
  const computerChanging =
    runtime.snapshot.computers?.items.some(
      (item) => item.bot === target && ['connecting', 'stopping'].includes(item.phase),
    ) === true;
  const live = runtime.enabled && !bot.members;
  const currentTask = live ? agentTask(runtime.snapshot, bot.id) : undefined;
  const task =
    currentTask?.conversationId || (currentTask?.chatRevision ?? 0) !== revision
      ? undefined
      : currentTask;
  const busyInGroup = currentTask?.running && currentTask.conversationId;
  const modelPicker = live && runtime.snapshot.protocolVersion >= 14;
  const configuredModel =
    bot.model ||
    (isModelId(runtime.snapshot.model.model) ? runtime.snapshot.model.model : undefined);
  const shownModel = task?.running ? task.model : configuredModel;
  const modelName = shownModel
    ? displayModel(shownModel, runtime.snapshot.model.connections)
    : task?.running
      ? t('chat.preparingModel')
      : t('chat.chooseModel');
  const nextModelName = displayModel(configuredModel, runtime.snapshot.model.connections);
  let modelLabel = modelPicker ? modelName : t('chat.chooseModel');
  if (modelPicker && shownModel === 'deepseek-flash') modelLabel = 'Flash';
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
        : `${modelName} · ${bot.model ? t('chat.botSettings') : t('common.followWorkspace')}`;
    }
  }
  const input = useRef<HTMLTextAreaElement>(null);
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
  const saved = live
    ? state.messages[bot.id].filter(
        (message) => !demoIds.has(message.id) && (message.chatRevision ?? 0) === revision,
      )
    : state.messages[bot.id];
  const entries = visibleMessages(saved, task);
  const draft = state.drafts[bot.id];
  const attachments = state.attachments[bot.id]
    .map((id) => state.files.find((f) => f.id === id))
    .filter((f): f is WorkspaceFile => !!f);
  const queued = live ? messageQueue(state, bot.id) : [];
  const pendingIds = (runtime.snapshot.interactions || [])
    .filter((item) => item.bot === target && !item.conversationId && item.status === 'pending')
    .map((item) => item.id)
    .join(',');
  const scroll = useFollow(`${bot.id}:${revision}`, pendingIds);
  const currentIds = new Set(
    task?.runId ? [`runtime-result:${task.runId}`, `runtime-partial:${task.runId}`] : [],
  );
  const current = entries.filter((entry) => currentIds.has(entry.id));
  const earlier = entries.filter((entry) => !currentIds.has(entry.id));
  function send() {
    if (readOnly || recovering) return;
    if (state.attachmentUploads[bot.id]) {
      notify(t('common.waitUntilAttachmentsReadySending'));
      return;
    }
    if (busyInGroup || computerChanging || (!draft.trim() && !attachments.length)) return;
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
  function artifact(id: string) {
    const file = state.files.find((f) => f.id === id);
    if (!file) return null;
    return (
      <button type="button" className="message-artifact" key={id} onClick={() => preview(file)}>
        <span className="file-symbol">
          <FileText />
        </span>
        <div>
          <div className="artifact-name">{file.name}</div>
          <div className="artifact-meta">
            {file.kind} · {file.size}
          </div>
        </div>
        <ExternalLink />
      </button>
    );
  }
  function renderMessage(message: DisplayMessage) {
    if (message.role === 'activity')
      return (
        <details className="activity" key={message.id}>
          <summary>
            <Check />
            {message.text}
            <ChevronDown className="activity-chevron" />
          </summary>
          <div className="activity-files">
            {message.files?.map((id) => {
              const file = state.files.find((f) => f.id === id);
              return (
                file && (
                  <button
                    type="button"
                    className="activity-file"
                    key={id}
                    onClick={() => preview(file)}
                  >
                    <FileText />
                    {file.name}
                  </button>
                )
              );
            })}
          </div>
        </details>
      );
    if (message.role === 'notice')
      return (
        <div className="message" key={message.id}>
          <p className="demo-message">
            <Info />
            <span>{message.text}</span>
          </p>
        </div>
      );
    const author = state.bots.find((b) => b.id === message.author) || bot;
    const recorded =
      message.role === 'bot'
        ? currentTask?.history.find(
            (item) =>
              !item.conversationId &&
              (item.chatRevision ?? 0) === revision &&
              message.id === `runtime-result:${item.runId}` &&
              item.runId !== task?.runId,
          )
        : undefined;
    return (
      <article
        className={`message ${message.role}`}
        key={message.id}
        aria-live={message.streaming ? 'off' : undefined}
      >
        {bot.members && message.role === 'bot' && (
          <div className="message-author">
            <Avatar bot={author} />
            {author.name}
          </div>
        )}
        {recorded && (
          <Execution
            scope={{ bot: target, runId: recorded.runId, chatRevision: revision }}
            phase={recorded.phase}
          />
        )}
        <div className="bubble">
          {message.role === 'bot' ? (
            <Markdown
              text={message.text}
              streaming={!!message.streaming || !!message.incomplete}
              fileIds={message.files || message.references}
              files={state.files}
              preview={preview}
              openLink={openLink}
              notify={notify}
              copyText={copyText}
            />
          ) : (
            message.text
          )}
        </div>
        {(message.streaming || message.incomplete) && (
          <p className="inline-note reply-state">
            {message.incomplete
              ? t('chat.responseIncomplete')
              : task?.phase === 'waiting'
                ? t('common.waitingReply')
                : task?.phase === 'paused'
                  ? t('common.waitingComputerHandback')
                  : t('chat.responding')}
          </p>
        )}
        {message.files?.map(artifact)}
        {message.files?.includes('weekly-summary') && (
          <div className="artifact-note">
            <Check />
            {t('chat.draftReadyReview')}
          </div>
        )}
        {message.handoff && (
          <button
            type="button"
            className="secondary"
            style={{ marginTop: 12 }}
            onClick={() => dispatch({ type: 'panel', panel: 'computer' })}
          >
            <Monitor />
            {t('chat.viewComputer')}
          </button>
        )}
      </article>
    );
  }
  return (
    <section className="conversation" aria-label={t('common.conversation', { 0: bot.name })}>
      <div
        className="transcript"
        role="log"
        aria-label={t('chat.conversationRecords')}
        aria-live="polite"
        ref={scroll.viewport}
        onScroll={scroll.onScroll}
      >
        <div className="transcript-content" ref={scroll.content}>
          {entries.length ? (
            <>
              <div className="message-date">
                {live ? t('chat.localTasksConversations') : t('chat.todayExampleConversation')}
              </div>
              {earlier.map(renderMessage)}
            </>
          ) : (
            <div className="empty-chat">
              <Avatar bot={bot} size="large" />
              <h2>
                {t('common.and')}
                {bot.name}
                {t('chat.startCollaboration')}
              </h2>
              <p>{bot.role || t('chat.giveBotGoalStartFirstMessage')}</p>
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
          )}
          {/* Keep one mounted disclosure while the reply moves around human requests. */}
          {task?.runId && (
            <Execution
              scope={{ bot: target, runId: task.runId, chatRevision: revision }}
              phase={task.phase}
            />
          )}
          {pendingIds && current.map(renderMessage)}
          {live && task?.plan && (
            <Plan items={task.plan} active={task.running && task.phase === 'running'} />
          )}
          {live && (
            <div ref={scroll.attention}>
              <Requests state={state} dispatch={dispatch} notify={notify} bot={bot.id} />
            </div>
          )}
          {!pendingIds && current.map(renderMessage)}
        </div>
      </div>
      <div className="composer-wrap">
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
              <span>{t('chat.taskInterruptedSavedFilesRetained')}</span>
              <button
                type="button"
                disabled={pending || runtime.snapshot.phase !== 'ready'}
                onClick={onContinue}
              >
                {t('chat.continueWorking')}
              </button>
            </div>
          )}
        {live && task?.running && (
          <div className="live-task" role="status">
            <span>{progress(task)}</span>
            {task.executedCount > 0 && (
              <span>
                {t('chat.toolCalled')}
                {task.executedCount}
                {t('chat.times')}
              </span>
            )}
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
                const text = item.prompt || t('common.reviewFilesCompleteTaskIDescribed');
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
          {dragging && (
            <p className="inline-note" role="status">
              {t('common.dropAddAttachments')}
            </p>
          )}
          {attachments.length > 0 && (
            <div className="attachments">
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
            placeholder={t('chat.messageRecipient', { 0: bot.name })}
            value={draft}
            maxLength={12000}
            rows={2}
            disabled={pending}
            readOnly={readOnly}
            onPaste={paste}
            onChange={(e) => {
              dispatch({ type: 'draft', bot: bot.id, text: e.target.value });
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-bottom">
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
            <span className="spacer" />
            <IconButton
              label={t('chat.voiceInputNotConnectedYet')}
              onClick={() => notify(t('chat.voiceInputNotConnectedYetCanType'))}
            >
              <Mic />
            </IconButton>
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
                (!draft.trim() && !attachments.length) ||
                !!(
                  live &&
                  (runtime.snapshot.phase !== 'ready' || !runtime.snapshot.model.configured)
                )
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
