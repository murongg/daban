import {
  agentId,
  isApprovalMode,
  isAttachmentRef,
  isBotCopyRequest,
  isBotImportReference,
  isBotLifecycleRequest,
  isChatRequest,
  isConversationRequest,
  isConversationState,
  isGroupActionRequest,
  isGroupCopyRequest,
  isGroupSend,
  isKnowledgeContent,
  isModelId,
  isScheduleInput,
  validAgentId,
} from '@daban/protocol';
import { readMentions } from '../../shared/mentions';
import { draftPrompt, draftTextLimit } from '../features/chat/conversations';
import { restoreNotes } from '../features/notes/notes-state';
import { restoreComments } from '../features/tasks/comments-state';
import { restoreWork } from '../features/tasks/work-state';
import { restoreOrganization } from './organization';
import { removeSamples } from './samples';
import { initialState, routineDraft, type State } from './state';

export const storageKey = 'daban.workspace.v1';
export function serialize(state: State) {
  return JSON.stringify({
    version: 1,
    state: {
      ...state,
      // Older rollback clients reject unknown root views; preserve the stored data behind new views.
      view: ['tasks', 'gallery'].includes(state.view) ? 'chat' : state.view,
      panel: state.panel === 'notes' ? null : state.panel,
      files: state.files.map((file) => (file.upload ? { ...file, content: '' } : file)),
      profileRevisions: {},
      chatStates: {},
      groupRevisions: {},
      attachmentUploads: {},
      // Queued messages belong to the live session; a reload must not send them unattended.
      queued: {},
    },
  });
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');
const textFields = (value: unknown, fields: string[]) =>
  record(value) && fields.every((key) => typeof value[key] === 'string');
const choice = (value: unknown, choices: unknown[]) => choices.includes(value);
function restoreFolders(value: unknown, text: string) {
  const folders = strings(value) ? [...new Set(value.filter((path) => !!path))] : [];
  return text.length <= draftTextLimit(folders) && draftPrompt(text, folders).length <= 12000
    ? folders
    : [];
}

export function restore(raw: string | null): State {
  try {
    const saved: unknown = JSON.parse(raw || 'null');
    if (!record(saved) || saved.version !== 1 || !record(saved.state)) return initialState();
    const s = saved.state;
    s.comments = restoreComments(s.comments);
    s.work = restoreWork(s.work);
    if (s.comments === undefined) delete s.comments;
    if (s.work === undefined) delete s.work;
    if (!isBotImportReference(s.botImport)) delete s.botImport;
    if (!isBotCopyRequest(s.botCopy)) delete s.botCopy;
    if (!isGroupCopyRequest(s.groupCopy)) delete s.groupCopy;
    s.groupRevisions = {};
    if (!record(s.groupRequests)) s.groupRequests = {};
    s.groupRequests = Object.fromEntries(
      Object.entries(s.groupRequests as Record<string, unknown>).filter(
        ([id, value]) => value === undefined || (isGroupSend(value) && value.group === id),
      ),
    );
    if (!record(s.groupTargets)) s.groupTargets = {};
    s.groupTargets = Object.fromEntries(
      Object.entries(s.groupTargets as Record<string, unknown>).filter(
        ([, value]) =>
          value === '*' || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)),
      ),
    );
    if (
      !Array.isArray(s.bots) ||
      !s.bots.every(
        (b) =>
          textFields(b, ['id', 'name', 'role', 'preview', 'time']) &&
          record(b) &&
          choice(b.color, ['mint', 'violet', 'orange', 'blue', 'teal', 'pink']) &&
          (b.members === undefined || strings(b.members)),
      )
    )
      return initialState();
    // A damaged optional model cache must not discard the user's otherwise valid messages and drafts.
    for (const bot of s.bots)
      if (record(bot) && bot.model !== undefined && !isModelId(bot.model)) delete bot.model;
    const bots = s.bots;
    const ids = bots.map((b) => b.id as string);
    for (const bot of bots) {
      if (bot.kind !== 'chat') delete bot.kind;
      if (bot.kind !== 'chat' || !validAgentId(bot.assistant) || bot.assistant === agentId(bot.id))
        delete bot.assistant;
    }
    const conversationKey = (key: string) => {
      const split = key.lastIndexOf(':');
      return (
        ids.includes(key.slice(0, split)) &&
        /^\d+$/.test(key.slice(split + 1)) &&
        Number.isSafeInteger(Number(key.slice(split + 1)))
      );
    };
    s.conversationSelections = Object.fromEntries(
      Object.entries(record(s.conversationSelections) ? s.conversationSelections : {}).filter(
        ([bot, revision]) =>
          ids.includes(bot) && Number.isSafeInteger(revision) && Number(revision) >= 0,
      ),
    );
    s.conversationModels = Object.fromEntries(
      Object.entries(record(s.conversationModels) ? s.conversationModels : {}).filter(
        ([key, model]) => conversationKey(key) && isModelId(model),
      ),
    );
    s.conversationTitles = Object.fromEntries(
      Object.entries(record(s.conversationTitles) ? s.conversationTitles : {}).filter(
        ([key, title]) => conversationKey(key) && typeof title === 'string' && title.length <= 120,
      ),
    );
    s.conversationPlacements = Object.fromEntries(
      Object.entries(record(s.conversationPlacements) ? s.conversationPlacements : {}).filter(
        ([key, placement]) =>
          conversationKey(key) &&
          (placement === 'recent' || placement === 'pinned' || placement === 'archived'),
      ),
    );
    s.conversationStates = Object.fromEntries(
      Object.entries(record(s.conversationStates) ? s.conversationStates : {}).filter(
        ([key, value]) =>
          conversationKey(key) &&
          isConversationState(value) &&
          bots.some(
            (bot) => key === `${bot.id}:${value.revision}` && agentId(String(bot.id)) === value.bot,
          ),
      ),
    );
    s.conversationRequests = Object.fromEntries(
      Object.entries(record(s.conversationRequests) ? s.conversationRequests : {}).filter(
        ([key, value]) =>
          conversationKey(key) &&
          isConversationRequest(value) &&
          bots.some(
            (bot) => key === `${bot.id}:${value.revision}` && agentId(String(bot.id)) === value.bot,
          ),
      ),
    );
    s.conversationDrafts = Object.fromEntries(
      Object.entries(record(s.conversationDrafts) ? s.conversationDrafts : {}).flatMap(
        ([key, draft]) => {
          if (
            !conversationKey(key) ||
            !record(draft) ||
            typeof draft.text !== 'string' ||
            !strings(draft.attachments)
          )
            return [];
          return [
            [
              key,
              {
                text: draft.text,
                folders: restoreFolders(draft.folders, draft.text),
                attachments: draft.attachments,
                queued: [],
                ...(isApprovalMode(draft.mode) ? { mode: draft.mode } : {}),
                ...(draft.mode === 'full' && draft.browserAutoStart === true
                  ? { browserAutoStart: true }
                  : {}),
              },
            ],
          ];
        },
      ),
    );
    s.approvalModes = Object.fromEntries(
      Object.entries(record(s.approvalModes) ? s.approvalModes : {}).filter(
        ([bot, value]) =>
          ids.includes(bot) &&
          record(value) &&
          Number.isSafeInteger(value.revision) &&
          Number(value.revision) >= 0 &&
          isApprovalMode(value.mode),
      ),
    );
    // Optional private editor damage must not reset chats or another Bot's pending operation.
    if (s.notes !== undefined)
      s.notes = Object.fromEntries(
        bots
          .filter((bot) => !bot.members)
          .flatMap((bot) => {
            const id = bot.id as string;
            const value = restoreNotes(
              record(s.notes) ? s.notes[id] : s.notes === undefined ? undefined : null,
              agentId(id),
            );
            return value ? [[id, value]] : [];
          }),
      );
    // Organization is optional local metadata; its damage must not discard messages or pending work.
    s.organization = restoreOrganization(s.organization, ids);
    s.chatStates = {};
    s.chatRequests = Object.fromEntries(
      Object.entries(record(s.chatRequests) ? s.chatRequests : {}).filter(
        ([id, value]) =>
          isChatRequest(value) &&
          value.bot === agentId(id) &&
          bots.some((bot) => record(bot) && bot.id === id && !bot.members),
      ),
    );
    if (!record(s.groupActions)) s.groupActions = {};
    s.groupActions = Object.fromEntries(
      Object.entries(s.groupActions as Record<string, unknown>).filter(
        ([id, value]) =>
          value === undefined ||
          (isGroupActionRequest(value) &&
            value.group === id &&
            bots.some((bot) => record(bot) && bot.id === id && Array.isArray(bot.members))),
      ),
    );
    for (const bot of s.bots)
      if (record(bot) && typeof bot.archived !== 'boolean') delete bot.archived;
    if (!record(s.lifecycleRequests)) s.lifecycleRequests = {};
    s.lifecycleRequests = Object.fromEntries(
      Object.entries(s.lifecycleRequests as Record<string, unknown>).filter(
        ([bot, request]) =>
          ids.includes(bot) && isBotLifecycleRequest(request) && request.bot === agentId(bot),
      ),
    );
    if (!record(s.skillDrafts)) s.skillDrafts = {};
    // A damaged optional editor cache must not discard chats, other drafts or the backend skill library.
    s.skillDrafts = Object.fromEntries(
      Object.entries(s.skillDrafts as Record<string, unknown>).filter(
        ([bot, draft]) =>
          ids.includes(bot) &&
          record(draft) &&
          Object.keys(draft).every((key) =>
            ['id', 'revision', 'content', 'baseContent', 'deleted'].includes(key),
          ) &&
          textFields(draft, ['content', 'baseContent']) &&
          String(draft.content).length <= 200000 &&
          String(draft.baseContent).length <= 100000 &&
          Number.isSafeInteger(draft.revision) &&
          Number(draft.revision) >= 0 &&
          typeof draft.deleted === 'boolean' &&
          (draft.id === undefined || validAgentId(draft.id)),
      ),
    );
    s.attachmentUploads = {};
    // Queued messages belong to the live session; a reload must not send them unattended.
    s.queued = {};
    if (s.knowledgeDrafts === undefined) s.knowledgeDrafts = {};
    if (!record(s.knowledgeDrafts)) s.knowledgeDrafts = {};
    // An unsaved draft may exceed the server byte quota; retain editable text so repair does not erase the workspace.
    s.knowledgeDrafts = Object.fromEntries(
      Object.entries(s.knowledgeDrafts as Record<string, unknown>).filter(
        ([bot, draft]) =>
          ids.includes(bot) &&
          record(draft) &&
          textFields(draft, ['path', 'content', 'basePath', 'baseContent']) &&
          String(draft.path).length <= 240 &&
          String(draft.basePath).length <= 240 &&
          typeof draft.content === 'string' &&
          draft.content.length <= 204800 &&
          isKnowledgeContent(draft.baseContent) &&
          Number.isSafeInteger(draft.revision) &&
          Number(draft.revision) >= 0 &&
          typeof draft.deleted === 'boolean' &&
          (draft.id === undefined || typeof draft.id === 'string'),
      ),
    );
    if (
      new Set(ids).size !== ids.length ||
      (s.selected !== '' && !ids.includes(s.selected as string)) ||
      !choice(s.view, ['chat', 'inbox', 'settings', 'tasks', 'gallery']) ||
      !choice(s.panel, [
        null,
        'computer',
        'files',
        'knowledge',
        'skills',
        'memory',
        'routines',
        'notes',
      ]) ||
      !choice(s.theme, ['light', 'dark'])
    )
      return initialState();
    for (const key of ['messages', 'drafts', 'controls', 'memories', 'attachments'])
      if (!record(s[key])) return initialState();
    const folderDrafts = record(s.draftFolders) ? s.draftFolders : {};
    s.draftFolders = Object.fromEntries(
      Object.entries(folderDrafts)
        .filter(([id]) => ids.includes(id))
        .map(([id, folders]) => [
          id,
          restoreFolders(folders, String((s.drafts as Record<string, unknown>)[id] ?? '')),
        ]),
    );
    // Older v1 snapshots predate persistent form drafts; retain their saved work when extending the schema.
    if (s.memoryDrafts === undefined)
      s.memoryDrafts = { ...(s.memories as Record<string, string>) };
    if (s.routineDrafts === undefined)
      s.routineDrafts = Object.fromEntries(ids.map((id) => [id, routineDraft()]));
    if (!record(s.memoryDrafts) || !record(s.routineDrafts)) return initialState();
    if (
      !record(s.replyDrafts) ||
      !Object.values(s.replyDrafts).every(
        (draft) =>
          record(draft) &&
          Object.values(draft).every(
            (answer) =>
              record(answer) &&
              strings(answer.selected) &&
              answer.selected.length <= 8 &&
              answer.selected.every((label) => label.length <= 100) &&
              typeof answer.custom === 'string' &&
              answer.custom.length <= 4000,
          ),
      )
    )
      s.replyDrafts = {};
    if (s.memoryVersions === undefined) s.memoryVersions = {};
    if (
      !record(s.memoryVersions) ||
      Object.values(s.memoryVersions).some(
        (value) => !Number.isSafeInteger(value) || Number(value) < 0,
      )
    )
      return initialState();
    // A renderer cache must not reject valid records after adopting a restored or different backend.
    s.profileRevisions = {};
    if (s.runtimeRequests === undefined) s.runtimeRequests = {};
    if (!record(s.runtimeRequests)) return initialState();
    for (const request of Object.values(s.runtimeRequests)) {
      if (
        request !== undefined &&
        (!record(request) ||
          typeof request.requestId !== 'string' ||
          typeof request.prompt !== 'string')
      )
        return initialState();
    }
    // Attachment references captured for a pending send survive a reload; damaged entries are dropped alone.
    s.runtimeRefs = Object.fromEntries(
      Object.entries(record(s.runtimeRefs) ? s.runtimeRefs : {}).filter(
        ([, value]) => value === undefined || strings(value),
      ),
    );
    const { messages, drafts, controls, memories, attachments, memoryDrafts, routineDrafts } =
      s as Record<string, Record<string, unknown>>;
    for (const id of ids) {
      const form = routineDrafts[id];
      if (
        typeof memoryDrafts[id] !== 'string' ||
        !textFields(form, ['title', 'instruction', 'frequency', 'time']) ||
        !record(form) ||
        typeof form.open !== 'boolean'
      )
        return initialState();
      // A broken or foreign optional request must not discard editable text or unrelated work.
      if (
        form.pending !== undefined &&
        (!isScheduleInput(form.pending) || form.pending.bot !== agentId(id))
      )
        delete form.pending;
      if (
        ['zone', 'date', 'interval', 'cron', 'editId'].some(
          (key) => form[key] !== undefined && typeof form[key] !== 'string',
        ) ||
        (form.revision !== undefined &&
          (!Number.isSafeInteger(form.revision) || Number(form.revision) < 1)) ||
        (form.weekdays !== undefined &&
          (!Array.isArray(form.weekdays) ||
            form.weekdays.length > 7 ||
            !form.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)))
      )
        return initialState();
      if (
        typeof drafts[id] !== 'string' ||
        typeof memories[id] !== 'string' ||
        !choice(controls[id], ['agent', 'human']) ||
        !strings(attachments[id])
      )
        return initialState();
      const entries = messages[id];
      if (
        !Array.isArray(entries) ||
        !entries.every(
          (m) =>
            textFields(m, ['id', 'text']) &&
            record(m) &&
            choice(m.role, ['user', 'bot', 'activity', 'notice']) &&
            (m.files === undefined || strings(m.files)) &&
            (m.references === undefined || strings(m.references)) &&
            (m.author === undefined || typeof m.author === 'string'),
        )
      )
        return initialState();
    }
    if (
      !Array.isArray(s.files) ||
      !s.files.every((f) => textFields(f, ['id', 'name', 'kind', 'size', 'modified', 'content']))
    )
      return initialState();
    s.files = s.files.filter(
      (file) => record(file) && (file.upload === undefined || isAttachmentRef(file.upload)),
    );
    const fileIds = new Set((s.files as { id: string }[]).map((file) => file.id));
    if (record(s.conversationDrafts))
      for (const draft of Object.values(s.conversationDrafts))
        if (record(draft) && strings(draft.attachments))
          draft.attachments = draft.attachments.filter((id) => fileIds.has(id));
    for (const id of ids)
      attachments[id] = (attachments[id] as string[]).filter((file) => fileIds.has(file));
    if (
      !Array.isArray(s.routines) ||
      !s.routines.every(
        (r) =>
          textFields(r, ['id', 'bot', 'title', 'instruction', 'schedule']) &&
          record(r) &&
          typeof r.enabled === 'boolean' &&
          ids.includes(r.bot as string),
      )
    )
      return initialState();
    if (
      !Array.isArray(s.approvals) ||
      !s.approvals.every(
        (a) =>
          textFields(a, ['id', 'bot', 'title', 'description', 'detail']) &&
          record(a) &&
          choice(a.status, ['pending', 'approved', 'rejected']) &&
          ids.includes(a.bot as string),
      )
    )
      return initialState();
    // Versioned browser storage is untrusted input; reject a partial snapshot instead of merging broken Bot records.
    s.groupMentions = Object.fromEntries(
      Object.entries(record(s.groupMentions) ? s.groupMentions : {}).flatMap(([id, value]) => {
        if (!bots.some((bot) => bot.id === id && Array.isArray(bot.members))) return [];
        const draft = record(s.drafts) && typeof s.drafts[id] === 'string' ? s.drafts[id] : '';
        return [[id, readMentions(value, draft)]];
      }),
    );
    return removeSamples(s as unknown as State);
  } catch {
    return initialState();
  }
}
