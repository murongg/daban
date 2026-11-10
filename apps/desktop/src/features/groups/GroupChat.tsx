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
import { ArrowUp, Paperclip, Plus, X } from 'lucide-react';
import { type Dispatch, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readMentions, resolveMentions } from '../../../shared/mentions';
import { runtimeError, useRuntime } from '../../app/Runtime';
import {
  type Action,
  type Bot,
  lifecycleRequest,
  type State,
  type WorkspaceFile,
} from '../../app/state';
import { Markdown } from '../../components/content/Markdown';
import { IconButton } from '../../components/controls/Button';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';
import { draftFolders, draftPrompt, draftTextLimit } from '../chat/conversations';
import { DropHint } from '../chat/DropHint';
import { Execution } from '../chat/Execution';
import { FolderReferences } from '../chat/FolderReferences';
import { useFollow } from '../chat/follow';
import { useInputs } from '../chat/inputs';
import { Plan } from '../chat/Plan';
import { Transcript, type TranscriptEntry } from '../chat/Transcript';
import {
  attachment,
  attachmentAccept,
  canParseDocuments,
  stagedAttachment,
  taskFile,
} from '../files/files';
import { Requests } from '../requests/Requests';
import { GroupMessage as GroupMessageView } from './GroupMessage';
import { Mentions } from './Mentions';

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
  const locale = useLocale();
  const runtime = useRuntime();
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [page, setPage] = useState<GroupPage>();
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const humanRequests = (runtime.snapshot.interactions || []).filter(
    (item) => item.conversationId === bot.id && item.status === 'pending',
  );
  const attentionRun = humanRequests[0]?.runId;
  const scroll = useFollow(bot.id, humanRequests.map((item) => item.id).join(','));
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
  const { upload, attach, transfer, dragging } = useInputs(
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
  const folders = draftFolders(state, bot.id);
  const selectedMentions = readMentions(state.groupMentions?.[bot.id], draft);
  const mentioned = resolveMentions(
    draft,
    members.map((member) => ({ id: member.id, name: member.bot?.name || member.id })),
    selectedMentions,
  );
  const mentionError = mentioned.ambiguous.length
    ? t('groupchat.mentionAmbiguous')
    : mentioned.recipients.some((id) => !availableMembers.some((member) => member.id === id))
      ? t('groupchat.mentionUnavailable')
      : '';
  const validRecipients = !mentionError && (mentioned.recipients.length > 0 || validTarget);
  const recipientNames = new Intl.ListFormat(locale, {
    style: 'short',
    type: 'conjunction',
  }).format(
    mentioned.recipients.map((id) => mentioned.mentions.find((item) => item.id === id)!.name),
  );
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
      (!validRecipients ||
        (!draft.trim() && !attached.length && !folders.length) ||
        !runtime.snapshot.model.configured)
    )
      return;
    const input: GroupSend = pending || {
      revision: registered.revision,
      id: crypto.randomUUID(),
      group: bot.id,
      prompt: draftPrompt(draft, folders) || t('common.reviewFilesCompleteTaskIDescribed'),
      recipients: mentioned.recipients.length
        ? mentioned.recipients
        : target === '*'
          ? availableMembers.map((member) => member.id)
          : [target],
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
  const inputFile = useCallback(
    async (message: GroupMessage, name: string) => {
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
    },
    [runtime.command, bot.id, preview, notify],
  );
  const roster = useMemo(
    () =>
      (page?.group.members || bot.members?.map(agentId) || []).map((id) => ({
        id,
        name: state.bots.find((item) => !item.members && agentId(item.id) === id)?.name || id,
      })),
    [page?.group.members, bot.members, state.bots],
  );
  const grouped = new Map<
    string,
    { messages: GroupMessage[]; deliveries: NonNullable<typeof page>['deliveries'] }
  >();
  for (const message of page?.messages || []) {
    let source = grouped.get(message.sourceId);
    if (!source) {
      source = { messages: [], deliveries: [] };
      grouped.set(message.sourceId, source);
    }
    source.messages.push(message);
  }
  for (const delivery of page?.deliveries || [])
    grouped.get(delivery.sourceId)?.deliveries.push(delivery);
  const rows: TranscriptEntry[] = [];
  if (state.messages[bot.id].length)
    rows.push({
      id: 'legacy',
      anchor: false,
      content: (
        <details
          className="activity"
          onToggle={(event) => {
            if (event.target === event.currentTarget) setLegacyOpen(event.currentTarget.open);
          }}
        >
          <summary>{t('groupchat.legacyLocalRecordsNotSubmittedGroupService')}</summary>
          {legacyOpen &&
            state.messages[bot.id].map((item) => (
              <p className="inline-note" key={item.id}>
                {item.text}
              </p>
            ))}
        </details>
      ),
    });
  if (page?.nextBefore)
    rows.push({
      id: 'older',
      anchor: false,
      content: (
        <button type="button" className="text-button" disabled={loading} onClick={older}>
          {loading ? t('common.loading') : t('groupchat.loadEarlierMessages')}
        </button>
      ),
    });
  if (!page?.messages.length)
    rows.push({
      id: 'empty',
      anchor: false,
      content: (
        <div className="empty-chat">
          <Avatar bot={bot} size="large" />
          <h2>{t('groupchat.startCollaborating')}</h2>
          <p>{t('groupchat.chooseRecipientsSendFirstMessageMembersWork')}</p>
        </div>
      ),
    });
  const pendingRuns = new Set(
    (runtime.snapshot.interactions || [])
      .filter((item) => item.conversationId === bot.id && item.status === 'pending')
      .map((item) => item.runId),
  );
  for (const [sourceId, source] of grouped) {
    const rendered = new Set<string>();
    for (const value of source.messages) {
      const firstRun = value.runId && !rendered.has(value.runId) ? value.runId : undefined;
      if (firstRun) rendered.add(firstRun);
      rows.push({
        bubbleKey:
          value.role === 'bot' && value.runId
            ? `run:${value.runId}`
            : value.role === 'user' || value.role === 'bot'
              ? `message:${value.id}`
              : undefined,
        id: `message:${value.id}`,
        persistent: !!firstRun && pendingRuns.has(firstRun),
        content: (
          <>
            {firstRun && (
              <div ref={firstRun === attentionRun ? scroll.attention : undefined}>
                <Requests state={state} dispatch={dispatch} notify={notify} runs={[firstRun]} />
              </div>
            )}
            <GroupMessageView
              value={value}
              author={state.bots.find((item) => !item.members && agentId(item.id) === value.author)}
              roster={roster}
              group={bot.id}
              preview={preview}
              openLink={openLink}
              copyText={copyText}
              notify={notify}
              inputFile={inputFile}
            />
          </>
        ),
      });
    }
    const remaining = source.deliveries.flatMap((delivery) =>
      delivery.runId && !rendered.has(delivery.runId) ? [delivery.runId] : [],
    );
    if (remaining.length)
      rows.push({
        id: `requests:${sourceId}`,
        persistent: true,
        content: (
          <div
            ref={attentionRun && remaining.includes(attentionRun) ? scroll.attention : undefined}
          >
            <Requests state={state} dispatch={dispatch} notify={notify} runs={remaining} />
          </div>
        ),
      });
    for (const { delivery, task } of tasks.filter((item) => item.delivery.sourceId === sourceId)) {
      rows.push({
        bubbleKey: task.response?.text && task.runId ? `run:${task.runId}` : undefined,
        id: `delivery:${delivery.id}`,
        persistent: true,
        content: (
          <div>
            <p className="message-author">
              {members.find((member) => member.id === delivery.bot)?.bot?.name || delivery.bot} ·{' '}
              {task.phase === 'waiting'
                ? t('common.waitingReply')
                : task.phase === 'paused'
                  ? t('common.waitingComputerHandback')
                  : t('groupchat.processing')}
            </p>
            {task.plan && (
              <Plan items={task.plan} active={task.running && task.phase === 'running'} />
            )}
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
        ),
      });
    }
    if (
      source.deliveries.some((delivery) =>
        ['pending', 'claimed', 'running'].includes(delivery.state),
      )
    )
      rows.push({
        id: `progress:${sourceId}`,
        persistent: true,
        content: (
          <div className="live-task">
            <span>
              {t('groupchat.collaboration')}{' '}
              {source.deliveries.filter((delivery) => delivery.state === 'completed').length}/
              {source.deliveries.length}
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
        ),
      });
  }
  return (
    <section className="conversation" aria-label={t('common.conversation', { 0: bot.name })}>
      <Transcript scope={bot.id} entries={rows} scroll={scroll} loading={!page || loading} />
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
          {dragging && <DropHint />}
          {(attached.length > 0 || folders.length > 0) && (
            <div className="attachments">
              <FolderReferences
                folders={folders}
                disabled={readOnly || sending || !!pending}
                onRemove={(folder) =>
                  dispatch({ type: 'draft-folder-remove', bot: bot.id, folder })
                }
              />
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
          <Mentions
            placeholder={t('groupchat.messageWithMentions', { 0: bot.name })}
            value={draft}
            maxLength={draftTextLimit(folders)}
            mentions={selectedMentions}
            members={availableMembers.map((member) => ({
              id: member.id,
              name: member.bot?.name || member.id,
              description: member.bot?.role,
            }))}
            disabled={readOnly}
            onFiles={attach}
            onChange={(text, mentions) =>
              dispatch({ type: 'group-draft', group: bot.id, text, mentions })
            }
            onSubmit={() => {
              if (!pending) send().catch((error) => notify(runtimeError(error)));
            }}
          />
          {mentionError && (
            <p className="form-error" role="status">
              {mentionError}
            </p>
          )}
          <div className="composer-bottom">
            <IconButton
              label={t('common.addAttachment')}
              title={
                canParseDocuments(runtime.snapshot) ? undefined : t('files.nativeAttachmentHint')
              }
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
              accept={attachmentAccept(runtime.snapshot)}
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
            {mentioned.recipients.length ? (
              <span className="group-recipient-summary" role="status" title={recipientNames}>
                <span>{t('groupchat.send')}</span>
                <span>{recipientNames}</span>
              </span>
            ) : (
              <Select
                className="group-recipient"
                label={t('groupchat.send')}
                prefix={t('groupchat.send')}
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
            )}
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
                !validRecipients ||
                !!pending ||
                sending ||
                !!state.attachmentUploads[bot.id] ||
                !runtime.snapshot.model.configured ||
                (!draft.trim() && !attached.length && !folders.length)
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
