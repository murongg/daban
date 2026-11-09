import { type ApprovalMode, agentId, type ChatStatus, type ModelId } from '@daban/protocol';
import { demoIds } from '../../app/samples';
import type { Bot, QueuedTask, State } from '../../app/state';
import { t } from '../../i18n/locale';

export interface ConversationDraft {
  text: string;
  folders?: string[];
  attachments: string[];
  queued: QueuedTask[];
  mode?: ApprovalMode;
  browserAutoStart?: true;
  uploading?: boolean;
}
export function draftFolders(state: Pick<State, 'draftFolders'>, bot: string): string[] {
  return state.draftFolders && Object.hasOwn(state.draftFolders, bot)
    ? state.draftFolders[bot]
    : [];
}
export function draftPrompt(text: string, folders: readonly string[] = []) {
  return [text.trim(), ...folders].filter(Boolean).join('\n');
}
export function draftTextLimit(folders: readonly string[]) {
  return folders.length ? Math.max(0, 12000 - folders.join('\n').length - 1) : 12000;
}
export const conversationKey = (bot: string, revision: number) => `${bot}:${revision}`;
export function chatAssistant(state: Pick<State, 'bots'>, chat?: Bot) {
  if (chat?.assistant)
    return state.bots.find(
      (bot) => !bot.kind && !bot.members && agentId(bot.id) === chat.assistant,
    );
}
export function responderLocked(state: State, chat: string) {
  return (
    !!state.runtimeRequests[chat] ||
    Object.hasOwn(state.profileRevisions, agentId(chat)) ||
    state.messages[chat]?.some((message) => message.role === 'user') === true
  );
}
export function conversationState(
  state: State,
  bot: string,
  revision: number,
  status?: ChatStatus,
) {
  const cached = state.conversationStates?.[conversationKey(bot, revision)];
  const remote = status?.lifecycle?.find(
    (item) => item.bot === agentId(bot) && item.revision === revision,
  );
  return remote && remote.version > (cached?.version ?? 0) ? remote : cached;
}
export function conversationPending(state: State, bot: string, revision: number) {
  return state.conversationRequests?.[conversationKey(bot, revision)];
}
export function selectedConversation(state: Pick<State, 'conversationSelections'>, bot: string) {
  return state.conversationSelections && Object.hasOwn(state.conversationSelections, bot)
    ? state.conversationSelections[bot]
    : undefined;
}
export function conversationEditor(state: State, bot: string, revision: number): ConversationDraft {
  if ((selectedConversation(state, bot) ?? state.chatStates[bot]?.revision ?? 0) === revision)
    return {
      text: state.drafts[bot] ?? '',
      folders: draftFolders(state, bot),
      attachments: state.attachments[bot] ?? [],
      queued: state.queued[bot] ?? [],
      mode:
        state.approvalModes[bot]?.revision === revision
          ? state.approvalModes[bot]?.mode
          : undefined,
      browserAutoStart:
        state.approvalModes[bot]?.revision === revision
          ? state.approvalModes[bot]?.browserAutoStart
          : undefined,
      uploading: state.attachmentUploads[bot],
    };
  return (
    state.conversationDrafts?.[conversationKey(bot, revision)] ?? {
      text: '',
      attachments: [],
      queued: [],
    }
  );
}
export function saveConversationEditor(
  state: State,
  bot: string,
  revision: number,
  editor: ConversationDraft,
): State {
  const key = conversationKey(bot, revision);
  const saved = { ...state, conversationDrafts: { ...state.conversationDrafts, [key]: editor } };
  if ((selectedConversation(state, bot) ?? state.chatStates[bot]?.revision ?? 0) !== revision)
    return saved;
  return {
    ...saved,
    drafts: { ...state.drafts, [bot]: editor.text },
    draftFolders: { ...state.draftFolders, [bot]: editor.folders ?? [] },
    attachments: { ...state.attachments, [bot]: editor.attachments },
    queued: { ...state.queued, [bot]: editor.queued },
    approvalModes: {
      ...state.approvalModes,
      [bot]: {
        revision,
        mode: editor.mode ?? 'auto',
        ...(editor.mode === 'full' && editor.browserAutoStart ? { browserAutoStart: true } : {}),
      },
    },
    attachmentUploads: { ...state.attachmentUploads, [bot]: !!editor.uploading },
  };
}
export function selectConversation(
  state: State,
  bot: string,
  revision: number,
  previous: number,
): State {
  const outgoing = conversationEditor(state, bot, previous);
  const drafts = { ...state.conversationDrafts, [conversationKey(bot, previous)]: outgoing };
  const incoming = drafts[conversationKey(bot, revision)] ?? {
    text: '',
    attachments: [],
    queued: [],
  };
  return saveConversationEditor(
    {
      ...state,
      selected: bot,
      view: 'chat',
      conversationDrafts: drafts,
      conversationSelections: { ...state.conversationSelections, [bot]: revision },
    },
    bot,
    revision,
    incoming,
  );
}
export function conversationModel(
  state: State,
  bot: string,
  revision: number,
): ModelId | undefined {
  return state.conversationModels?.[conversationKey(bot, revision)];
}
export function recentConversations(state: State, status?: ChatStatus) {
  const rows = new Map<
    string,
    { bot: string; revision: number; title: string; updatedAt: string }
  >();
  const add = (bot: string, revision: number, title: string, updatedAt: string) => {
    if (conversationState(state, bot, revision, status)?.trashed) return;
    const key = conversationKey(bot, revision);
    const savedTitle = state.conversationTitles?.[key];
    rows.set(key, {
      bot,
      revision,
      title: savedTitle || title || t('conversations.untitled'),
      updatedAt,
    });
  };
  for (const item of Object.values(state.conversationStates ?? {})) {
    const bot = state.bots.find(
      (bot) => !bot.members && !bot.archived && agentId(bot.id) === item.bot,
    );
    if (bot && !item.trashed) add(bot.id, item.revision, item.title, item.updatedAt);
  }
  for (const row of status?.conversations ?? []) {
    const bot = state.bots.find(
      (bot) => !bot.members && !bot.archived && agentId(bot.id) === row.bot,
    );
    if (bot) add(bot.id, row.revision, row.title, row.updatedAt);
  }
  for (const bot of state.bots) {
    if (bot.members || bot.archived) continue;
    for (const message of state.messages[bot.id] ?? []) {
      if (message.role !== 'user' || demoIds.has(message.id)) continue;
      const revision = message.chatRevision ?? 0;
      const key = conversationKey(bot.id, revision);
      if (!rows.has(key))
        add(bot.id, revision, message.text.replace(/\s+/g, ' ').slice(0, 120), '');
    }
    const revision = selectedConversation(state, bot.id) ?? state.chatStates[bot.id]?.revision ?? 0;
    const key = conversationKey(bot.id, revision);
    // The Bot row already reopens an unnamed, empty Bot conversation.
    if (!rows.has(key) && (bot.kind === 'chat' || state.conversationTitles?.[key]))
      add(bot.id, revision, '', '');
  }
  // Empty Bot conversations usually disappear when leaving the editor. Keep the ones organized explicitly.
  for (const key of Object.keys(state.conversationPlacements ?? {})) {
    if (rows.has(key)) continue;
    const split = key.lastIndexOf(':');
    const bot = state.bots.find((bot) => bot.id === key.slice(0, split));
    if (bot && !bot.members && !bot.archived) add(bot.id, Number(key.slice(split + 1)), '', '');
  }
  return [...rows.values()].sort((a, b) => {
    const editing = (row: typeof a) => !row.updatedAt && row.bot === state.selected;
    return (
      Number(editing(b)) - Number(editing(a)) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      b.revision - a.revision
    );
  });
}
