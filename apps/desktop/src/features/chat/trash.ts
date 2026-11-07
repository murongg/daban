import {
  agentId,
  type ChatStatus,
  type ConversationAck,
  type ConversationRequest,
  type ConversationState,
  isConversationAck,
  isConversationState,
} from '@daban/protocol';
import type { State } from '../../app/state';
import { conversationKey, selectConversation, selectedConversation } from './conversations';

export type TrashAction =
  | { type: 'conversation-sync'; items: ConversationState[]; chats: ChatStatus['items'] }
  | { type: 'conversation-pending'; request: ConversationRequest }
  | { type: 'conversation-clear'; request: ConversationRequest }
  | { type: 'conversation-result'; ack: ConversationAck };

export function reduceTrash(state: State, action: TrashAction): State {
  if (action.type === 'conversation-pending' || action.type === 'conversation-clear') {
    const bot = state.bots.find((bot) => !bot.members && agentId(bot.id) === action.request.bot);
    if (!bot) return state;
    const key = conversationKey(bot.id, action.request.revision);
    const requests = { ...state.conversationRequests };
    if (action.type === 'conversation-pending') {
      if (requests[key]) return state;
      requests[key] = action.request;
    } else {
      if (requests[key]?.id !== action.request.id) return state;
      delete requests[key];
    }
    return { ...state, conversationRequests: requests };
  }
  if (action.type === 'conversation-result' && !isConversationAck(action.ack)) return state;
  const items = action.type === 'conversation-result' ? [action.ack.conversation] : action.items;
  let next = state;
  for (const item of items) {
    const bot = state.bots.find((bot) => !bot.members && agentId(bot.id) === item.bot);
    if (!bot || !isConversationState(item)) continue;
    const key = conversationKey(bot.id, item.revision);
    if ((next.conversationStates?.[key]?.version ?? 0) >= item.version) continue;
    next = { ...next, conversationStates: { ...next.conversationStates, [key]: item } };
    const selected = selectedConversation(next, bot.id) ?? next.chatStates[bot.id]?.revision ?? 0;
    const boundary = next.chatStates[bot.id]?.revision ?? 0;
    if (item.trashed && selected === item.revision && boundary !== selected) {
      // Preserve the outgoing editor before moving away; restore never starts or resends its queued work.
      const switched = selectConversation(next, bot.id, boundary, selected);
      next = { ...switched, selected: next.selected, view: next.view };
    }
  }
  if (action.type === 'conversation-result')
    next = reduceTrash(next, { type: 'conversation-clear', request: action.ack.receipt.request });
  return next;
}
