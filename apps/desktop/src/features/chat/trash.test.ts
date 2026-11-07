import { agentId } from '@daban/protocol';
import { expect, it } from 'vitest';
import { chatRevision, reduce } from '../../app/state';
import { restore, serialize } from '../../app/storage';
import { demoState } from '../../test/fixtures';
import { conversationKey, conversationState, recentConversations } from './conversations';

const request = {
  id: 'mock-ui-trash',
  bot: agentId('research'),
  revision: 0,
  version: 0,
  action: 'trash' as const,
  title: 'SYNTHETIC TOPIC',
};
const deleted = {
  bot: request.bot,
  revision: 0,
  version: 1,
  trashed: true,
  title: request.title,
  updatedAt: '2026-01-02T00:00:00Z',
};
const chat = { bot: request.bot, revision: 1, updatedAt: deleted.updatedAt };

it('retains a trashed conversation draft, files and messages, excludes it from normal lists and restores it after reopening', () => {
  let state = demoState();
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC PRIVATE DRAFT' });
  const messages = state.messages.research;
  const files = state.files;
  state = reduce(state, { type: 'conversation-pending', request });
  expect(restore(serialize(state)).conversationRequests?.[conversationKey('research', 0)]).toEqual(
    request,
  );
  state = reduce(state, {
    type: 'conversation-result',
    ack: {
      chat,
      conversation: deleted,
      receipt: { request, version: 1, completedAt: deleted.updatedAt },
    },
  });
  expect(state.messages.research).toBe(messages);
  expect(state.files).toBe(files);
  expect(chatRevision(state, 'research')).toBe(1);
  expect(state.drafts.research).toBe('');
  expect(
    recentConversations(state).some((row) => row.bot === 'research' && row.revision === 0),
  ).toBe(false);
  state = restore(serialize(state));
  expect(conversationState(state, 'research', 0)?.trashed).toBe(true);
  expect(state.conversationDrafts?.[conversationKey('research', 0)]?.text).toBe(
    'SYNTHETIC PRIVATE DRAFT',
  );
  state = reduce(state, {
    type: 'conversation-sync',
    items: [{ ...deleted, version: 2, trashed: false }],
    chats: [chat],
  });
  state = reduce(state, { type: 'chat-select', bot: 'research', revision: 0 });
  expect(state.drafts.research).toBe('SYNTHETIC PRIVATE DRAFT');
});

it('ignores delayed trash results and refuses normal selection of a trashed topic', () => {
  let state = demoState();
  state = reduce(state, {
    type: 'conversation-sync',
    items: [{ ...deleted, version: 3 }],
    chats: [chat],
  });
  state = reduce(state, {
    type: 'conversation-sync',
    items: [{ ...deleted, version: 2, trashed: false }],
    chats: [chat],
  });
  expect(conversationState(state, 'research', 0)?.version).toBe(3);
  state = reduce(state, { type: 'chat-select', bot: 'research', revision: 0 });
  expect(chatRevision(state, 'research')).toBe(1);
});
