import {
  type AttachmentReceipt,
  agentId,
  type GroupMessage,
  type GroupPage,
  type GroupSend,
  imageMime,
  isModelId,
  modelCatalog,
  modelHasVision,
  recoveryBlocked,
  type TaskFile,
} from '@daban/protocol';
import { ArrowUp, FileText, Paperclip, Plus, X } from 'lucide-react';
import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { IconButton } from './Button';
import { Execution } from './Execution';
import { attachment, stagedAttachment, taskFile } from './files';
import { useFollow } from './follow';
import { useInputs } from './inputs';
import { t, useLocale } from './locale';
import { Markdown } from './Markdown';
import { Plan } from './Plan';
import { Requests } from './Requests';
import { runtimeError, useRuntime } from './Runtime';
import { Select } from './Select';
import { type Action, type Bot, lifecycleRequest, type State, type WorkspaceFile } from './state';

export function GroupChat({
  state,
  bot,
  dispatch,
  notify,
  preview,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (text: string) => unknown;
  preview: (file: WorkspaceFile) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const [page, setPage] = useState<GroupPage>();
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const scroll = useFollow(bot.id);
  const catalog = runtime.snapshot.groups;
  const registered = catalog?.items.find((group) => group.id === bot.id);
  const ready =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 15 &&
    !!catalog?.available;
  const revision = catalog?.revision;
  const registeredId = registered?.id;
  const pending = state.groupRequests[bot.id];
  const readOnly = !!registered?.archived || !!bot.archived || !!state.groupActions[bot.id];
  const { upload, attach, paste, transfer, dragging } = useInputs(
    state,
    bot,
    dispatch,
    notify,
    !ready || readOnly || sending || !!pending,
  );
  const members = (registered?.members || bot.members?.map(agentId) || []).map((id) => ({
    id,
    bot: state.bots.find((bot) => !bot.members && agentId(bot.id) === id),
  }));
  const availableMembers = members.filter(
    (member) =>
      !member.bot?.archived &&
      !runtime.snapshot.profiles.find((profile) => profile.id === member.id)?.archived &&
      !(member.bot && lifecycleRequest(state, member.bot.id)),
  );
  const target = state.groupTargets[bot.id] || availableMembers[0]?.id || '';
  const validTarget =
    target === '*'
      ? availableMembers.length > 0
      : availableMembers.some((member) => member.id === target);
  const draft = state.drafts[bot.id];
  const attached = state.attachments[bot.id]
    .map((id) => state.files.find((file) => file.id === id))
    .filter((file): file is WorkspaceFile => !!file);
  const openLink = useCallback(
    (url: string) => runtime.command({ type: 'link.open', url }),
    [runtime.command],
  );
  const copyText = useCallback(
    (text: string) => runtime.command({ type: 'clipboard.write', text }),
    [runtime.command],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const accept = useCallback(
    (value: GroupPage) => {
      if (!mounted.current) return;
      setPage((current) => {
        if (!current) return value;
        if (value.revision < current.revision) return current;
        const first = value.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
        const older = current.messages.filter((message) => message.sequence < first);
        return older.length
          ? { ...value, messages: [...older, ...value.messages], nextBefore: current.nextBefore }
          : value;
      });
      dispatch({ type: 'groups', groups: [value.group] });
    },
    [dispatch],
  );
  const read = useCallback(async () => {
    try {
      const value = await runtime.command<GroupPage>({ type: 'group.read', group: bot.id });
      accept(value);
      if (mounted.current) setError('');
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    }
  }, [runtime.command, bot.id, accept]);
  // Reading never retries a pending send: only the user's explicit send action may start work.
  useEffect(() => {
    if (ready && registeredId && revision !== undefined)
      read().catch((error) => notify(runtimeError(error)));
  }, [ready, registeredId, revision, read, notify]);
  const tasks = (page?.deliveries || []).flatMap((delivery) => {
    const task = runtime.snapshot.agents[delivery.bot];
    return task?.running && task.conversationId === bot.id && task.requestId === delivery.requestId
      ? [{ delivery, task }]
      : [];
  });
  async function send() {
    if (
      sendingRef.current ||
      !ready ||
      readOnly ||
      !registered ||
      state.attachmentUploads[bot.id] ||
      recoveryBlocked(runtime.snapshot)
    )
      return;
    if (
      !pending &&
      (!validTarget || (!draft.trim() && !attached.length) || !runtime.snapshot.model.configured)
    )
      return;
    const input: GroupSend = pending || {
      revision: registered.revision,
      id: crypto.randomUUID(),
      group: bot.id,
      prompt: draft.trim() || t('common.reviewFilesCompleteTaskIDescribed'),
      recipients: target === '*' ? availableMembers.map((member) => member.id) : [target],
      files: attached.map(taskFile),
    };
    if (!pending && attached.some((file) => imageMime(file.upload?.name || file.name))) {
      const unsupported = input.recipients.some((id) => {
        const selected = state.bots.find((member) => agentId(member.id) === id);
        const model = selected?.model || runtime.snapshot.model.model;
        return (
          !isModelId(model) ||
          !modelHasVision(model, modelCatalog(runtime.snapshot.model.connections))
        );
      });
      if (unsupported) {
        notify(t('groupchat.selectedMemberSModelDoesNotSupport'));
        return;
      }
    }
    sendingRef.current = true;
    setSending(true);
    dispatch({ type: 'group-pending', group: bot.id, input });
    try {
      const value = await runtime.command<GroupPage>({ type: 'group.send', input });
      accept(value);
      dispatch({ type: 'group-sent', group: bot.id, input });
      scroll.resume();
      if (mounted.current) setError('');
    } catch (error) {
      // A lost acknowledgement retains the exact request ID and inputs across relaunch.
      if (
        error instanceof Error &&
        [
          'INVALID_GROUP_MESSAGE',
          'GROUP_MEMBER_REQUIRED',
          'GROUP_QUEUE_LIMIT',
          'GROUP_STORAGE_LIMIT',
          'GROUP_REQUEST_ID_REUSED',
          'GROUP_NOT_FOUND',
          'GROUP_ARCHIVED',
          'GROUP_CONFLICT',
          'GROUP_REVISION_REQUIRED',
          'ATTACHMENT_NOT_FOUND',
          'ATTACHMENT_TRASHED',
          'ATTACHMENT_CORRUPT',
          'INVALID_ATTACHMENT',
          'RUNTIME_TOO_OLD',
        ].includes(error.message)
      )
        dispatch({ type: 'group-clear', group: bot.id, id: input.id });
      if (mounted.current) setError(runtimeError(error));
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  }
  async function older() {
    if (!page?.nextBefore || loading) return;
    setLoading(true);
    try {
      const value = await runtime.command<GroupPage>({
        type: 'group.read',
        group: bot.id,
        before: page.nextBefore,
      });
      if (mounted.current)
        setPage((current) => {
          if (!current) return value;
          const messages = new Map(
            [...value.messages, ...current.messages].map((message) => [message.id, message]),
          );
          return {
            ...current,
            messages: [...messages.values()].sort((a, b) => a.sequence - b.sequence),
            nextBefore: value.nextBefore,
          };
        });
    } catch (error) {
      notify(runtimeError(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  async function inputFile(message: GroupMessage, name: string) {
    try {
      const file = await runtime.command<TaskFile>({
        type: 'group.input',
        group: bot.id,
        sourceId: message.sourceId,
        name,
      });
      if (typeof file.attachmentId === 'string') {
        const receipt = await runtime.command<AttachmentReceipt>({
          type: 'attachment.read',
          bot: bot.id,
          id: file.attachmentId,
        });
        preview(stagedAttachment(receipt));
      } else preview(attachment(file.name, file.content || ''));
    } catch (error) {
      notify(runtimeError(error));
    }
  }
  function message(value: GroupMessage) {
    const author = members.find((member) => member.id === value.author)?.bot;
    const files: WorkspaceFile[] = (value.files || []).map((file) => ({
      id: `runtime:${file.path}`,
      name: file.name,
      kind: file.name.split('.').at(-1)?.toUpperCase() || t('common.files'),
      size: `${(file.size / 1024).toFixed(1)} KB`,
      modified: file.modified,
      runtimePath: file.path,
      content: '',
    }));
    return (
      <article className={`message ${value.role}`} key={value.id}>
        {value.role === 'bot' && (
          <div className="message-author">
            {author && <Avatar bot={author} />}
            {value.name || author?.name || 'Bot'}
          </div>
        )}
        {value.role === 'bot' && value.runId && value.author && (
          <Execution
            scope={{ bot: value.author, runId: value.runId, conversationId: bot.id }}
            phase={value.phase}
          />
        )}
        <div className="bubble">
          {value.role === 'bot' ? (
            <Markdown
              text={value.text}
              streaming={!!value.phase && value.phase !== 'completed'}
              fileIds={files.map((file) => file.id)}
              files={files}
              preview={preview}
              openLink={openLink}
              copyText={copyText}
              notify={notify}
            />
          ) : (
            value.text
          )}
        </div>
        {value.phase && value.phase !== 'completed' && (
          <p className="inline-note">{t('groupchat.taskStatus', { 0: value.phase })}</p>
        )}
        {files.map((file) => (
          <button
            type="button"
            className="message-artifact"
            key={file.id}
            onClick={() => preview(file)}
          >
            <FileText />
            {file.name}
          </button>
        ))}
        {files.length >= 20 && (
          <p className="inline-note">{t('groupchat.eachMessageShowsUpFilesViewAll')}</p>
        )}
        {value.inputNames?.map((name) => (
          <button
            type="button"
            className="message-artifact"
            key={name}
            onClick={() => inputFile(value, name)}
          >
            <Paperclip />
            {name}
          </button>
        ))}
      </article>
    );
  }
  const sources = [...new Set((page?.messages || []).map((message) => message.sourceId))];
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
          {!!state.messages[bot.id].length && (
            <details className="activity">
              <summary>{t('groupchat.legacyLocalRecordsNotSubmittedGroupService')}</summary>
              {state.messages[bot.id].map((item) => (
                <p className="inline-note" key={item.id}>
                  {item.text}
                </p>
              ))}
            </details>
          )}
          {page?.nextBefore && (
            <button type="button" className="text-button" disabled={loading} onClick={older}>
              {loading ? t('common.loading') : t('groupchat.loadEarlierMessages')}
            </button>
          )}
          {!page?.messages.length && (
            <div className="empty-chat">
              <Avatar bot={bot} size="large" />
              <h2>{t('groupchat.startCollaborating')}</h2>
              <p>{t('groupchat.chooseRecipientsSendFirstMessageMembersWork')}</p>
            </div>
          )}
          {sources.map((sourceId) => {
            const messages = page!.messages.filter((message) => message.sourceId === sourceId);
            const deliveries = page!.deliveries.filter(
              (delivery) => delivery.sourceId === sourceId,
            );
            const rendered = new Set<string>();
            return (
              <div key={sourceId}>
                {messages.map((item) => {
                  const firstRun = item.runId && !rendered.has(item.runId) ? item.runId : undefined;
                  if (firstRun) rendered.add(firstRun);
                  return (
                    <div key={item.id}>
                      {firstRun && (
                        <Requests
                          state={state}
                          dispatch={dispatch}
                          notify={notify}
                          runs={[firstRun]}
                        />
                      )}
                      {message(item)}
                    </div>
                  );
                })}
                <Requests
                  state={state}
                  dispatch={dispatch}
                  notify={notify}
                  runs={deliveries.flatMap((delivery) =>
                    delivery.runId && !rendered.has(delivery.runId) ? [delivery.runId] : [],
                  )}
                />
                {tasks
                  .filter(({ delivery }) => delivery.sourceId === sourceId)
                  .map(({ delivery, task }) => (
                    <div key={delivery.id}>
                      <p className="message-author">
                        {members.find((member) => member.id === delivery.bot)?.bot?.name ||
                          delivery.bot}{' '}
                        ·{' '}
                        {task.phase === 'waiting'
                          ? t('common.waitingReply')
                          : task.phase === 'paused'
                            ? t('common.waitingComputerHandback')
                            : t('groupchat.processing')}
                      </p>
                      {task.plan && <Plan items={task.plan} />}
                      {task.runId && (
                        <Execution
                          scope={{ bot: delivery.bot, runId: task.runId, conversationId: bot.id }}
                          phase={task.phase}
                        />
                      )}
                      {task.response?.text && (
                        <article className="message bot" aria-live="off">
                          <div className="bubble">
                            <Markdown
                              text={task.response.text}
                              streaming={task.phase !== 'completed'}
                              openLink={openLink}
                              copyText={copyText}
                              notify={notify}
                            />
                          </div>
                        </article>
                      )}
                    </div>
                  ))}
                {deliveries.some((delivery) =>
                  ['pending', 'claimed', 'running'].includes(delivery.state),
                ) && (
                  <div className="live-task">
                    <span>
                      {t('groupchat.collaboration')}{' '}
                      {deliveries.filter((delivery) => delivery.state === 'completed').length}/
                      {deliveries.length}
                      {t('common.completed')}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          accept(
                            await runtime.command<GroupPage>({
                              type: 'group.cancel',
                              group: bot.id,
                              sourceId,
                            }),
                          );
                        } catch (error) {
                          notify(runtimeError(error));
                        }
                      }}
                    >
                      {t('groupchat.stopCollaboration')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="composer-wrap">
        {readOnly && (
          <p className="inline-note" role="status">
            {state.groupActions[bot.id]
              ? t('groupchat.groupActionNeedsVerificationHistoryDraftsRetained')
              : t('groupchat.groupArchivedHistoryDraftsRetainedRestoreSend')}
          </p>
        )}
        {!ready && (
          <p className="inline-note">
            {runtime.enabled
              ? runtime.snapshot.protocolVersion < 15
                ? t('groupchat.updateLocalRuntimeUseGroupChats')
                : t('groupchat.groupServiceNotConnected')
              : t('groupchat.groupChatRequiresLocalRuntimeConnection')}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}{' '}
            <button type="button" className="text-button" onClick={read}>
              {t('groupchat.readAgain')}
            </button>
          </p>
        )}
        {pending && (
          <div className="live-task" role="status">
            <span>{t('groupchat.sendResultUnconfirmedRetryChecksSameMessage')}</span>
            <button type="button" disabled={sending || !ready || readOnly} onClick={send}>
              {sending ? t('groupchat.confirming') : t('common.retrySend')}
            </button>
          </div>
        )}
        <form
          {...transfer}
          className="composer"
          data-dragging={dragging ? 'files' : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            send().catch((error) => notify(runtimeError(error)));
          }}
        >
          {dragging && (
            <p className="inline-note" role="status">
              {t('common.dropAddAttachments')}
            </p>
          )}
          {!!attached.length && (
            <div className="attachments">
              {attached.map((file) => (
                <span className="attachment" key={file.id}>
                  <Paperclip />
                  <button type="button" className="attachment-open" onClick={() => preview(file)}>
                    {file.name}
                  </button>
                  <IconButton
                    label={t('common.removeAttachment', { 0: file.name })}
                    disabled={readOnly}
                    onClick={() => dispatch({ type: 'detach', bot: bot.id, file: file.id })}
                  >
                    <X />
                  </IconButton>
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
            aria-label={t('common.sendMessage')}
            placeholder={t('chat.messageRecipient', { 0: bot.name })}
            value={draft}
            rows={2}
            disabled={readOnly}
            onPaste={paste}
            maxLength={12000}
            onChange={(event) => dispatch({ type: 'draft', bot: bot.id, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!pending) send().catch((error) => notify(runtimeError(error)));
              }
            }}
          />
          <div className="composer-bottom">
            <IconButton
              label={t('common.addAttachment')}
              disabled={
                !ready || readOnly || sending || !!pending || !!state.attachmentUploads[bot.id]
              }
              onClick={() => upload.current?.click()}
            >
              <Plus />
            </IconButton>
            <input
              className="sr-only"
              ref={upload}
              type="file"
              aria-label={t('common.chooseAttachment')}
              accept=".md,.txt,.csv,.json,.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp,.gif"
              multiple
              disabled={
                !ready || readOnly || sending || !!pending || !!state.attachmentUploads[bot.id]
              }
              tabIndex={-1}
              onChange={async (event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = '';
                if (!readOnly) await attach(files);
              }}
            />
            <div className="group-recipient">
              {t('groupchat.send')}{' '}
              <Select
                label={t('groupchat.send')}
                value={target}
                disabled={readOnly || sending || !!pending}
                onValueChange={(value) =>
                  dispatch({ type: 'group-target', group: bot.id, target: value })
                }
                options={[
                  ...(!validTarget
                    ? [
                        {
                          value: target,
                          label: t('groupchat.originalMemberArchivedUnavailableChooseAgain'),
                          disabled: true,
                        },
                      ]
                    : []),
                  ...members
                    .filter((member) => validTarget || member.id !== target)
                    .map((member) => ({
                      value: member.id,
                      label: `${member.bot?.name || member.id}${!availableMembers.some((entry) => entry.id === member.id) ? t('groupchat.temporarilyUnavailable') : ''}`,
                      disabled: !availableMembers.some((entry) => entry.id === member.id),
                    })),
                  ...(!validTarget && target === '*'
                    ? []
                    : [{ value: '*', label: t('groupchat.allAvailableMembersOrder') }]),
                ]}
              />
            </div>
            <span className="spacer" />
            <button
              type="submit"
              className="send-button"
              aria-label={t('common.sendMessage')}
              disabled={
                recoveryBlocked(runtime.snapshot) ||
                !ready ||
                readOnly ||
                !registered ||
                !validTarget ||
                !!pending ||
                sending ||
                !!state.attachmentUploads[bot.id] ||
                !runtime.snapshot.model.configured ||
                (!draft.trim() && !attached.length)
              }
            >
              <ArrowUp />
            </button>
          </div>
        </form>
        <div className="composer-hints">
          <span>{t('common.enterSendShiftEnterNewLinePaste')}</span>
          <span>{t('groupchat.sharedGroupConversationIndependentWorkMemory')}</span>
        </div>
      </div>
    </section>
  );
}
