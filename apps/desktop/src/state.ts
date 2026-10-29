import {
  type AttachmentRef,
  agentId,
  type BotImportReference,
  type BotLifecycleRequest,
  type BotProfile,
  type ChatRequest,
  type ChatState,
  type ChatStatus,
  type DeepSeekModel,
  type Group,
  type GroupActionRequest,
  type GroupSend,
  isBotImportReference,
  isBotLifecycleRequest,
  isBotProfile,
  isChatRequest,
  isChatState,
  isGroup,
  isGroupActionRequest,
  isKnowledgeDocument,
  isSkillDocument,
  type KnowledgeDocument,
  type RuntimeTaskSummary,
  type ScheduleInput,
  type SkillDocument,
  type TaskRequest,
  validAgentId,
} from '@daban/protocol';
import { taskFile } from './files';
import * as fixture from './fixtures';

export type Color = 'mint' | 'violet' | 'orange' | 'blue' | 'teal' | 'pink';
export function chatRevision(state: Pick<State, 'chatStates'>, bot: string, latest?: ChatStatus) {
  return Math.max(
    state.chatStates[bot]?.revision ?? 0,
    latest?.items.find((item) => item.bot === agentId(bot))?.revision ?? 0,
  );
}
export type Panel = 'computer' | 'files' | 'knowledge' | 'skills' | 'memory' | 'routines';
export interface SkillDraft {
  id?: string;
  revision: number;
  content: string;
  baseContent: string;
  deleted: boolean;
}
export function skillDraft(document?: SkillDocument): SkillDraft {
  return document
    ? {
        id: document.id,
        revision: document.revision,
        content: document.content,
        baseContent: document.content,
        deleted: document.deleted,
      }
    : {
        revision: 0,
        content: '---\nname: \ndescription: \n---\n\n',
        baseContent: '',
        deleted: false,
      };
}
export const skillDirty = (draft: SkillDraft) => !draft.id || draft.content !== draft.baseContent;
export function skillEditor(state: Pick<State, 'skillDrafts'>, bot: string) {
  // IDs such as constructor are valid; inherited object properties are never editor state.
  return Object.hasOwn(state.skillDrafts, bot) ? state.skillDrafts[bot] : undefined;
}
export interface KnowledgeDraft {
  id?: string;
  path: string;
  content: string;
  revision: number;
  deleted: boolean;
  basePath: string;
  baseContent: string;
}
export function knowledgeDraft(document?: KnowledgeDocument): KnowledgeDraft {
  return document
    ? {
        id: document.id,
        path: document.path,
        content: document.content,
        revision: document.revision,
        deleted: document.deleted,
        basePath: document.path,
        baseContent: document.content,
      }
    : {
        path: '新资料.md',
        content: '',
        revision: 0,
        deleted: false,
        basePath: '',
        baseContent: '',
      };
}
export const knowledgeDirty = (draft: KnowledgeDraft) =>
  !draft.id || draft.path !== draft.basePath || draft.content !== draft.baseContent;
export type Owner = 'agent' | 'human';
export type Theme = 'light' | 'dark';
export type View = 'chat' | 'inbox' | 'settings';
export interface Bot {
  archived?: boolean;
  model?: DeepSeekModel;
  id: string;
  name: string;
  role: string;
  color: Color;
  preview: string;
  time: string;
  members?: string[];
}
export interface Message {
  chatRevision?: number;
  incomplete?: boolean;
  id: string;
  role: 'user' | 'bot' | 'activity' | 'notice';
  text: string;
  files?: string[];
  handoff?: boolean;
  author?: string;
}
export interface Routine {
  id: string;
  bot: string;
  title: string;
  instruction: string;
  schedule: string;
  enabled: boolean;
}
export interface Approval {
  id: string;
  bot: string;
  title: string;
  description: string;
  detail: string;
  status: 'pending' | 'approved' | 'rejected';
  file?: string;
  handoff?: boolean;
}
export interface WorkspaceFile {
  upload?: AttachmentRef;
  id: string;
  name: string;
  kind: string;
  size: string;
  modified: string;
  content: string;
  runtimePath?: string;
}
export interface RoutineDraft {
  open: boolean;
  title: string;
  instruction: string;
  frequency: string;
  time: string;
  zone?: string;
  date?: string;
  interval?: string;
  cron?: string;
  weekdays?: number[];
  editId?: string;
  revision?: number;
  pending?: ScheduleInput;
}
export function routineDraft(): RoutineDraft {
  return { open: false, title: '', instruction: '', frequency: '每天', time: '09:00' };
}
export interface State {
  botImport?: BotImportReference;
  lifecycleRequests: Record<string, BotLifecycleRequest | undefined>;
  skillDrafts: Record<string, SkillDraft | undefined>;
  groupRequests: Record<string, GroupSend | undefined>;
  groupActions: Record<string, GroupActionRequest | undefined>;
  chatStates: Record<string, ChatState>;
  chatRequests: Record<string, ChatRequest | undefined>;
  groupRevisions: Record<string, number>;
  groupTargets: Record<string, string>;
  knowledgeDrafts: Record<string, KnowledgeDraft | undefined>;
  replyDrafts: Record<string, Record<string, { selected: string[]; custom: string }>>;
  selected: string;
  view: View;
  panel: Panel | null;
  theme: Theme;
  bots: Bot[];
  messages: Record<string, Message[]>;
  drafts: Record<string, string>;
  controls: Record<string, Owner>;
  memories: Record<string, string>;
  memoryDrafts: Record<string, string>;
  memoryVersions: Record<string, number>;
  routineDrafts: Record<string, RoutineDraft>;
  routines: Routine[];
  approvals: Approval[];
  files: WorkspaceFile[];
  attachments: Record<string, string[]>;
  attachmentUploads: Record<string, boolean>;
  runtimeRequests: Record<string, TaskRequest | undefined>;
  profileRevisions: Record<string, number>;
}
export function lifecycleRequest(
  state: State,
  bot: string,
  profile?: BotProfile,
): BotLifecycleRequest | undefined {
  const cached = Object.hasOwn(state.lifecycleRequests, bot)
    ? state.lifecycleRequests[bot]
    : undefined;
  if (cached) return cached;
  if (profile?.id !== agentId(bot) || profile.lifecycle?.phase !== 'pending') return undefined;
  return {
    id: profile.lifecycle.id,
    bot: profile.id,
    action: profile.lifecycle.action,
    revision: profile.lifecycle.baseRevision,
  };
}
export type Action =
  | { type: 'bot-import-pending'; reference: BotImportReference }
  | { type: 'bot-import-cancel' | 'bot-import-clear'; id: string; sha256: string }
  | { type: 'lifecycle-pending'; bot: string; request: BotLifecycleRequest }
  | { type: 'lifecycle-clear'; bot: string; id: string }
  | { type: 'skill-set'; bot: string; draft?: SkillDraft }
  | { type: 'skill-stage'; bot: string; previous?: SkillDraft; draft: SkillDraft }
  | { type: 'skill-change'; bot: string; content: string }
  | { type: 'skill-load'; bot: string; previous?: SkillDraft; document: SkillDocument }
  | { type: 'groups'; groups: Group[] }
  | { type: 'group-action-pending'; request: GroupActionRequest }
  | { type: 'group-action-clear'; group: string; id: string }
  | { type: 'group-pending'; group: string; input: GroupSend }
  | { type: 'group-sent'; group: string; input: GroupSend }
  | { type: 'group-clear'; group: string; id: string }
  | { type: 'group-target'; group: string; target: string }
  | { type: 'knowledge-set'; bot: string; draft?: KnowledgeDraft }
  | { type: 'knowledge-stage'; bot: string; previous?: KnowledgeDraft; draft: KnowledgeDraft }
  | { type: 'knowledge-change'; bot: string; draft: Partial<KnowledgeDraft> }
  | { type: 'knowledge-load'; bot: string; previous?: KnowledgeDraft; document: KnowledgeDocument }
  | { type: 'reply-draft'; id: string; question: string; selected?: string[]; custom?: string }
  | { type: 'profiles'; profiles: BotProfile[] }
  | { type: 'profile-local'; bot: string; name: string; instructions: string }
  | { type: 'runtime-pending'; bot: string; task: TaskRequest }
  | { type: 'chats'; items: ChatState[] }
  | { type: 'chat-pending'; bot: string; request: ChatRequest }
  | { type: 'chat-clear'; bot: string; id: string }
  | { type: 'runtime-clear'; bot: string }
  | { type: 'attachment-uploading'; bot: string; uploading: boolean }
  | { type: 'runtime-task'; bot: string; task: RuntimeTaskSummary }
  | { type: 'select'; bot: string }
  | { type: 'view'; view: View }
  | { type: 'panel'; panel: Panel | null }
  | { type: 'theme'; theme: Theme }
  | { type: 'control'; bot: string; owner: Owner }
  | { type: 'draft'; bot: string; text: string }
  | { type: 'send'; bot: string; id: string; time: string }
  | { type: 'memory-draft'; bot: string; text: string }
  | { type: 'routine-draft'; bot: string; draft: Partial<RoutineDraft> }
  | { type: 'routine-saved'; bot: string; draft: RoutineDraft }
  | { type: 'memory'; bot: string; text: string; submitted?: string }
  | { type: 'memory-saved'; bot: string; submitted: string; profile: BotProfile }
  | { type: 'memory-rebase'; bot: string; revision: number }
  | {
      type: 'create';
      id: string;
      name: string;
      role: string;
      color: Color;
      members?: string[];
      model?: DeepSeekModel;
    }
  | { type: 'routine-add'; routine: Routine }
  | { type: 'routine-toggle'; id: string }
  | { type: 'routine-remove'; id: string }
  | { type: 'approval'; id: string; status: 'approved' | 'rejected' }
  | { type: 'attach'; bot: string; file: WorkspaceFile }
  | { type: 'detach'; bot: string; file: string };

export function initialState(): State {
  const memories = Object.fromEntries(
    fixture.bots.map((b) => [
      b.id,
      b.id === 'research'
        ? '表达尽量简洁，先给结论，再补充依据。\n生成的文件先给我预览，确认后再发送。\n不确定的信息单独列出来，不要自行补全。'
        : '',
    ]),
  );
  return {
    lifecycleRequests: {},
    skillDrafts: {},
    groupRequests: {},
    groupActions: {},
    chatStates: {},
    chatRequests: {},
    groupRevisions: {},
    groupTargets: {},
    knowledgeDrafts: {},
    replyDrafts: {},
    runtimeRequests: {},
    profileRevisions: {},
    memoryVersions: {},
    selected: 'research',
    view: 'chat',
    panel: 'computer',
    theme: 'light',
    bots: structuredClone(fixture.bots),
    messages: structuredClone(fixture.messages),
    drafts: Object.fromEntries(fixture.bots.map((b) => [b.id, ''])),
    controls: Object.fromEntries(fixture.bots.map((b) => [b.id, 'agent' as Owner])),
    memories,
    memoryDrafts: { ...memories },
    routineDrafts: Object.fromEntries(fixture.bots.map((b) => [b.id, routineDraft()])),
    routines: structuredClone(fixture.routines),
    approvals: structuredClone(fixture.approvals),
    files: structuredClone(fixture.files),
    attachments: Object.fromEntries(fixture.bots.map((b) => [b.id, []])),
    attachmentUploads: {},
  };
}

export function reduce(state: State, action: Action): State {
  // Target the Bot explicitly: changing the selected screen must never transfer ownership or route async work elsewhere.
  if ('bot' in action && !state.bots.some((b) => b.id === action.bot)) return state;
  switch (action.type) {
    case 'chats': {
      const chatStates = { ...state.chatStates };
      let changed = false;
      for (const chat of action.items) {
        const bot = state.bots.find((bot) => !bot.members && agentId(bot.id) === chat.bot);
        if (!bot || !isChatState(chat) || chat.revision <= (chatStates[bot.id]?.revision ?? -1))
          continue;
        chatStates[bot.id] = chat;
        changed = true;
      }
      return changed ? { ...state, chatStates } : state;
    }
    case 'chat-pending':
      return isChatRequest(action.request) &&
        action.request.bot === agentId(action.bot) &&
        !state.chatRequests[action.bot]
        ? { ...state, chatRequests: { ...state.chatRequests, [action.bot]: action.request } }
        : state;
    case 'chat-clear':
      return state.chatRequests[action.bot]?.id === action.id
        ? { ...state, chatRequests: { ...state.chatRequests, [action.bot]: undefined } }
        : state;
    case 'bot-import-pending': {
      if (!isBotImportReference(action.reference)) return state;
      const current = state.botImport;
      if (
        current &&
        (current.id !== action.reference.id ||
          current.sha256 !== action.reference.sha256 ||
          current.size !== action.reference.size)
      )
        return state;
      return {
        ...state,
        botImport: {
          ...action.reference,
          ...(current?.cancelRequested ? { cancelRequested: true } : {}),
        },
      };
    }
    case 'bot-import-cancel':
      return state.botImport?.id === action.id && state.botImport.sha256 === action.sha256
        ? { ...state, botImport: { ...state.botImport, cancelRequested: true } }
        : state;
    case 'bot-import-clear':
      return state.botImport?.id === action.id && state.botImport.sha256 === action.sha256
        ? { ...state, botImport: undefined }
        : state;
    case 'lifecycle-pending':
      return isBotLifecycleRequest(action.request) && action.request.bot === agentId(action.bot)
        ? {
            ...state,
            lifecycleRequests: { ...state.lifecycleRequests, [action.bot]: action.request },
          }
        : state;
    case 'lifecycle-clear':
      return lifecycleRequest(state, action.bot)?.id === action.id
        ? { ...state, lifecycleRequests: { ...state.lifecycleRequests, [action.bot]: undefined } }
        : state;
    case 'group-action-pending':
      return isGroupActionRequest(action.request) &&
        state.bots.some((bot) => bot.id === action.request.group && !!bot.members) &&
        !state.groupActions[action.request.group]
        ? {
            ...state,
            groupActions: { ...state.groupActions, [action.request.group]: action.request },
          }
        : state;
    case 'group-action-clear':
      return state.groupActions[action.group]?.id === action.id
        ? { ...state, groupActions: { ...state.groupActions, [action.group]: undefined } }
        : state;
    case 'groups': {
      let next = state;
      for (const group of action.groups) {
        if (!isGroup(group) || group.revision < (next.groupRevisions[group.id] || 0)) continue;
        const members = group.members.map(
          (id) => next.bots.find((bot) => !bot.members && agentId(bot.id) === id)?.id,
        );
        if (members.some((id) => !id)) continue;
        const existing = next.bots.find((bot) => bot.id === group.id);
        if (existing && !existing.members) continue;
        if (!existing) {
          const selected = next.selected,
            view = next.view,
            panel = next.panel;
          next = reduce(next, {
            type: 'create',
            id: group.id,
            name: group.name,
            role: '',
            color: 'mint',
            members: members as string[],
          });
          next = { ...next, selected, view, panel };
        }
        if (
          next.groupRevisions[group.id] === group.revision &&
          !!existing?.archived === !!group.archived
        )
          continue;
        next = {
          ...next,
          groupRevisions: { ...next.groupRevisions, [group.id]: group.revision },
          bots: next.bots.map((bot) =>
            bot.id === group.id
              ? {
                  ...bot,
                  name: group.name,
                  role: `${members.length} 位 Bot 的群聊`,
                  members: members as string[],
                  archived: !!group.archived,
                }
              : bot,
          ),
        };
      }
      return next;
    }
    case 'group-target':
      return { ...state, groupTargets: { ...state.groupTargets, [action.group]: action.target } };
    case 'group-pending':
      return {
        ...state,
        groupRequests: { ...state.groupRequests, [action.group]: structuredClone(action.input) },
      };
    case 'group-clear':
      return state.groupRequests[action.group]?.id === action.id
        ? { ...state, groupRequests: { ...state.groupRequests, [action.group]: undefined } }
        : state;
    case 'group-sent': {
      if (state.groupRequests[action.group]?.id !== action.input.id) return state;
      const attached = state.attachments[action.group]
        .map((id) => state.files.find((file) => file.id === id))
        .filter((file): file is WorkspaceFile => !!file)
        .map(taskFile);
      return {
        ...state,
        groupRequests: { ...state.groupRequests, [action.group]: undefined },
        drafts:
          state.drafts[action.group].trim() === action.input.prompt.trim()
            ? { ...state.drafts, [action.group]: '' }
            : state.drafts,
        attachments:
          JSON.stringify(attached) === JSON.stringify(action.input.files || [])
            ? { ...state.attachments, [action.group]: [] }
            : state.attachments,
      };
    }
    case 'skill-set':
      return { ...state, skillDrafts: { ...state.skillDrafts, [action.bot]: action.draft } };
    case 'skill-stage':
      return JSON.stringify(skillEditor(state, action.bot)) === JSON.stringify(action.previous)
        ? { ...state, skillDrafts: { ...state.skillDrafts, [action.bot]: action.draft } }
        : state;
    case 'skill-change': {
      const draft = skillEditor(state, action.bot);
      return draft
        ? {
            ...state,
            skillDrafts: {
              ...state.skillDrafts,
              [action.bot]: { ...draft, content: action.content },
            },
          }
        : state;
    }
    case 'skill-load':
      // The shared library may change while this Bot's editor is open; a late acknowledgement cannot replace newer typing.
      return isSkillDocument(action.document) &&
        JSON.stringify(skillEditor(state, action.bot)) === JSON.stringify(action.previous)
        ? {
            ...state,
            skillDrafts: { ...state.skillDrafts, [action.bot]: skillDraft(action.document) },
          }
        : state;
    case 'knowledge-set':
      return {
        ...state,
        knowledgeDrafts: { ...state.knowledgeDrafts, [action.bot]: action.draft },
      };
    case 'knowledge-stage':
      return JSON.stringify(state.knowledgeDrafts[action.bot]) === JSON.stringify(action.previous)
        ? { ...state, knowledgeDrafts: { ...state.knowledgeDrafts, [action.bot]: action.draft } }
        : state;
    case 'knowledge-change':
      return state.knowledgeDrafts[action.bot]
        ? {
            ...state,
            knowledgeDrafts: {
              ...state.knowledgeDrafts,
              [action.bot]: { ...state.knowledgeDrafts[action.bot]!, ...action.draft },
            },
          }
        : state;
    case 'knowledge-load':
      // An async read/save owns its original Bot and base draft; a late reply must not replace new edits.
      return isKnowledgeDocument(action.document) &&
        action.document.bot === agentId(action.bot) &&
        JSON.stringify(state.knowledgeDrafts[action.bot]) === JSON.stringify(action.previous)
        ? {
            ...state,
            knowledgeDrafts: {
              ...state.knowledgeDrafts,
              [action.bot]: knowledgeDraft(action.document),
            },
          }
        : state;
    case 'reply-draft': {
      if (
        !validAgentId(action.id) ||
        !action.question ||
        action.question.length > 80 ||
        action.question.includes('\0')
      )
        return state;
      const drafts = state.replyDrafts[action.id] || {};
      const previous = Object.hasOwn(drafts, action.question)
        ? drafts[action.question]
        : { selected: [], custom: '' };
      return {
        ...state,
        replyDrafts: {
          ...state.replyDrafts,
          [action.id]: {
            ...drafts,
            [action.question]: {
              selected: action.selected
                ? [...new Set(action.selected)].slice(0, 8).map((label) => label.slice(0, 100))
                : previous.selected,
              custom: action.custom === undefined ? previous.custom : action.custom.slice(0, 4000),
            },
          },
        },
      };
    }
    case 'profiles': {
      let next = state;
      for (const profile of action.profiles) {
        if (!isBotProfile(profile)) continue;
        const previousRevision = Object.hasOwn(next.profileRevisions, profile.id)
          ? next.profileRevisions[profile.id]
          : 0;
        if (profile.revision < previousRevision) continue;
        let bot = next.bots.find((entry) => !entry.members && agentId(entry.id) === profile.id);
        if (!bot) {
          if (next.bots.some((entry) => entry.id === profile.id)) continue;
          const created = reduce(next, {
            type: 'create',
            id: profile.id,
            name: profile.name,
            role: profile.instructions,
            color: profile.color,
          });
          next = { ...created, selected: next.selected, view: next.view, panel: next.panel };
          bot = next.bots.find((entry) => entry.id === profile.id);
        }
        if (!bot) continue;
        const id = bot.id,
          draft =
            next.memoryDrafts[id] === next.memories[id] ? profile.memory : next.memoryDrafts[id];
        if (
          bot.name === profile.name &&
          bot.role === profile.instructions &&
          bot.color === profile.color &&
          bot.model === profile.model &&
          !!bot.archived === !!profile.archived &&
          next.memories[id] === profile.memory &&
          next.memoryDrafts[id] === draft &&
          previousRevision === profile.revision
        )
          continue;
        next = {
          ...next,
          profileRevisions: { ...next.profileRevisions, [profile.id]: profile.revision },
          bots: next.bots.map((entry) => {
            if (entry.id !== id) return entry;
            const updated = {
              ...entry,
              name: profile.name,
              archived: !!profile.archived,
              role: profile.instructions,
              color: profile.color,
            };
            if (profile.model) updated.model = profile.model;
            else delete updated.model;
            return updated;
          }),
          memories: { ...next.memories, [id]: profile.memory },
          memoryDrafts: { ...next.memoryDrafts, [id]: draft },
          memoryVersions: {
            ...next.memoryVersions,
            [id]: draft === profile.memory ? profile.revision : (next.memoryVersions[id] ?? 0),
          },
        };
      }
      return next;
    }
    case 'profile-local':
      return {
        ...state,
        bots: state.bots.map((bot) =>
          bot.id === action.bot
            ? {
                ...bot,
                name: action.name.trim().slice(0, 30),
                role: action.instructions.slice(0, 4000),
              }
            : bot,
        ),
      };
    case 'runtime-pending':
      return { ...state, runtimeRequests: { ...state.runtimeRequests, [action.bot]: action.task } };
    case 'runtime-clear':
      return { ...state, runtimeRequests: { ...state.runtimeRequests, [action.bot]: undefined } };
    case 'attachment-uploading':
      return {
        ...state,
        attachmentUploads: { ...state.attachmentUploads, [action.bot]: action.uploading },
      };
    case 'runtime-task': {
      const task = action.task,
        entries = [...state.messages[action.bot]],
        files = [...state.files];
      let changed = false;
      const add = (message: Message, before?: string) => {
        message = { ...message, chatRevision: task.chatRevision ?? 0 };
        const index = entries.findIndex((m) => m.id === message.id);
        if (index < 0) {
          const position = before ? entries.findIndex((entry) => entry.id === before) : -1;
          if (position >= 0) entries.splice(position, 0, message);
          else entries.push(message);
          changed = true;
        } else if (JSON.stringify(entries[index]) !== JSON.stringify(message)) {
          entries[index] = message;
          changed = true;
        }
      };
      if (task.prompt) {
        const previous = entries.find((message) => message.id === task.requestId);
        const pending = state.runtimeRequests[action.bot];
        const attached =
          pending?.requestId === task.requestId && !pending.retryOf
            ? state.attachments[action.bot].filter((id) => {
                const file = state.files.find((item) => item.id === id);
                return (
                  file &&
                  pending.files?.some(
                    (sent) => JSON.stringify(taskFile(file)) === JSON.stringify(sent),
                  )
                );
              })
            : [];
        const references = previous?.files || attached;
        add({
          id: task.requestId,
          role: 'user',
          text: task.prompt,
          ...(references.length ? { files: references } : {}),
        });
      }
      const artifacts: string[] = [];
      for (const file of task.files || []) {
        const item: WorkspaceFile = {
          id: `runtime:${file.path}`,
          name: file.name,
          kind: file.name.split('.').at(-1)?.toUpperCase() || '文件',
          size: `${(file.size / 1024).toFixed(1)} KB`,
          modified: file.modified,
          content: '',
          runtimePath: file.path,
        };
        const index = files.findIndex((f) => f.id === item.id);
        if (index < 0) {
          files.push(item);
          changed = true;
        } else if (JSON.stringify(files[index]) !== JSON.stringify(item)) {
          files[index] = item;
          changed = true;
        }
        artifacts.push(item.id);
      }
      if (['completed', 'failed', 'stopped', 'interrupted'].includes(task.phase)) {
        if (task.phase !== 'completed' && task.response?.text)
          add(
            {
              id: `runtime-partial:${task.runId}`,
              role: 'bot',
              text: task.response.text,
              incomplete: true,
            },
            `runtime-result:${task.runId}`,
          );
        const text =
          task.result ||
          task.error ||
          (task.phase === 'stopped'
            ? '任务已停止，已经保存的文件仍然保留。'
            : '任务已结束，请核对输出文件。');
        add({
          id: `runtime-result:${task.runId}`,
          role: 'bot',
          text,
          ...(artifacts.length ? { files: artifacts } : {}),
        });
      }
      const pending = state.runtimeRequests[action.bot];
      const acknowledged = pending?.requestId === task.requestId;
      // An old accepted receipt settles uncertainty; it cannot erase work drafted in a later conversation.
      const sameContext = (task.chatRevision ?? 0) === chatRevision(state, action.bot);
      const sentFiles = pending?.files || [];
      const currentFiles = state.attachments[action.bot]
        .map((id) => state.files.find((file) => file.id === id))
        .filter((file): file is WorkspaceFile => !!file);
      const clearAttachments =
        acknowledged &&
        sameContext &&
        !pending.retryOf &&
        currentFiles.length === sentFiles.length &&
        currentFiles.every(
          (file, index) => JSON.stringify(taskFile(file)) === JSON.stringify(sentFiles[index]),
        );
      if (!changed && !acknowledged) return state;
      return {
        ...state,
        files,
        messages: { ...state.messages, [action.bot]: entries },
        runtimeRequests: acknowledged
          ? { ...state.runtimeRequests, [action.bot]: undefined }
          : state.runtimeRequests,
        drafts:
          acknowledged &&
          sameContext &&
          !pending.retryOf &&
          state.drafts[action.bot].trim() === pending.prompt.trim()
            ? { ...state.drafts, [action.bot]: '' }
            : state.drafts,
        attachments: clearAttachments
          ? { ...state.attachments, [action.bot]: [] }
          : state.attachments,
      };
    }
    case 'select':
      return { ...state, selected: action.bot, view: 'chat' };
    case 'view':
      return { ...state, view: action.view };
    case 'panel':
      return { ...state, panel: action.panel };
    case 'theme':
      return { ...state, theme: action.theme };
    case 'control':
      return { ...state, controls: { ...state.controls, [action.bot]: action.owner } };
    case 'draft':
      return { ...state, drafts: { ...state.drafts, [action.bot]: action.text.slice(0, 12000) } };
    case 'memory-draft':
      return {
        ...state,
        memoryDrafts: { ...state.memoryDrafts, [action.bot]: action.text.slice(0, 12000) },
        memoryVersions: {
          ...state.memoryVersions,
          [action.bot]:
            state.memoryDrafts[action.bot] === state.memories[action.bot]
              ? state.profileRevisions[agentId(action.bot)] || 0
              : (state.memoryVersions[action.bot] ?? 0),
        },
      };
    case 'memory-rebase':
      if (state.profileRevisions[agentId(action.bot)] !== action.revision) return state;
      return {
        ...state,
        memoryVersions: { ...state.memoryVersions, [action.bot]: action.revision },
      };
    case 'memory-saved': {
      const profile = action.profile;
      // Version checking and acknowledgement are one transaction: late saves cannot undo newer polling data.
      if (
        !isBotProfile(profile) ||
        profile.id !== agentId(action.bot) ||
        profile.revision < (state.profileRevisions[profile.id] || 0)
      )
        return state;
      const next = reduce(state, { type: 'profiles', profiles: [profile] });
      return {
        ...next,
        memoryVersions: { ...next.memoryVersions, [action.bot]: profile.revision },
        memoryDrafts: {
          ...next.memoryDrafts,
          [action.bot]:
            state.memoryDrafts[action.bot] === action.submitted
              ? profile.memory
              : state.memoryDrafts[action.bot],
        },
      };
    }
    case 'routine-draft':
      return {
        ...state,
        routineDrafts: {
          ...state.routineDrafts,
          [action.bot]: { ...state.routineDrafts[action.bot], ...action.draft },
        },
      };
    case 'routine-saved':
      // A late save may close its own form, never replace a newer draft for this or another Bot.
      return JSON.stringify({ ...state.routineDrafts[action.bot], open: action.draft.open }) ===
        JSON.stringify(action.draft)
        ? { ...state, routineDrafts: { ...state.routineDrafts, [action.bot]: routineDraft() } }
        : state;
    case 'memory':
      return {
        ...state,
        memories: { ...state.memories, [action.bot]: action.text.slice(0, 12000) },
        memoryDrafts: {
          ...state.memoryDrafts,
          [action.bot]:
            action.submitted !== undefined && state.memoryDrafts[action.bot] !== action.submitted
              ? state.memoryDrafts[action.bot]
              : action.text.slice(0, 12000),
        },
      };
    case 'send': {
      const text = state.drafts[action.bot].trim();
      const files = state.attachments[action.bot];
      if (!text && !files.length) return state;
      const message: Message = {
        id: action.id,
        role: 'user',
        text: text || '请查看这些文件。',
        ...(files.length ? { files } : {}),
      };
      const notice: Message = {
        id: `${action.id}-notice`,
        role: 'notice',
        text: '消息已保存在本机。当前为界面演示，尚未连接模型，不会执行真实任务。',
      };
      return {
        ...state,
        drafts: { ...state.drafts, [action.bot]: '' },
        attachments: { ...state.attachments, [action.bot]: [] },
        messages: {
          ...state.messages,
          [action.bot]: [...state.messages[action.bot], message, notice],
        },
        bots: state.bots.map((b) =>
          b.id === action.bot ? { ...b, preview: text || '添加了文件', time: action.time } : b,
        ),
      };
    }
    case 'create': {
      const name = action.name.trim().slice(0, 30);
      if (!name || state.bots.some((b) => b.id === action.id)) return state;
      const members = action.members?.filter(
        (id, index, all) =>
          state.bots.some((b) => b.id === id && !b.members) && all.indexOf(id) === index,
      );
      if (members && members.length < 2) return state;
      const bot: Bot = {
        id: action.id,
        name,
        role: members ? `${members.length} 位 Bot 的群聊` : action.role.trim().slice(0, 4000),
        color: action.color,
        preview: '从第一条消息开始',
        time: '刚刚',
        ...(members ? { members } : {}),
        ...(!members && action.model ? { model: action.model } : {}),
      };
      return {
        ...state,
        selected: action.id,
        view: 'chat',
        panel: members ? null : state.panel,
        bots: [...state.bots, bot],
        messages: { ...state.messages, [action.id]: [] },
        drafts: { ...state.drafts, [action.id]: '' },
        controls: { ...state.controls, [action.id]: 'agent' },
        memories: { ...state.memories, [action.id]: '' },
        memoryDrafts: { ...state.memoryDrafts, [action.id]: '' },
        routineDrafts: { ...state.routineDrafts, [action.id]: routineDraft() },
        attachments: { ...state.attachments, [action.id]: [] },
      };
    }
    case 'routine-add':
      return state.bots.some((b) => b.id === action.routine.bot) &&
        action.routine.title.trim() &&
        !state.routines.some((r) => r.id === action.routine.id)
        ? {
            ...state,
            routines: [...state.routines, action.routine],
            routineDrafts: { ...state.routineDrafts, [action.routine.bot]: routineDraft() },
          }
        : state;
    case 'routine-toggle':
      return {
        ...state,
        routines: state.routines.map((r) =>
          r.id === action.id ? { ...r, enabled: !r.enabled } : r,
        ),
      };
    case 'routine-remove':
      return { ...state, routines: state.routines.filter((r) => r.id !== action.id) };
    case 'approval': {
      if (!state.approvals.some((a) => a.id === action.id && a.status === 'pending')) return state;
      return {
        ...state,
        approvals: state.approvals.map((a) =>
          a.id === action.id ? { ...a, status: action.status } : a,
        ),
      };
    }
    case 'attach': {
      if (
        !Object.hasOwn(state.attachments, action.bot) ||
        state.attachments[action.bot].length >= 4 ||
        state.files.some((file) => file.id === action.file.id)
      )
        return state;
      const names = new Set(
        state.attachments[action.bot].map((id) => state.files.find((file) => file.id === id)?.name),
      );
      const extension = action.file.name.lastIndexOf('.');
      const stem = extension > 0 ? action.file.name.slice(0, extension) : action.file.name;
      const suffix = extension > 0 ? action.file.name.slice(extension) : '';
      let name = action.file.name;
      // Only rename the input copy: distinct sources must not overwrite each other in the next task.
      for (let count = 2; names.has(name); count++) {
        const ending = `-${count}${suffix}`;
        const prefix = Array.from(stem);
        // Task filenames are limited in UTF-8 bytes; suffixing must preserve whole Unicode characters.
        while (
          (prefix.join('') + ending).length > 160 ||
          new TextEncoder().encode(prefix.join('') + ending).length > 255
        )
          prefix.pop();
        name = `${prefix.join('')}${ending}`;
      }
      return {
        ...state,
        files: [...state.files, { ...action.file, name }],
        attachments: {
          ...state.attachments,
          [action.bot]: [...state.attachments[action.bot], action.file.id],
        },
      };
    }
    case 'detach':
      return {
        ...state,
        attachments: {
          ...state.attachments,
          [action.bot]: state.attachments[action.bot].filter((id) => id !== action.file),
        },
      };
  }
}
