import { validAgentId } from './id.js';
import { type ChatState, isChatState } from './index.js';

export interface ConversationRequest {
  id: string;
  bot: string;
  revision: number;
  version: number;
  action: 'trash' | 'restore';
  title: string;
}
export interface ConversationState {
  bot: string;
  revision: number;
  version: number;
  trashed: boolean;
  title: string;
  updatedAt: string;
}
export interface ConversationAck {
  chat: ChatState;
  conversation: ConversationState;
  receipt: { request: ConversationRequest; version: number; completedAt: string };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
const title = (value: unknown) =>
  typeof value === 'string' && value.length <= 120 && !value.includes('\0');
const timestamp = (value: unknown) =>
  typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));

export function isConversationRequest(value: unknown): value is ConversationRequest {
  return (
    object(value) &&
    Object.keys(value).every((key) =>
      ['id', 'bot', 'revision', 'version', 'action', 'title'].includes(key),
    ) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    revision(value.revision) &&
    revision(value.version) &&
    (value.action === 'trash' || value.action === 'restore') &&
    title(value.title)
  );
}
export function isConversationState(value: unknown): value is ConversationState {
  return (
    object(value) &&
    Object.keys(value).every((key) =>
      ['bot', 'revision', 'version', 'trashed', 'title', 'updatedAt'].includes(key),
    ) &&
    validAgentId(value.bot) &&
    revision(value.revision) &&
    revision(value.version) &&
    Number(value.version) > 0 &&
    typeof value.trashed === 'boolean' &&
    title(value.title) &&
    timestamp(value.updatedAt)
  );
}
export function sameConversationRequest(left: ConversationRequest, right: ConversationRequest) {
  return (
    left.id === right.id &&
    left.bot === right.bot &&
    left.revision === right.revision &&
    left.version === right.version &&
    left.action === right.action &&
    left.title === right.title
  );
}
export function isConversationAck(value: unknown): value is ConversationAck {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['chat', 'conversation', 'receipt'].includes(key)) ||
    !isChatState(value.chat) ||
    !isConversationState(value.conversation) ||
    !object(value.receipt)
  )
    return false;
  const { conversation, receipt, chat } = value;
  return (
    Object.keys(receipt).every((key) => ['request', 'version', 'completedAt'].includes(key)) &&
    isConversationRequest(receipt.request) &&
    receipt.request.bot === conversation.bot &&
    receipt.request.revision === conversation.revision &&
    receipt.version === receipt.request.version + 1 &&
    conversation.version >= Number(receipt.version) &&
    (conversation.version !== receipt.version ||
      (conversation.trashed === (receipt.request.action === 'trash') &&
        conversation.title === receipt.request.title &&
        conversation.updatedAt === receipt.completedAt)) &&
    chat.bot === conversation.bot &&
    chat.revision >= conversation.revision &&
    timestamp(receipt.completedAt)
  );
}
