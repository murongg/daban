import {
  agentId,
  agentTask,
  isDeepSeekModel,
  modelOptions,
  type RuntimeTask,
  recoveryBlocked,
} from '@daban/protocol';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ExternalLink,
  FileText,
  Info,
  Mic,
  Monitor,
  Paperclip,
  Plus,
  X,
} from 'lucide-react';
import { type Dispatch, useCallback, useEffect, useRef } from 'react';
import { Avatar } from './Avatar';
import { IconButton } from './Button';
import { demoIds } from './fixtures';
import { useInputs } from './inputs';
import { Markdown } from './Markdown';
import { Plan } from './Plan';
import { Requests } from './Requests';
import { useRuntime } from './Runtime';
import { type DisplayMessage, visibleMessages } from './response';
import {
  type Action,
  type Bot,
  chatRevision,
  lifecycleRequest,
  type State,
  type WorkspaceFile,
} from './state';

function progress(task: RuntimeTask) {
  if (task.phase === 'waiting') return '等待你的回复';
  if (task.phase === 'paused') return '等待你交还电脑';
  if (task.phase === 'starting') return '正在准备回复';
  if (task.response?.state === 'streaming' && task.response.text) return '正在回复';
  if (!task.toolCount) return '正在思考';
  const tool = task.trace.at(-1);
  if (tool?.surface === 'web') return tool.name === 'web_search' ? '正在搜索' : '正在读取网页';
  if (tool?.surface === 'browser') {
    const browser: Record<string, string> = {
      browser_navigate: '正在浏览网页',
      browser_snapshot: '正在读取页面',
      browser_act: '正在操作网页',
      browser_tabs: '正在管理标签页',
      browser_upload: '正在上传文件',
      browser_download: '正在下载文件',
    };
    return browser[tool.name] || '正在操作浏览器';
  }
  if (tool?.surface === 'desktop') return '正在操作电脑';
  const labels: Record<string, string> = {
    skill: '正在加载技能',
    schedule: '正在管理定时任务',
    memory: '正在整理工作偏好',
    history: '正在查找历史',
  };
  return labels[tool?.surface || ''] || '正在使用工具';
}
export function Conversation({
  state,
  bot,
  dispatch,
  notify,
  preview,
  onModel,
  onSend,
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
  onContinue?: () => unknown;
  pending?: boolean;
  onLifecycle?: () => unknown;
  onNewChat?: () => unknown;
}) {
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
    (isDeepSeekModel(runtime.snapshot.model.model) ? runtime.snapshot.model.model : undefined);
  const shownModel = task?.running ? task.model : configuredModel;
  const modelName =
    modelOptions.find((option) => option.id === shownModel)?.name ||
    (task?.running ? '模型准备中' : 'DeepSeek');
  const nextModelName =
    modelOptions.find((option) => option.id === configuredModel)?.name || 'DeepSeek';
  let modelLabel = 'DeepSeek';
  if (modelPicker && shownModel === 'deepseek-flash') modelLabel = 'Flash';
  if (modelPicker && shownModel === 'deepseek-v4-pro') modelLabel = 'V4 Pro';
  let modelCaption = '界面演示 · 尚未连接模型';
  if (runtime.enabled) {
    modelCaption = live ? 'DeepSeek · 通用 Agent' : '群聊协作尚未接入';
    if (modelPicker) {
      modelCaption = task?.running
        ? `本轮：${modelName}${configuredModel !== task.model ? ` · 下次任务：${nextModelName}` : ''}`
        : `${modelName} · ${bot.model ? '此 Bot 设置' : '跟随工作区'}`;
    }
  }
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const selection = useRef(bot.id);
  const previousRequest = useRef('');
  const requestStart = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
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
  const pendingIds = (runtime.snapshot.interactions || [])
    .filter((item) => item.bot === target && !item.conversationId && item.status === 'pending')
    .map((item) => item.id)
    .join(',');
  const planSize = task?.plan?.length || 0;
  const streamRevision = task?.response?.revision || 0;
  const currentIds = new Set(
    task?.runId ? [`runtime-result:${task.runId}`, `runtime-partial:${task.runId}`] : [],
  );
  const current = entries.filter((entry) => currentIds.has(entry.id));
  const earlier = entries.filter((entry) => !currentIds.has(entry.id));
  // biome-ignore lint/correctness/useExhaustiveDependencies: New requests must be visible; polling and draft edits must not steal the reader's scroll position.
  useEffect(() => {
    if (selection.current !== bot.id || (previousRequest.current && !pendingIds))
      following.current = true;
    selection.current = bot.id;
    previousRequest.current = pendingIds;
    if (pendingIds) requestStart.current?.scrollIntoView?.({ block: 'start' });
    else if (following.current) end.current?.scrollIntoView?.({ block: 'end' });
  }, [bot.id, entries.length, pendingIds, planSize, streamRevision]);
  function send() {
    if (readOnly || recovering) return;
    if (state.attachmentUploads[bot.id]) {
      notify('请等待附件准备完成后发送。');
      return;
    }
    if (busyInGroup || computerChanging || (!draft.trim() && !attachments.length)) return;
    following.current = true;
    if (onSend) {
      onSend();
      return;
    }
    dispatch({
      type: 'send',
      bot: bot.id,
      id: crypto.randomUUID(),
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
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
        <div className="bubble">
          {message.role === 'bot' ? (
            <Markdown
              text={message.text}
              streaming={!!message.streaming || !!message.incomplete}
              fileIds={message.files}
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
              ? '回复未完成'
              : task?.phase === 'waiting'
                ? '等待你的回复'
                : task?.phase === 'paused'
                  ? '等待交还电脑'
                  : '回复进行中'}
          </p>
        )}
        {message.files?.map(artifact)}
        {message.files?.includes('weekly-summary') && (
          <div className="artifact-note">
            <Check />
            草稿已就绪，等待你查看
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
            查看电脑
          </button>
        )}
      </article>
    );
  }
  return (
    <section className="conversation" aria-label={`${bot.name}的对话`}>
      <div
        className="transcript"
        role="log"
        aria-label="对话记录"
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {entries.length ? (
          <>
            <div className="message-date">{live ? '本机任务与对话' : '今天 10:24 · 示例对话'}</div>
            {earlier.map(renderMessage)}
            {pendingIds && current.map(renderMessage)}
          </>
        ) : (
          <div className="empty-chat">
            <Avatar bot={bot} size="large" />
            <h2>和{bot.name}开始协作</h2>
            <p>{bot.role || '给这位 Bot 一个目标，从第一条消息开始。'}</p>
            <div className="suggestions">
              {['帮我整理一份资料', '一起完善这个想法', '安排今天的工作'].map((text) => (
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
        {live && task?.plan && <Plan items={task.plan} />}
        {live && (
          <div ref={requestStart}>
            <Requests state={state} dispatch={dispatch} notify={notify} bot={bot.id} />
          </div>
        )}
        {!pendingIds && current.map(renderMessage)}
        <div ref={end} />
      </div>
      <div className="composer-wrap">
        {!!state.chatRequests[bot.id] && (
          <div className="archive-banner">
            <p>对话操作待核对，历史和草稿保留。</p>
            {onNewChat && (
              <button type="button" className="secondary" onClick={onNewChat}>
                核对对话操作
              </button>
            )}
          </div>
        )}
        {lifecycleReadOnly && (
          <div className="archive-banner">
            <p>
              {operation
                ? '先核对 Bot 操作结果，再发送新任务。'
                : '此 Bot 已归档，历史和未发送草稿保留。'}
            </p>
            {onLifecycle && (
              <button type="button" className="secondary" onClick={onLifecycle}>
                {operation ? '核对 Bot 状态' : '恢复 Bot'}
              </button>
            )}
          </div>
        )}
        {busyInGroup && (
          <div className="live-task" role="status">
            <span>正在群聊中处理任务</span>
            <button type="button" onClick={() => dispatch({ type: 'select', bot: busyInGroup })}>
              前往群聊
            </button>
          </div>
        )}

        {live &&
          task &&
          !task.running &&
          ['failed', 'stopped', 'interrupted'].includes(task.phase) &&
          task.prompt && (
            <div className="live-task" role="status">
              <span>任务已中断，已保存文件仍保留</span>
              <button
                type="button"
                disabled={pending || runtime.snapshot.phase !== 'ready'}
                onClick={onContinue}
              >
                继续处理
              </button>
            </div>
          )}
        {live && task?.running && (
          <div className="live-task" role="status">
            <span>{progress(task)}</span>
            {task.executedCount > 0 && <span>已调用工具 {task.executedCount} 次</span>}
            <button
              type="button"
              onClick={() =>
                runtime
                  .command({ type: 'task.stop', bot: target! })
                  .catch((error) => notify(String(error)))
              }
            >
              停止任务
            </button>
          </div>
        )}
        {pending && (
          <div className="live-task" role="status">
            <span>正在确认任务是否启动</span>
            <button type="button" onClick={onSend}>
              重试发送
            </button>
          </div>
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
              松开即可添加附件
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
                    aria-label={`预览附件 ${file.name}`}
                    onClick={() => preview(file)}
                  >
                    {file.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`移除附件 ${file.name}`}
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
              正在准备附件…
            </p>
          )}
          <textarea
            ref={input}
            aria-label="发送消息"
            placeholder={`发消息给${bot.name}…`}
            value={draft}
            maxLength={12000}
            rows={2}
            disabled={pending || task?.running}
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
              label="添加附件"
              disabled={readOnly || pending || state.attachmentUploads[bot.id]}
              onClick={() => upload.current?.click()}
            >
              <Plus />
            </IconButton>
            <input
              className="sr-only"
              ref={upload}
              type="file"
              accept=".md,.txt,.csv,.json,.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp,.gif"
              multiple
              disabled={readOnly || pending || state.attachmentUploads[bot.id]}
              onChange={async (e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = '';
                await attach(files);
              }}
              tabIndex={-1}
              aria-label="选择附件"
            />
            <button
              type="button"
              className="model-label"
              disabled={readOnly}
              onClick={onModel}
              aria-label={modelPicker ? `Bot 模型：${modelName}` : undefined}
              title={
                modelPicker
                  ? `${task?.running ? '本轮模型' : '下次任务模型'}：${modelName}`
                  : undefined
              }
            >
              {modelLabel}
              <ChevronDown />
            </button>
            <span className="spacer" />
            <IconButton
              label="语音输入（暂未接入）"
              onClick={() => notify('语音输入尚未接入，你可以先输入文字。')}
            >
              <Mic />
            </IconButton>
            <button
              type="submit"
              className="send-button"
              aria-label="发送消息"
              disabled={
                readOnly ||
                recovering ||
                pending ||
                state.attachmentUploads[bot.id] ||
                task?.running ||
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
          <span>Enter 发送 · Shift + Enter 换行 · 可粘贴图片或拖入附件</span>
          <span>{modelCaption}</span>
        </div>
      </div>
    </section>
  );
}
