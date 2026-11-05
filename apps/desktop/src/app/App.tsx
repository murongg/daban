import {
  type AttachmentReceipt,
  agentId,
  agentTask,
  type BotProfile,
  type BotProfileInput,
  computerTarget,
  type DocumentOriginal,
  type Group,
  goalCommand,
  imageMime,
  isGoalResumeTarget,
  isModelId,
  modelCatalog,
  modelHasVision,
  type RuntimeDownload,
  type RuntimeFile,
  type RuntimeTaskSummary,
  recoveryBlocked,
  sameProjectScope,
  type TaskRequest,
} from '@daban/protocol';
import {
  Archive as ArchiveIcon,
  Check,
  Download,
  History,
  Info,
  Menu,
  MessageSquarePlus,
  Monitor,
  Moon,
  Pencil,
  Sun,
} from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { I18nProvider } from 'react-aria-components';
import { isTaskReceipt } from '../../shared/receipt';
import { IconButton } from '../components/controls/Button';
import { Dialog } from '../components/controls/Dialog';
import { ImagePreview } from '../components/ImagePreview';
import { Archive } from '../features/bots/Archive';
import { Avatar } from '../features/bots/Avatar';
import { CopyBot } from '../features/bots/CopyBot';
import { Create } from '../features/bots/Create';
import { ExportBot } from '../features/bots/ExportBot';
import { Gallery } from '../features/bots/Gallery';
import { ImportBot } from '../features/bots/ImportBot';
import { Profile } from '../features/bots/Profile';
import type { BotPreset } from '../features/bots/presets';
import { ChatHistory } from '../features/chat/ChatHistory';
import { Conversation } from '../features/chat/Conversation';
import { NewChat } from '../features/chat/NewChat';
import { pendingInserts } from '../features/chat/response';
import { Computer, type ComputerSurface } from '../features/computer/Computer';
import { Desktop } from '../features/computer/Desktop';
import { Recovery, RecoveryNotice } from '../features/computer/Recovery';
import { download, downloadBlob, taskFile } from '../features/files/files';
import { CopyGroup } from '../features/groups/CopyGroup';
import { GroupArchive } from '../features/groups/GroupArchive';
import { GroupChat } from '../features/groups/GroupChat';
import { GroupEditor } from '../features/groups/GroupEditor';
import { useGroups } from '../features/groups/groups';
import { Inbox } from '../features/inbox/Inbox';
import { ModelPicker } from '../features/models/ModelPicker';
import { useNotices } from '../features/notifications/notices';
import { Onboarding } from '../features/onboarding/Onboarding';
import { AgentUpgradeNotice } from '../features/settings/AgentUpgrade';
import { Settings } from '../features/settings/Settings';
import { UpdateNotice } from '../features/settings/Updates';
import { UpdateProvider, useUpdateSave } from '../features/settings/update';
import { Tasks } from '../features/tasks/Tasks';
import { useWork } from '../features/tasks/work';
import { syncLocale, t, useLocale } from '../i18n/locale';
import { Actions } from './Actions';
import { useAttention } from './attention';
import { clientCache } from './cache';
import { profileInput, useProfiles } from './profiles';
import { RuntimeProvider, runtimeError, useRuntime } from './Runtime';
import { Sidebar } from './Sidebar';
import {
  type Action,
  chatApprovalMode,
  chatRevision,
  initialState,
  lifecycleRequest,
  mergeAttachments,
  messageQueue,
  messageQueueLimit,
  projectScope,
  type QueuedTask,
  reduce,
  type WorkspaceFile,
} from './state';
import { restore, serialize, storageKey } from './storage';
import { Welcome } from './Welcome';
import { Workspace } from './Workspace';

type Modal =
  | { type: 'chat'; bot: string }
  | {
      type: 'chat-history';
      bot: string;
      initialRevision?: number;
      runId?: string;
      includeCurrent?: boolean;
    }
  | { type: 'export'; bot: string }
  | { type: 'import' }
  | { type: 'copy'; bot?: string }
  | { type: 'group-copy'; group?: string }
  | { type: 'create'; group: boolean; preset?: BotPreset }
  | { type: 'profile'; bot: string }
  | { type: 'model'; bot: string }
  | { type: 'archive'; bot: string }
  | { type: 'recovery' }
  | { type: 'group'; bot: string }
  | { type: 'file'; file: WorkspaceFile }
  | { type: 'computer'; bot: string; surface?: ComputerSurface }
  | null;
type TaskOutcome = 'started' | 'completed' | 'failed' | 'uncertain' | 'skipped';
interface TaskRunResult {
  outcome: TaskOutcome;
  runId?: string;
}
// These replies prove the insert was not applied; transport failures and malformed acks stay uncertain.
function definiteInsertError(error: unknown) {
  return (
    error instanceof Error &&
    [
      'TASK_INSERT_STALE',
      'MODEL_NOT_RUNNING',
      'MODEL_INSERT_UNCERTAIN',
      'MODEL_INSERT_FULL',
      'INVALID_TASK_INSERT',
      'UNKNOWN_BOT',
      'RUNTIME_TOO_OLD',
    ].includes(error.message)
  );
}
// A begun turn may already have run tools or changed files, so it must never be replayed automatically.
function uncertainInsertError(error: unknown) {
  return error instanceof Error && error.message === 'MODEL_INSERT_UNCERTAIN';
}
function load() {
  try {
    const state = restore(clientCache().getItem(storageKey));
    return window.innerWidth < 1080 ? { ...state, panel: null } : state;
  } catch {
    return initialState();
  }
}
export function App() {
  const locale = useLocale();
  useEffect(syncLocale, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title =
      locale === 'en' ? 'Daban · Your AI work companion' : t('app.dabanAiWorkCompanion');
  }, [locale]);
  return (
    <I18nProvider locale={locale}>
      <UpdateProvider>
        <RuntimeProvider>
          <UpdateNotice />
          <AgentUpgradeNotice />
          <Onboarding>
            <Workbench />
          </Onboarding>
        </RuntimeProvider>
      </UpdateProvider>
    </I18nProvider>
  );
}
function Workbench() {
  useLocale();
  const runtime = useRuntime();
  const submitting = useRef(new Set<string>());
  const draining = useRef(new Set<string>());
  const awaitingRun = useRef(new Map<string, { runId: string; at: number }>());
  const verifyingInserts = useRef(new Set<string>());
  const legacySettings = useRef(false);
  const [state, update] = useReducer(reduce, undefined, () => {
    const restored = load();
    legacySettings.current = restored.view === 'settings';
    // Cache migration must not mark the obscured conversation read through a navigation action.
    return legacySettings.current ? { ...restored, view: 'chat' as const } : restored;
  });
  const updateState = useRef(state);
  updateState.current = state;
  useUpdateSave(
    useCallback(() => {
      clientCache().setItem(storageKey, serialize(updateState.current));
    }, []),
  );
  const [settingsOpen, setSettingsOpen] = useState(legacySettings.current);
  const dispatch = useCallback((action: Action) => {
    if (action.type === 'view' && action.view === 'settings') {
      setSettingsOpen(true);
      return;
    }
    if (action.type === 'select' || action.type === 'view') setSettingsOpen(false);
    update(action);
  }, []);
  const [query, setQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  useAttention(state, dispatch, !!modal || settingsOpen);
  const [toast, setToast] = useState('');
  const [verifyTick, setVerifyTick] = useState(0);
  const [inboxFocus, setInboxFocus] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
  const storageFailed = useRef(false);
  const ingested = useRef(new Map<string, string>());
  const notify = useCallback((text: string) => setToast(text), []);
  const work = useWork(state, dispatch, notify);
  const closeModal = useCallback(() => setModal(null), []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (state.view === 'chat' && !modal && !document.hidden && document.hasFocus()) {
      update({ type: 'bot-read', bot: state.selected, unread: false });
    }
  }, [state.selected, state.view, modal]);
  const preview = useCallback((file: WorkspaceFile) => setModal({ type: 'file', file }), []);
  useNotices((activation) => {
    if (modal || settingsOpen) return false;
    const target = activation.target;
    if (target.kind === 'settings') {
      dispatch({ type: 'view', view: 'settings' });
      return true;
    }
    if (runtime.snapshot.phase !== 'ready') return false;
    if (target.kind === 'question' || target.kind === 'approval') {
      setInboxFocus(target.id);
      dispatch({ type: 'view', view: 'inbox' });
      return true;
    }
    if (target.kind === 'group') {
      if (!runtime.snapshot.groups?.items.some((group) => group.id === target.group)) {
        notify(t('app.notificationSGroupUnreadableNoOtherConversation'));
        return true;
      }
      const group = state.bots.find((bot) => bot.id === target.group && !!bot.members);
      if (!group) return false;
      setQuery('');
      dispatch({ type: 'select', bot: group.id });
      return true;
    }
    if (!runtime.snapshot.profiles.some((profile) => profile.id === target.bot)) {
      notify(t('app.notificationSBotNotEnvironmentNoOther'));
      return true;
    }
    const targetBot = state.bots.find((bot) => !bot.members && agentId(bot.id) === target.bot);
    if (!targetBot) return false;
    if (target.chatRevision > chatRevision(state, targetBot.id, runtime.snapshot.chats)) {
      notify(t('app.notificationSConversationStateChangedCheckConversation'));
      return true;
    }
    setQuery('');
    dispatch({ type: 'select', bot: targetBot.id });
    setModal({
      type: 'chat-history',
      bot: targetBot.id,
      initialRevision: target.chatRevision,
      runId: target.id,
      includeCurrent: true,
    });
    return true;
  }, notify);
  useProfiles(state, dispatch, notify);
  useGroups(state, dispatch, notify);
  const bot = state.bots.find((b) => b.id === state.selected);
  const target = bot ? computerTarget(runtime.snapshot, bot.id) : undefined;
  const computer = target ? runtime.snapshot.bots[target] : undefined;
  const task = bot ? agentTask(runtime.snapshot, bot.id) : undefined;
  const pendingLifecycle = bot
    ? lifecycleRequest(
        state,
        bot.id,
        runtime.snapshot.profiles.find((profile) => profile.id === agentId(bot.id)),
      )
    : undefined;
  const pendingGroup = bot ? state.groupActions[bot.id] : undefined;
  const historyOnly = !!bot?.archived || !!pendingLifecycle || !!pendingGroup;
  const workspaceVisible =
    !!state.panel && (!historyOnly || ['computer', 'files', 'notes'].includes(state.panel));
  const chatVersion = bot ? chatRevision(state, bot.id, runtime.snapshot.chats) : 0;
  useEffect(() => {
    if (runtime.snapshot.chats?.available)
      dispatch({ type: 'chats', items: runtime.snapshot.chats.items });
  }, [runtime.snapshot.chats, dispatch]);
  let subtitle = bot?.role || t('app.aiWorkCompanion');
  if (runtime.enabled && bot && !bot.members) {
    subtitle =
      computer?.owner === 'human'
        ? t('app.controlAwaitingHandback')
        : task?.running
          ? task.conversationId
            ? t('common.workingGroupTask')
            : t('common.processingMessage')
          : computer
            ? t('app.generalAgentComputerConnected')
            : t('common.generalAgent');
  } else if (!runtime.enabled && bot && state.controls[bot.id] === 'human')
    subtitle = t('app.controlAwaitingHandback');
  if (pendingGroup) subtitle = t('app.groupActionNeedsVerification');
  else if (bot && state.chatRequests[bot.id])
    subtitle = t('app.conversationActionNeedsVerification');
  else if (pendingLifecycle) subtitle = t('app.botActionNeedsVerification');
  else if (bot?.archived) subtitle = t('app.archivedReadOnlyHistory');
  useEffect(() => {
    if (!runtime.enabled || runtime.snapshot.phase !== 'ready') {
      ingested.current.clear();
      return;
    }
    for (const entry of state.bots) {
      if (entry.members) continue;
      const botId = entry.id;
      const task = agentTask(runtime.snapshot, botId);
      if (!task) continue;
      const records: RuntimeTaskSummary[] = task.history.filter((record) => !record.conversationId);
      if (!task.conversationId && task.runId && task.requestId)
        records.push({
          chatRevision: task.chatRevision,
          runId: task.runId,
          requestId: task.requestId,
          prompt: task.prompt,
          phase: task.phase,
          result: task.result,
          error: task.error,
          files: task.files,
          ...(task.turns?.length ? { turns: task.turns } : {}),
          response: ['failed', 'stopped', 'interrupted'].includes(task.phase)
            ? task.response
            : undefined,
        });
      for (const record of records) {
        const key = `${botId}/${record.runId}`;
        const response = ['failed', 'stopped', 'interrupted'].includes(record.phase)
          ? record.response
          : undefined;
        const signature = JSON.stringify([
          record.chatRevision,
          record.requestId,
          record.prompt,
          record.phase,
          record.result,
          record.error,
          (record.files || []).map((file) => [file.path, file.name, file.size, file.modified]),
          (record.turns || []).map((turn) => [turn.id, turn.prompt, turn.result, turn.error]),
          response && [response.revision, response.state, response.text],
        ]);
        // Streaming changes are rendered directly; unchanged history must not replay through the reducer on every frame.
        if (
          ingested.current.get(key) === signature &&
          state.runtimeRequests[botId]?.requestId !== record.requestId
        )
          continue;
        ingested.current.set(key, signature);
        dispatch({ type: 'runtime-task', bot: botId, task: record });
      }
    }
  }, [runtime.enabled, runtime.snapshot, state.bots, state.runtimeRequests, dispatch]);
  function imagesUnsupported(botId: string, files: WorkspaceFile[]) {
    if (!files.some((file) => imageMime(file.upload?.name || file.name))) return false;
    const model =
      state.bots.find((entry) => entry.id === botId)?.model || runtime.snapshot.model.model;
    return (
      !isModelId(model) || !modelHasVision(model, modelCatalog(runtime.snapshot.model.connections))
    );
  }
  async function runTask(
    botId: string,
    continued?: TaskRequest,
    queued?: QueuedTask,
  ): Promise<TaskRunResult> {
    const skipped: TaskRunResult = { outcome: 'skipped' };
    if (recoveryBlocked(runtime.snapshot)) {
      notify(t('app.runtimeRecoveryNeedsVerificationNewTasksPaused'));
      return skipped;
    }
    if (
      state.bots.find((entry) => entry.id === botId)?.archived ||
      state.chatRequests[botId] ||
      lifecycleRequest(state, botId)
    ) {
      notify(t('app.restoreBotVerifyOperationResultSendingNew'));
      return skipped;
    }
    if (state.attachmentUploads[botId]) {
      notify(t('common.waitUntilAttachmentsReadySending'));
      return skipped;
    }
    const target = agentId(botId);
    if (state.bots.find((entry) => entry.id === botId)?.members) {
      notify(t('app.chooseRecipientsGroupWindowSending'));
      return skipped;
    }
    if (submitting.current.has(botId)) return skipped;
    if (queued && state.runtimeRequests[botId]) return skipped;
    const text = queued ? queued.prompt.trim() : state.drafts[botId].trim();
    const attached = (
      queued
        ? queued.files.map((id) => state.files.find((file) => file.id === id))
        : state.attachments[botId].map((id) => state.files.find((f) => f.id === id))
    ).filter((f): f is WorkspaceFile => !!f);
    const task: TaskRequest = state.runtimeRequests[botId] ||
      continued || {
        ...(runtime.snapshot.protocolVersion >= 29
          ? { chatRevision: chatRevision(state, botId, runtime.snapshot.chats) }
          : {}),
        requestId: crypto.randomUUID(),
        ...((queued ? queued.project : projectScope(state, botId))
          ? { project: queued ? queued.project : projectScope(state, botId) }
          : {}),
        ...(runtime.snapshot.protocolVersion >= 44
          ? {
              approvalMode: chatApprovalMode(
                state,
                botId,
                chatRevision(state, botId, runtime.snapshot.chats),
              ),
            }
          : {}),
        prompt: text || t('common.reviewFilesCompleteTaskIDescribed'),
        ...(runtime.snapshot.protocolVersion < 3 ? { memory: state.memories[botId] } : {}),
        files: attached.map(taskFile),
      };
    if (!task.prompt.trim()) return skipped;
    // An uncertain send keeps its captured request; next-task model edits cannot change receipt reconciliation.
    if (!continued && !state.runtimeRequests[botId] && imagesUnsupported(botId, attached)) {
      notify(t('app.currentModelDoesNotSupportImagesChoose'));
      return skipped;
    }
    submitting.current.add(botId);
    // Keep the exact source attachments of this send: a queued item's composer slot was cleared when it was queued.
    const refs = continued
      ? undefined
      : state.runtimeRequests[botId]
        ? state.runtimeRefs[botId]
        : queued
          ? [...queued.files]
          : [...state.attachments[botId]];
    try {
      if (
        !state.runtimeRequests[botId] &&
        !task.retryOf &&
        goalCommand(task.prompt)?.action === 'resume' &&
        !task.goalResume
      ) {
        const targetGoal = await runtime.command({
          type: 'budget.goal',
          owner: {
            bot: target,
            chatRevision: task.chatRevision ?? 0,
            ...(task.project ? { project: task.project } : {}),
          },
        });
        if (targetGoal !== null) {
          if (!isGoalResumeTarget(targetGoal)) throw new Error('GOAL_TARGET_UNAVAILABLE');
          task.goalResume = targetGoal;
        }
      }
      dispatch({ type: 'runtime-pending', bot: botId, task, refs });
      if (runtime.snapshot.protocolVersion >= 3) {
        const entry = state.bots.find((bot) => bot.id === botId);
        if (entry)
          await runtime.command({
            type: 'bot.register',
            profile: profileInput(entry, state.memories[botId]),
          });
      }
      const receipt = await runtime.command({ type: 'task.start', bot: target, task });
      let finished = false;
      if (runtime.snapshot.protocolVersion >= 29) {
        if (
          !isTaskReceipt(receipt) ||
          receipt.requestId !== task.requestId ||
          receipt.prompt !== task.prompt ||
          (receipt.chatRevision ?? 0) !== (task.chatRevision ?? 0)
        )
          throw new Error('INVALID_TASK_ACK');
        dispatch({ type: 'runtime-task', bot: botId, task: receipt });
        finished = ['completed', 'failed', 'stopped', 'interrupted'].includes(receipt.phase);
        return finished
          ? { outcome: 'completed', runId: receipt.runId }
          : { outcome: 'started', runId: receipt.runId };
      }
      return { outcome: 'started' };
    } catch (error) {
      // Only a definite rejection is editable; an ambiguous network result retains the ID to prevent replay.
      if (
        error instanceof Error &&
        [
          'PROJECT_BUSY',
          'PROJECT_SCOPE_STALE',
          'PROJECT_ACCESS_DENIED',
          'PROJECT_ARCHIVED',
          'PROJECT_NOT_FOUND',
          'EXECUTION_UPGRADE_REQUIRED',
          'INVALID_TASK',
          'CHAT_CONFLICT',
          'CHAT_REVISION_REQUIRED',
          'INVALID_COMMAND',
          'INVALID_RETRY',
          'RETRY_NOT_FOUND',
          'MODEL_NOT_CONFIGURED',
          'MODEL_ALREADY_RUNNING',
          'DSH_NOT_INSTALLED',
          'INVALID_BOT_PROFILE',
          'BOT_PROFILE_CONFLICT',
          'BOT_PROFILE_CORRUPT',
          'ATTACHMENT_NOT_FOUND',
          'ATTACHMENT_TRASHED',
          'ATTACHMENT_CORRUPT',
          'INVALID_ATTACHMENT',
          'MODEL_IMAGE_UNSUPPORTED',
          'RUNTIME_TOO_OLD',
        ].includes(error.message)
      ) {
        notify(runtimeError(error));
        dispatch({ type: 'runtime-clear', bot: botId });
        return { outcome: 'failed' };
      }
      notify(runtimeError(error));
      return { outcome: 'uncertain' };
    } finally {
      submitting.current.delete(botId);
    }
  }
  async function continueTask(botId: string) {
    const task = agentTask(runtime.snapshot, botId);
    if (!task?.runId || task.conversationId || !task.prompt || task.running) return;
    // An inserted turn that failed keeps no reply; continuing must resume that turn, not replay finished work.
    const unfinished = [...(task.turns || [])].reverse().find((turn) => !turn.result);
    // The backend owns accepted inserts; capture the resumed turn so receipt loss and a full UI queue cannot drop them.
    const waiting = pendingInserts(task).filter((insert) => !insert.started);
    const target =
      unfinished ?? (waiting[0] ? { id: waiting[0].id, prompt: waiting[0].text } : undefined);
    if (waiting.length && runtime.snapshot.protocolVersion < 43) {
      notify(runtimeError(new Error('RUNTIME_TOO_OLD')));
      return;
    }
    const prompt = target?.prompt ?? task.prompt;
    if (!prompt) return;
    await runTask(botId, {
      requestId: crypto.randomUUID(),
      prompt,
      retryOf: task.runId,
      ...(task.project ? { project: task.project } : {}),
      ...(runtime.snapshot.protocolVersion >= 44
        ? {
            approvalMode: chatApprovalMode(
              state,
              botId,
              chatRevision(state, botId, runtime.snapshot.chats),
            ),
          }
        : {}),
      ...(target && runtime.snapshot.protocolVersion >= 43 ? { retryTurn: target.id } : {}),
      ...(runtime.snapshot.protocolVersion >= 29
        ? { chatRevision: task.chatRevision ?? chatRevision(state, botId, runtime.snapshot.chats) }
        : {}),
      ...(runtime.snapshot.protocolVersion < 3 ? { memory: state.memories[botId] } : {}),
    });
  }
  function queueTask(botId: string) {
    const entry = state.bots.find((bot) => bot.id === botId);
    if (!entry || entry.archived) return;
    if (state.runtimeRequests[botId] || state.attachmentUploads[botId]) return;
    if (state.chatRequests[botId] || lifecycleRequest(state, botId)) return;
    const prompt = state.drafts[botId].trim();
    const files = state.attachments[botId]
      .map((id) => state.files.find((file) => file.id === id))
      .filter((file): file is WorkspaceFile => !!file);
    if (!prompt && !files.length) return;
    if (messageQueue(state, botId).length >= messageQueueLimit) {
      notify(t('chat.messageQueueFull', { 0: messageQueueLimit }));
      return;
    }
    if (imagesUnsupported(botId, files)) {
      notify(t('app.currentModelDoesNotSupportImagesChoose'));
      return;
    }
    dispatch({
      type: 'queue-add',
      bot: botId,
      task: {
        id: crypto.randomUUID(),
        prompt,
        files: files.map((file) => file.id),
        ...(projectScope(state, botId) ? { project: projectScope(state, botId) } : {}),
      },
    });
  }
  function rejectInsert(botId: string, id: string, error: unknown) {
    notify(runtimeError(error));
    if (uncertainInsertError(error)) {
      // Clear verify first so the kept item is a failed message: only an explicit retry may run it again.
      dispatch({ type: 'queue-unverify', bot: botId, id });
      dispatch({ type: 'queue-fail', bot: botId, id });
      return;
    }
    if (definiteInsertError(error)) dispatch({ type: 'queue-unverify', bot: botId, id });
  }
  async function insertQueued(botId: string, id: string) {
    const item = messageQueue(state, botId).find((entry) => entry.id === id);
    if (!item || item.files.length || item.verify) return;
    const task = agentTask(runtime.snapshot, botId);
    if (!sameProjectScope(item.project, task?.project)) {
      notify(t('projects.stale'));
      return;
    }
    if (!task?.running || !task.runId || task.conversationId) {
      notify(t('errors.taskEndedMessageKeptQueue'));
      return;
    }
    const target = { runId: task.runId, chatRevision: task.chatRevision ?? 0 };
    // Mark uncertainty before sending; an ambiguous reply keeps the item paused until its receipt is checked.
    dispatch({ type: 'queue-verify', bot: botId, id, ...target });
    try {
      const receipt = await runtime.command<{ ok?: unknown; id?: unknown }>({
        type: 'task.insert',
        bot: agentId(botId),
        id: item.id,
        text: item.prompt,
        ...target,
      });
      if (receipt?.ok !== true || receipt.id !== item.id) throw new Error('INVALID_TASK_ACK');
      dispatch({ type: 'queue-insert', bot: botId, id: item.id, revision: target.chatRevision });
    } catch (error) {
      rejectInsert(botId, item.id, error);
    }
  }
  const verifyPending = Object.values(state.queued).some((items) =>
    items.some((item) => !!item.verify),
  );
  useEffect(() => {
    if (!verifyPending) return;
    const timer = window.setInterval(() => setVerifyTick((value) => value + 1), 2500);
    return () => window.clearInterval(timer);
  }, [verifyPending]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconciliation reads this render's state and runtime, and the tick retries while the agent is unreachable.
  useEffect(() => {
    if (!runtime.enabled || runtime.snapshot.phase !== 'ready' || !verifyPending) return;
    for (const entry of state.bots) {
      const item = messageQueue(state, entry.id).find((queued) => !!queued.verify);
      const target = item?.verify;
      if (!item || !target || verifyingInserts.current.has(item.id)) continue;
      verifyingInserts.current.add(item.id);
      runtime
        .command<{ ok?: unknown; id?: unknown }>({
          type: 'task.insert',
          bot: agentId(entry.id),
          id: item.id,
          text: item.prompt,
          ...target,
        })
        .then((receipt) => {
          if (receipt?.ok !== true || receipt.id !== item.id) throw new Error('INVALID_TASK_ACK');
          dispatch({
            type: 'queue-insert',
            bot: entry.id,
            id: item.id,
            revision: target.chatRevision,
          });
        })
        .catch((error) => {
          // Unknown outcomes stay paused; only a definite rejection can resume normal queue delivery.
          if (!definiteInsertError(error)) return;
          rejectInsert(entry.id, item.id, error);
        })
        .finally(() => {
          verifyingInserts.current.delete(item.id);
        });
    }
  }, [runtime, state, dispatch, notify, verifyPending, verifyTick]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runTask reads this render's state and runtime, and the effect already re-runs on both.
  useEffect(() => {
    if (!runtime.enabled || runtime.snapshot.phase !== 'ready') return;
    if (recoveryBlocked(runtime.snapshot)) return;
    for (const entry of state.bots) {
      if (entry.members || draining.current.has(entry.id)) continue;
      const item = messageQueue(state, entry.id)[0];
      if (!item) {
        awaitingRun.current.delete(entry.id);
        continue;
      }
      // An unconfirmed insert pauses delivery until its receipt is reconciled.
      if (item.error || item.verify) continue;
      if (state.runtimeRequests[entry.id] || state.attachmentUploads[entry.id]) continue;
      if (entry.archived || state.chatRequests[entry.id] || lifecycleRequest(state, entry.id))
        continue;
      const attached = item.files
        .map((id) => state.files.find((file) => file.id === id))
        .filter((file): file is WorkspaceFile => !!file);
      // A skipped send would release the sending lock and be retried forever, so fail it once instead.
      if (imagesUnsupported(entry.id, attached)) {
        notify(t('app.currentModelDoesNotSupportImagesChoose'));
        dispatch({ type: 'queue-fail', bot: entry.id, id: item.id });
        continue;
      }
      const current = agentTask(runtime.snapshot, entry.id);
      const awaiting = awaitingRun.current.get(entry.id);
      if (awaiting) {
        // The run we started may finish before it is ever observed running; its terminal state also releases the queue.
        const settled =
          current?.runId === awaiting.runId
            ? !current.running
            : !current?.running && Date.now() - awaiting.at > 5000;
        if (!settled) continue;
        awaitingRun.current.delete(entry.id);
      } else if (current?.running) continue;
      draining.current.add(entry.id);
      dispatch({ type: 'queue-sending', bot: entry.id, id: item.id, sending: true });
      runTask(entry.id, undefined, item)
        .then((result) => {
          // Releasing the lock first lets the terminal action still remove or fail this item.
          dispatch({ type: 'queue-sending', bot: entry.id, id: item.id, sending: false });
          if (result.outcome === 'failed') {
            dispatch({ type: 'queue-fail', bot: entry.id, id: item.id });
            return;
          }
          if (result.outcome === 'skipped') return;
          dispatch({ type: 'queue-remove', bot: entry.id, id: item.id });
          if (result.outcome === 'started' && result.runId)
            awaitingRun.current.set(entry.id, { runId: result.runId, at: Date.now() });
        })
        .catch((error) => notify(runtimeError(error)))
        .finally(() => {
          dispatch({ type: 'queue-sending', bot: entry.id, id: item.id, sending: false });
          draining.current.delete(entry.id);
        });
    }
  }, [runtime, state, dispatch, notify]);
  const previewFile = useCallback(
    async (file: WorkspaceFile) => {
      const source = updateState.current;
      const scope = projectScope(source, source.selected);
      const stillSelected = () =>
        !file.runtimeScope?.project ||
        (updateState.current.selected === source.selected &&
          sameProjectScope(projectScope(updateState.current, source.selected), scope));
      if (imageMime(file.upload?.name || file.name)) {
        preview(file);
        return;
      }
      if (file.upload) {
        try {
          const receipt = await runtime.command<AttachmentReceipt>({
            type: 'attachment.read',
            bot: file.upload.bot,
            id: file.upload.id,
          });
          preview({ ...file, content: receipt.content });
        } catch (error) {
          notify(runtimeError(error));
        }
        return;
      }
      if (!file.runtimePath) {
        preview(file);
        return;
      }
      try {
        const actual = await runtime.command<RuntimeFile>({
          type: 'files.read',
          path: file.runtimePath,
          ...file.runtimeScope,
        });
        if (stillSelected()) preview({ ...file, content: actual.content || '' });
      } catch (error) {
        if (stillSelected()) notify(runtimeError(error));
      }
    },
    [runtime.command, preview, notify],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    if (window.daban?.platform === 'win32')
      window.daban.titlebar?.setTheme(state.theme).catch(() => {
        console.error('Window theme synchronization failed');
      });
  }, [state.theme]);
  useEffect(() => {
    try {
      clientCache().setItem(storageKey, serialize(state));
      storageFailed.current = false;
    } catch {
      if (!storageFailed.current) {
        storageFailed.current = true;
        notify(t('app.localStorageUnavailableFullExportWorkspaceRefreshing'));
      }
    }
  }, [state, notify]);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      // Local editors share Dialog without owning the main modal state.
      if (document.querySelector('[role="dialog"], [data-daban-popup]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (modal) return;
        setSidebarOpen(true);
        requestAnimationFrame(() => search.current?.focus());
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        if (!modal) dispatch({ type: 'view', view: 'settings' });
      }
      if (e.key === 'Escape' && !modal) {
        setSidebarOpen(false);
        dispatch({ type: 'panel', panel: null });
      }
    }
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [modal, dispatch]);
  const computerBot =
    modal?.type === 'computer' ? state.bots.find((b) => b.id === modal.bot) : undefined;
  return (
    <div className="app" data-desktop={window.daban?.platform}>
      <Sidebar
        state={state}
        settingsOpen={settingsOpen}
        dispatch={dispatch}
        query={query}
        setQuery={setQuery}
        searchRef={search}
        onImport={() => setModal({ type: 'import' })}
        onCopy={(bot) => setModal({ type: 'copy', bot })}
        onCopyGroup={(group) => setModal({ type: 'group-copy', group })}
        onCreate={(group) => {
          setSidebarOpen(false);
          setModal({ type: 'create', group: !!group });
        }}
        open={sidebarOpen}
        close={() => setSidebarOpen(false)}
      />
      <main className="main">
        <header className="chat-header">
          <IconButton
            className="mobile-menu"
            label={t('app.openSidebar')}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu />
          </IconButton>
          {state.view === 'chat' && bot ? (
            <>
              <Avatar bot={bot} />
              <div className="chat-identity">
                <h1>{bot.name}</h1>
                <p className="chat-subtitle">{subtitle}</p>
              </div>
              <span className="spacer" />
              <div className="header-actions">
                {!bot.members && (
                  <button
                    type="button"
                    className="header-action"
                    aria-label={
                      state.chatRequests[bot.id]
                        ? t('common.verifyConversationAction')
                        : t('common.newConversation')
                    }
                    disabled={
                      !runtime.enabled ||
                      runtime.snapshot.protocolVersion < 29 ||
                      (historyOnly && !state.chatRequests[bot.id])
                    }
                    onClick={() => setModal({ type: 'chat', bot: bot.id })}
                  >
                    <MessageSquarePlus aria-hidden="true" />
                    <span>{t('common.newConversation')}</span>
                  </button>
                )}
                <button
                  type="button"
                  className={`header-action ${workspaceVisible ? 'active' : ''}`}
                  aria-pressed={workspaceVisible}
                  onClick={() =>
                    dispatch({ type: 'panel', panel: workspaceVisible ? null : 'computer' })
                  }
                >
                  <Monitor aria-hidden="true" />
                  <span>{t('app.workspace')}</span>
                </button>
                <Actions
                  key={bot.id}
                  items={[
                    ...(bot.members
                      ? [
                          {
                            id: 'edit-group',
                            label: t('app.editGroup'),
                            icon: <Pencil />,
                            disabled: historyOnly,
                            onSelect: () => setModal({ type: 'group', bot: bot.id }),
                          },
                          {
                            id: 'archive-group',
                            label: pendingGroup
                              ? t('app.verifyGroupAction')
                              : bot.archived
                                ? t('common.restoreGroup')
                                : t('common.archiveGroup'),
                            icon: <ArchiveIcon />,
                            disabled: !runtime.enabled || runtime.snapshot.protocolVersion < 28,
                            onSelect: () => setModal({ type: 'archive', bot: bot.id }),
                          },
                        ]
                      : [
                          {
                            id: 'history',
                            label: t('chat.conversationHistory'),
                            icon: <History />,
                            disabled:
                              !runtime.enabled ||
                              runtime.snapshot.protocolVersion < 29 ||
                              !chatVersion,
                            onSelect: () => setModal({ type: 'chat-history', bot: bot.id }),
                          },
                          {
                            id: 'profile',
                            label: t('app.editBotProfile'),
                            icon: <Pencil />,
                            disabled: historyOnly,
                            onSelect: () => setModal({ type: 'profile', bot: bot.id }),
                          },
                        ]),
                    {
                      id: 'theme',
                      label:
                        state.theme === 'light'
                          ? t('app.switchDarkTheme')
                          : t('app.switchLightTheme'),
                      icon: state.theme === 'light' ? <Moon /> : <Sun />,
                      onSelect: () =>
                        dispatch({
                          type: 'theme',
                          theme: state.theme === 'light' ? 'dark' : 'light',
                        }),
                    },
                  ]}
                />
              </div>
            </>
          ) : (
            <>
              <div className="chat-identity">
                <h1>
                  {state.view === 'chat'
                    ? t('workspace.title')
                    : state.view === 'gallery'
                      ? t('common.botGallery')
                      : state.view === 'inbox'
                        ? t('common.inbox')
                        : state.view === 'tasks'
                          ? t('common.tasks')
                          : t('settings.title')}
                </h1>
                <p className="chat-subtitle">
                  {state.view === 'tasks'
                    ? t('app.sharedDosVisibleAllBots')
                    : t('workspace.yourWorkspace')}
                </p>
              </div>
              <span className="spacer" />
              {state.view !== 'chat' && (
                <IconButton
                  label={t('app.backConversation')}
                  onClick={() => dispatch({ type: 'view', view: 'chat' })}
                >
                  <Monitor />
                </IconButton>
              )}
            </>
          )}
        </header>
        <RecoveryNotice open={() => setModal({ type: 'recovery' })} />
        {state.view === 'chat' ? (
          bot ? (
            <div className="conversation-layout">
              {bot.members ? (
                <GroupChat
                  key={bot.id}
                  state={state}
                  bot={bot}
                  dispatch={dispatch}
                  notify={notify}
                  preview={previewFile}
                />
              ) : (
                <Conversation
                  state={state}
                  bot={bot}
                  dispatch={dispatch}
                  notify={notify}
                  preview={previewFile}
                  onSend={runtime.enabled ? () => runTask(bot.id) : undefined}
                  onQueue={runtime.enabled ? () => queueTask(bot.id) : undefined}
                  onQueueEdit={
                    runtime.enabled
                      ? (id) => {
                          const item = messageQueue(state, bot.id).find((entry) => entry.id === id);
                          if (!item || item.verify || item.sending) return;
                          const draft = state.drafts[bot.id] ?? '';
                          const prompt =
                            draft && item.prompt
                              ? `${draft}\n${item.prompt}`
                              : item.prompt || draft;
                          if (prompt.length > 12000) {
                            notify(t('chat.queuedMessageEditTooLong'));
                            return;
                          }
                          const merged = mergeAttachments(
                            state.attachments[bot.id] ?? [],
                            state.files,
                            item.files,
                          );
                          if (!merged) {
                            notify(t('chat.queuedMessageEditAttachmentsFull'));
                            return;
                          }
                          dispatch({ type: 'queue-edit', bot: bot.id, id });
                        }
                      : undefined
                  }
                  onQueueRemove={
                    runtime.enabled
                      ? (id) => dispatch({ type: 'queue-remove', bot: bot.id, id })
                      : undefined
                  }
                  onQueuePromote={
                    runtime.enabled
                      ? (id) => dispatch({ type: 'queue-promote', bot: bot.id, id })
                      : undefined
                  }
                  onQueueInsert={
                    runtime.enabled && runtime.snapshot.protocolVersion >= 42
                      ? (id) => insertQueued(bot.id, id)
                      : undefined
                  }
                  onQueueRetry={
                    runtime.enabled
                      ? (id) => dispatch({ type: 'queue-retry', bot: bot.id, id })
                      : undefined
                  }
                  onContinue={() => continueTask(bot.id)}
                  onLifecycle={() => setModal({ type: 'archive', bot: bot.id })}
                  onNewChat={() => setModal({ type: 'chat', bot: bot.id })}
                  pending={runtime.enabled && !!state.runtimeRequests[bot.id]}
                  onModel={() => {
                    if (!bot.members && runtime.snapshot.protocolVersion >= 14)
                      setModal({ type: 'model', bot: bot.id });
                    else dispatch({ type: 'view', view: 'settings' });
                  }}
                />
              )}
              {state.panel && workspaceVisible && (
                <Workspace
                  state={state}
                  bot={bot}
                  readOnly={historyOnly}
                  dispatch={dispatch}
                  notify={notify}
                  preview={previewFile}
                  expand={(surface) => setModal({ type: 'computer', bot: bot.id, surface })}
                  openMember={(id) => setModal({ type: 'computer', bot: id })}
                  onRecovery={() => setModal({ type: 'recovery' })}
                />
              )}
            </div>
          ) : (
            <Welcome
              create={() => setModal({ type: 'create', group: false })}
              explore={() => dispatch({ type: 'view', view: 'gallery' })}
            />
          )
        ) : state.view === 'gallery' ? (
          <Gallery onUsePreset={(preset) => setModal({ type: 'create', group: false, preset })} />
        ) : state.view === 'tasks' ? (
          <Tasks state={state} dispatch={dispatch} work={work} />
        ) : state.view === 'inbox' ? (
          <Inbox
            state={state}
            dispatch={dispatch}
            preview={preview}
            notify={notify}
            focus={inboxFocus}
            clearFocus={() => setInboxFocus(undefined)}
          />
        ) : null}
      </main>
      {settingsOpen && (
        <Settings
          state={state}
          dispatch={dispatch}
          onClose={closeSettings}
          active={!modal}
          onLifecycle={(id) => setModal({ type: 'archive', bot: id })}
          onRecovery={() => setModal({ type: 'recovery' })}
        />
      )}
      {modal?.type === 'recovery' && (
        <Recovery
          bots={state.bots}
          close={closeModal}
          onTask={(id) => {
            const task = runtime.snapshot.agents[id];
            const selected =
              task?.conversationId ?? state.bots.find((entry) => agentId(entry.id) === id)?.id;
            if (selected) dispatch({ type: 'select', bot: selected });
            closeModal();
          }}
        />
      )}
      {modal?.type === 'chat' && (
        <NewChat
          key={modal.bot}
          state={state}
          bot={state.bots.find((bot) => bot.id === modal.bot)!}
          dispatch={dispatch}
          close={closeModal}
          notify={notify}
        />
      )}
      {modal?.type === 'chat-history' && (
        <ChatHistory
          key={modal.bot}
          bot={state.bots.find((bot) => bot.id === modal.bot)!}
          revision={
            chatRevision(state, modal.bot, runtime.snapshot.chats) + (modal.includeCurrent ? 1 : 0)
          }
          initialRevision={modal.initialRevision}
          runId={modal.runId}
          close={closeModal}
          notify={notify}
          preview={previewFile}
          cached={state.messages[modal.bot]}
          cachedFiles={state.files}
        />
      )}
      {modal?.type === 'group' && (
        <Dialog title={t('app.editGroup')} onClose={closeModal}>
          <GroupEditor
            state={state}
            bot={state.bots.find((bot) => bot.id === modal.bot)!}
            dispatch={dispatch}
            close={closeModal}
          />
        </Dialog>
      )}
      {modal?.type === 'model' && (
        <Dialog title={t('models.chooseModel')} onClose={closeModal}>
          <ModelPicker
            key={modal.bot}
            bot={state.bots.find((bot) => bot.id === modal.bot)!}
            memory={state.memories[modal.bot]}
            version={state.profileRevisions[agentId(modal.bot)]}
            dispatch={dispatch}
            close={closeModal}
            notify={notify}
          />
        </Dialog>
      )}
      {modal?.type === 'profile' && (
        <Dialog title={t('app.editBotProfile')} onClose={closeModal}>
          <Profile
            bot={state.bots.find((bot) => bot.id === modal.bot)!}
            memory={state.memories[modal.bot]}
            version={state.profileRevisions[agentId(modal.bot)]}
            dispatch={dispatch}
            close={closeModal}
            notify={notify}
            onArchive={() => setModal({ type: 'archive', bot: modal.bot })}
            onExport={() => setModal({ type: 'export', bot: modal.bot })}
          />
        </Dialog>
      )}
      {modal?.type === 'archive' &&
        (state.bots.find((entry) => entry.id === modal.bot)?.members ? (
          <GroupArchive
            key={modal.bot}
            state={state}
            bot={state.bots.find((entry) => entry.id === modal.bot)!}
            dispatch={dispatch}
            close={closeModal}
            notify={notify}
            navigate={() => {
              dispatch({ type: 'select', bot: modal.bot });
              closeModal();
            }}
          />
        ) : (
          <Archive
            key={modal.bot}
            state={state}
            bot={state.bots.find((entry) => entry.id === modal.bot)!}
            dispatch={dispatch}
            close={closeModal}
            notify={notify}
            navigate={(id, next) => {
              dispatch({ type: 'select', bot: id });
              if (next) dispatch({ type: 'panel', panel: next });
              closeModal();
            }}
          />
        ))}
      <CopyGroup
        state={state}
        dispatch={dispatch}
        open={modal?.type === 'group-copy'}
        group={modal?.type === 'group-copy' ? modal.group : undefined}
        close={closeModal}
        notify={notify}
      />
      <CopyBot
        state={state}
        dispatch={dispatch}
        open={modal?.type === 'copy'}
        bot={modal?.type === 'copy' ? modal.bot : undefined}
        close={closeModal}
        notify={notify}
      />
      <ImportBot
        state={state}
        dispatch={dispatch}
        open={modal?.type === 'import'}
        close={closeModal}
        notify={notify}
      />
      {modal?.type === 'export' && (
        <Dialog title={t('common.exportBot')} onClose={closeModal}>
          <ExportBot bot={modal.bot} close={closeModal} notify={notify} />
        </Dialog>
      )}
      {modal?.type === 'create' && (
        <Dialog
          title={modal.group ? t('common.createGroup') : t('app.meetNewCompanion')}
          onClose={closeModal}
        >
          <Create
            key={modal.preset?.id ?? 'custom'}
            preset={modal.preset}
            state={state}
            dispatch={dispatch}
            group={modal.group}
            close={closeModal}
            onImport={() => setModal({ type: 'import' })}
            persist={
              runtime.enabled
                ? async (profile: BotProfileInput) => {
                    await runtime.command<BotProfile>({ type: 'bot.register', profile });
                  }
                : undefined
            }
            persistGroup={
              runtime.enabled
                ? async (input) => {
                    const group = await runtime.command<Group>({
                      type: 'group.register',
                      group: input,
                    });
                    dispatch({ type: 'groups', groups: [group] });
                  }
                : undefined
            }
            notify={notify}
          />
        </Dialog>
      )}
      {modal?.type === 'file' && (
        <Dialog title={modal.file.name} onClose={closeModal} wide>
          <p className="file-preview-meta">
            {modal.file.kind} · {modal.file.size}
          </p>
          {modal.file.upload && !imageMime(modal.file.upload.name) && (
            <p className="inline-note">{t('app.showingExtractedTextImagesLayoutFormulasNot')}</p>
          )}
          {imageMime(modal.file.upload?.name || modal.file.name) ? (
            <ImagePreview
              key={`${modal.file.upload?.bot || ''}:${modal.file.id}`}
              file={modal.file}
            />
          ) : (
            <pre className="file-content">{modal.file.content}</pre>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={closeModal}>
              {t('app.closePreview')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!!modal.file.upload && runtime.snapshot.phase !== 'ready'}
              onClick={async () => {
                const file = modal.file;
                if (file.runtimePath && imageMime(file.name)) {
                  try {
                    const original = await runtime.command<RuntimeDownload>({
                      type: 'files.download',
                      path: file.runtimePath,
                      ...file.runtimeScope,
                    });
                    const bytes = Uint8Array.from(atob(original.data), (character) =>
                      character.charCodeAt(0),
                    );
                    downloadBlob(
                      original.name,
                      new Blob([bytes], { type: 'application/octet-stream' }),
                    );
                  } catch (error) {
                    notify(runtimeError(error));
                  }
                  return;
                }
                if (!file.upload) {
                  download(file);
                  return;
                }
                try {
                  const original = await runtime.command<DocumentOriginal>({
                    type: 'attachment.source',
                    bot: file.upload.bot,
                    id: file.upload.id,
                  });
                  const bytes = Uint8Array.from(atob(original.file.data), (character) =>
                    character.charCodeAt(0),
                  );
                  downloadBlob(
                    original.file.name,
                    new Blob([bytes], { type: 'application/octet-stream' }),
                  );
                } catch (error) {
                  notify(runtimeError(error));
                }
              }}
            >
              <Download />
              {modal.file.upload ? t('app.downloadOriginal') : t('app.downloadFile')}
            </button>
            {modal.file.upload && !imageMime(modal.file.upload.name) && (
              <button type="button" className="secondary" onClick={() => download(modal.file)}>
                {t('common.downloadExtractedText')}
              </button>
            )}
          </div>
        </Dialog>
      )}
      {computerBot && runtime.enabled && (
        <Dialog title={t('app.computer', { 0: computerBot.name })} onClose={closeModal} wide>
          <Computer
            bot={computerBot}
            notify={notify}
            expanded
            onRecovery={() => setModal({ type: 'recovery' })}
            initialView={modal?.type === 'computer' ? modal.surface : undefined}
          />
        </Dialog>
      )}
      {computerBot && !runtime.enabled && (
        <Dialog title={t('app.computer', { 0: computerBot.name })} onClose={closeModal} wide>
          <p className="dialog-description">{t('app.linuxDesktopPreviewNoRealSystemConnected')}</p>
          <Desktop
            name={computerBot.name}
            human={state.controls[computerBot.id] === 'human'}
            expanded
          />
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={closeModal}>
              {t('common.collapse')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() =>
                dispatch({
                  type: 'control',
                  bot: computerBot.id,
                  owner: state.controls[computerBot.id] === 'human' ? 'agent' : 'human',
                })
              }
            >
              {state.controls[computerBot.id] === 'human' ? <Check /> : <Monitor />}
              {state.controls[computerBot.id] === 'human'
                ? t('common.handBackBot')
                : t('common.takeOverComputer')}
            </button>
          </div>
        </Dialog>
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <Info />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}
