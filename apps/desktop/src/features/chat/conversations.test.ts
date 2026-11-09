import { expect, it } from 'vitest';
import { chatRevision, reduce } from '../../app/state';
import { restore, serialize } from '../../app/storage';
import { demoState } from '../../test/fixtures';
import { conversationKey, recentConversations } from './conversations';

it('keeps drafts, attachments, queues and approval grants within their original conversation', () => {
  let state = demoState();
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC FIRST DRAFT' });
  state = reduce(state, { type: 'draft-folders-add', bot: 'research', folders: ['/mock/first'] });
  state = reduce(state, { type: 'approval-mode', bot: 'research', revision: 0, mode: 'full' });
  state = reduce(state, {
    type: 'chat-open',
    bot: 'research',
    chat: { bot: 'a', revision: 1, updatedAt: '2026-01-02T00:00:00Z' },
    previous: 0,
  });
  expect(chatRevision(state, 'research')).toBe(1);
  expect(state.drafts.research).toBe('');
  expect(state.draftFolders?.research).toEqual([]);
  expect(state.approvalModes.research?.mode).not.toBe('full');
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC SECOND DRAFT' });
  state = reduce(state, { type: 'draft-folders-add', bot: 'research', folders: ['/mock/second'] });
  state = reduce(state, { type: 'chat-select', bot: 'research', revision: 0 });
  expect(chatRevision(state, 'research')).toBe(0);
  expect(state.drafts.research).toBe('SYNTHETIC FIRST DRAFT');
  expect(state.draftFolders?.research).toEqual(['/mock/first']);
  expect(state.approvalModes.research).toEqual({ revision: 0, mode: 'full' });
  state = reduce(state, { type: 'chat-select', bot: 'research', revision: 1 });
  expect(state.drafts.research).toBe('SYNTHETIC SECOND DRAFT');
  const restored = restore(serialize(state));
  expect(
    chatRevision(restored, 'research', {
      available: true,
      revision: 1,
      items: [{ bot: 'a', revision: 1 }],
    }),
  ).toBe(1);
  expect(restored.conversationDrafts?.[conversationKey('research', 0)]?.text).toBe(
    'SYNTHETIC FIRST DRAFT',
  );
  const first = reduce(restored, { type: 'chat-select', bot: 'research', revision: 0 });
  const second = reduce(first, { type: 'chat-select', bot: 'research', revision: 1 });
  expect(second.drafts.research).toBe('SYNTHETIC SECOND DRAFT');
  expect(second.draftFolders?.research).toEqual(['/mock/second']);
  expect(first.draftFolders?.research).toEqual(['/mock/first']);
});

it('preserves folder chips across queue editing and retries and includes paths in inserted messages', () => {
  let state = demoState();
  state = reduce(state, { type: 'draft-folders-add', bot: 'research', folders: ['/mock/first'] });
  state = reduce(state, {
    type: 'queue-add',
    bot: 'research',
    task: { id: 'mock-queued-folder', prompt: '', files: [], folders: ['/mock/first'] },
  });
  expect(state.queued.research).toHaveLength(1);
  expect(state.draftFolders?.research).toEqual([]);
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC EDIT' });
  state = reduce(state, {
    type: 'draft-folders-add',
    bot: 'research',
    folders: ['/mock/second', '/mock/first'],
  });
  state = reduce(state, { type: 'queue-edit', bot: 'research', id: 'mock-queued-folder' });
  expect(state.drafts.research).toBe('SYNTHETIC EDIT');
  expect(state.draftFolders?.research).toEqual(['/mock/second', '/mock/first']);
  state = reduce(state, {
    type: 'queue-add',
    bot: 'research',
    task: {
      id: 'mock-queued-folder',
      prompt: state.drafts.research,
      files: [],
      folders: state.draftFolders?.research,
    },
  });
  state = reduce(state, { type: 'queue-fail', bot: 'research', id: 'mock-queued-folder' });
  state = reduce(state, { type: 'queue-retry', bot: 'research', id: 'mock-queued-folder' });
  expect(state.queued.research[0].folders).toEqual(['/mock/second', '/mock/first']);
  state = reduce(state, {
    type: 'queue-insert',
    bot: 'research',
    id: 'mock-queued-folder',
    revision: 0,
  });
  expect(state.messages.research.at(-1)?.text).toBe('SYNTHETIC EDIT\n/mock/second\n/mock/first');
});

it('retains queued references and authored text when their merged context would exceed the prompt limit', () => {
  let state = demoState();
  state = reduce(state, {
    type: 'queue-add',
    bot: 'research',
    task: { id: 'mock-long-queue', prompt: '', files: [], folders: ['/mock/project'] },
  });
  state = reduce(state, { type: 'draft', bot: 'research', text: 'x'.repeat(12000) });
  const before = state;
  state = reduce(state, { type: 'queue-edit', bot: 'research', id: 'mock-long-queue' });
  expect(state).toBe(before);
  expect(state.queued.research[0].folders).toEqual(['/mock/project']);
  expect(state.drafts.research).toHaveLength(12000);
});

it('does not reduce the editable text budget below an existing whitespace-heavy draft', () => {
  let state = demoState();
  const text = `${' '.repeat(11999)}x`;
  state = reduce(state, { type: 'draft', bot: 'research', text });
  const before = state;
  state = reduce(state, { type: 'draft-folders-add', bot: 'research', folders: ['/mock/project'] });
  expect(state).toBe(before);
  expect(state.drafts.research).toBe(text);
});

it('clears only the exact acknowledged text and folder draft, preserving later directory changes', () => {
  let state = demoState();
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC SEND' });
  state = reduce(state, { type: 'draft-folders-add', bot: 'research', folders: ['/mock/first'] });
  const task = {
    requestId: 'mock-folder-send',
    prompt: 'SYNTHETIC SEND\n/mock/first',
    chatRevision: 0,
  };
  state = reduce(state, { type: 'runtime-pending', bot: 'research', task });
  const receipt = {
    ...task,
    runId: 'mock-folder-run',
    phase: 'completed' as const,
    result: 'SYNTHETIC',
    error: '',
  };
  const settled = reduce(state, { type: 'runtime-task', bot: 'research', task: receipt });
  expect(settled.drafts.research).toBe('');
  expect(settled.draftFolders?.research).toEqual([]);
  state = reduce(state, { type: 'draft-folder-remove', bot: 'research', folder: '/mock/first' });
  state = reduce(state, { type: 'draft-folders-add', bot: 'research', folders: ['/mock/newer'] });
  state = reduce(state, { type: 'runtime-task', bot: 'research', task: receipt });
  expect(state.drafts.research).toBe('SYNTHETIC SEND');
  expect(state.draftFolders?.research).toEqual(['/mock/newer']);
});

it('keeps legacy drafts when optional stored folder references are absent or damaged', () => {
  const state = demoState();
  state.drafts.research = 'SYNTHETIC LEGACY DRAFT';
  const saved = JSON.parse(serialize(state));
  saved.state.draftFolders = { research: ['/mock/project', '/mock/project'], writer: 123 };
  const restored = restore(JSON.stringify(saved));
  expect(restored.drafts.research).toBe('SYNTHETIC LEGACY DRAFT');
  expect(restored.draftFolders?.research).toEqual(['/mock/project']);
  expect(restored.draftFolders?.writer).toEqual([]);
  delete saved.state.draftFolders;
  expect(restore(JSON.stringify(saved)).drafts.research).toBe('SYNTHETIC LEGACY DRAFT');
});

it('does not lower the authoritative boundary or erase a newer draft after a delayed new-conversation acknowledgement', () => {
  let state = demoState();
  state = reduce(state, {
    type: 'chats',
    items: [{ bot: 'a', revision: 2, updatedAt: '2026-01-03T00:00:00Z' }],
  });
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC NEWER DRAFT' });
  state = reduce(state, {
    type: 'chat-open',
    bot: 'research',
    chat: { bot: 'a', revision: 1, updatedAt: '2026-01-02T00:00:00Z' },
    previous: 0,
  });
  expect(state.chatStates.research.revision).toBe(2);
  expect(state.drafts.research).toBe('SYNTHETIC NEWER DRAFT');
});

it('keeps an open topic and its draft when another client creates a newer topic', () => {
  let state = demoState();
  state = reduce(state, { type: 'chats', items: [{ bot: 'a', revision: 0 }], keepSelection: true });
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC CURRENT DRAFT' });
  state = reduce(state, {
    type: 'chats',
    items: [{ bot: 'a', revision: 1, updatedAt: '2026-01-02T00:00:00Z' }],
    keepSelection: true,
  });
  expect(chatRevision(state, 'research')).toBe(0);
  state = reduce(state, { type: 'chat-select', bot: 'research', revision: 1 });
  expect(state.drafts.research).toBe('');
});

it('routes late attachments and accepted receipts to the source conversation without erasing another draft', () => {
  let state = demoState();
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC OLD SEND' });
  state = reduce(state, {
    type: 'runtime-pending',
    bot: 'research',
    task: { requestId: 'mock-send', prompt: 'SYNTHETIC OLD SEND', chatRevision: 0 },
  });
  state = reduce(state, {
    type: 'chat-open',
    bot: 'research',
    chat: { bot: 'a', revision: 1, updatedAt: '2026-01-02T00:00:00Z' },
    previous: 0,
  });
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC NEW DRAFT' });
  state = reduce(state, {
    type: 'attach',
    bot: 'research',
    revision: 0,
    file: {
      id: 'mock-late-file',
      name: 'mock.txt',
      kind: 'TXT',
      size: '1 KB',
      content: 'SYNTHETIC',
      modified: '',
    },
  });
  expect(state.attachments.research).toEqual([]);
  state = reduce(state, {
    type: 'runtime-task',
    bot: 'research',
    task: {
      requestId: 'mock-send',
      runId: 'mock-run',
      prompt: 'SYNTHETIC OLD SEND',
      phase: 'completed',
      result: 'SYNTHETIC',
      error: '',
      chatRevision: 0,
    },
  });
  expect(state.drafts.research).toBe('SYNTHETIC NEW DRAFT');
  state = reduce(state, { type: 'chat-select', bot: 'research', revision: 0 });
  expect(state.attachments.research).toEqual(['mock-late-file']);
  expect(state.drafts.research).toBe('');
});

it('lists ordinary chats and Bot sessions together using independent conversation identities', () => {
  let state = demoState();
  state = reduce(state, {
    type: 'create',
    id: 'mock-chat',
    name: '新对话',
    role: '',
    color: 'mint',
    kind: 'chat',
  });
  expect(state.bots.find((bot) => bot.id === 'mock-chat')?.kind).toBe('chat');
  const grouped = reduce(state, {
    type: 'create',
    id: 'mock-group',
    name: 'Synthetic group',
    role: '',
    color: 'mint',
    members: ['mock-chat', 'research'],
  });
  expect(grouped.bots.some((bot) => bot.id === 'mock-group')).toBe(false);
  const recent = recentConversations(state, {
    available: true,
    revision: 1,
    items: [{ bot: 'a', revision: 1 }],
    conversations: [
      { bot: 'a', revision: 0, title: 'SYNTHETIC OLD TOPIC', updatedAt: '2026-01-01T00:00:00Z' },
      { bot: 'a', revision: 1, title: 'SYNTHETIC NEW TOPIC', updatedAt: '2026-01-02T00:00:00Z' },
      {
        bot: 'mock-chat',
        revision: 0,
        title: 'SYNTHETIC PLAIN TOPIC',
        updatedAt: '2026-01-03T00:00:00Z',
      },
    ],
  });
  expect(recent.filter((item) => item.bot === 'research').map((item) => item.revision)).toEqual([
    1, 0,
  ]);
  expect(recent.find((item) => item.bot === 'mock-chat')?.title).toBe('SYNTHETIC PLAIN TOPIC');
});

it('can restore an empty conversation after switching Bots and reopening', () => {
  let state = demoState();
  state.messages.research = [];
  state = reduce(state, {
    type: 'conversation-place',
    bot: 'research',
    revision: 0,
    placement: 'archived',
  });
  state = reduce(state, { type: 'chat-select', bot: 'chief', revision: 0 });
  const reopened = restore(serialize(state));
  expect(reopened.conversationPlacements?.[conversationKey('research', 0)]).toBe('archived');
  expect(recentConversations(reopened)).toContainEqual(
    expect.objectContaining({ bot: 'research', revision: 0 }),
  );
  const restored = restore(
    serialize(
      reduce(reopened, {
        type: 'conversation-place',
        bot: 'research',
        revision: 0,
        placement: 'recent',
      }),
    ),
  );
  expect(restored.conversationPlacements?.[conversationKey('research', 0)]).toBe('recent');
  expect(recentConversations(restored)).toContainEqual(
    expect.objectContaining({ bot: 'research', revision: 0 }),
  );
});

it('treats prototype-named execution identities as ordinary conversation IDs', () => {
  const state = reduce(demoState(), {
    type: 'create',
    id: 'constructor',
    name: 'Synthetic identity',
    role: '',
    color: 'mint',
    kind: 'chat',
  });
  expect(chatRevision(state, 'constructor')).toBe(0);
});

it('settles queued-message acknowledgements in a background conversation', () => {
  let state = demoState();
  state = reduce(state, { type: 'draft', bot: 'research', text: 'SYNTHETIC QUEUED' });
  state = reduce(state, {
    type: 'queue-add',
    bot: 'research',
    task: { id: 'mock-queued', prompt: 'SYNTHETIC QUEUED', files: [] },
  });
  state = reduce(state, {
    type: 'queue-sending',
    bot: 'research',
    id: 'mock-queued',
    sending: true,
  });
  state = reduce(state, {
    type: 'chat-open',
    bot: 'research',
    chat: { bot: 'a', revision: 1, updatedAt: '2026-01-02T00:00:00Z' },
    previous: 0,
  });
  state = reduce(state, {
    type: 'queue-sending',
    bot: 'research',
    id: 'mock-queued',
    sending: false,
  });
  state = reduce(state, { type: 'queue-remove', bot: 'research', id: 'mock-queued' });
  state = reduce(state, { type: 'chat-select', bot: 'research', revision: 0 });
  expect(state.queued.research).toEqual([]);
});
