import {
  isBotProfileInput,
  isChatAck,
  isChatPage,
  isConversationAck,
  recoveryReader,
} from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

it('validates conversation trash commands and allows only exact receipt inspection during recovery', () => {
  const request = {
    id: 'mock-trash-ipc',
    bot: 'mock-alpha',
    revision: 0,
    version: 0,
    action: 'trash',
    title: 'SYNTHETIC TOPIC',
  };
  expect(parseCommand({ type: 'conversation.action', request })).toEqual({
    type: 'conversation.action',
    request,
  });
  expect(recoveryReader(parseCommand({ type: 'conversation.receipt', request }))).toBe(true);
  expect(recoveryReader(parseCommand({ type: 'conversation.action', request }))).toBe(false);
  for (const patch of [
    { version: -1 },
    { revision: 1.5 },
    { action: 'delete' },
    { extra: true },
    { title: 'x'.repeat(121) },
  ])
    expect(() =>
      parseCommand({ type: 'conversation.action', request: { ...request, ...patch } }),
    ).toThrow('INVALID_COMMAND');
});

it('accepts classified ordinary conversations and requires a current boundary for explicit historical continuation', () => {
  expect(
    isBotProfileInput({
      id: 'mock-chat',
      name: 'Synthetic chat',
      instructions: '',
      memory: '',
      color: 'mint',
      kind: 'chat',
    }),
  ).toBe(true);
  const task = {
    requestId: 'mock-resume',
    prompt: 'SYNTHETIC CONTINUE',
    chatRevision: 2,
    contextRevision: 0,
    model: 'deepseek-flash',
  };
  expect(parseCommand({ type: 'task.start', bot: 'mock-chat', task })).toMatchObject({ task });
  for (const patch of [
    { contextRevision: -1 },
    { contextRevision: 3 },
    { chatRevision: undefined },
    { model: 'unknown-model' },
  ])
    expect(() =>
      parseCommand({ type: 'task.start', bot: 'mock-chat', task: { ...task, ...patch } }),
    ).toThrow('INVALID_COMMAND');
});

it('strictly binds private conversation commands and validates history and acknowledgement scope', async () => {
  const request = { id: 'mock-chat-new', bot: 'mock-alpha', revision: 0 };
  const ack = {
    chat: { bot: request.bot, revision: 1, updatedAt: '2026-01-01T00:00:00Z' },
    receipt: { request, revision: 1, completedAt: '2026-01-01T00:00:00Z' },
  };
  expect(isChatAck(ack)).toBe(true);
  expect(isChatAck({ ...ack, chat: { ...ack.chat, bot: 'mock-other' } })).toBe(false);
  const command = parseCommand({ type: 'chat.new', request });
  expect(command).toEqual({ type: 'chat.new', request });
  for (const value of [
    { type: 'chat.new', request: { ...request, unknown: true } },
    { type: 'chat.history', bot: request.bot, revision: -1 },
    {
      type: 'task.start',
      bot: request.bot,
      task: { requestId: 'mock-task', prompt: 'SYNTHETIC', chatRevision: -1 },
    },
  ])
    expect(() => parseCommand(value)).toThrow('INVALID_COMMAND');
  expect(
    recoveryReader(parseCommand({ type: 'chat.receipt', bot: request.bot, id: request.id })),
  ).toBe(true);
  expect(recoveryReader(command)).toBe(false);
  expect(
    parseCommand({
      type: 'task.start',
      bot: request.bot,
      task: { requestId: 'mock-task', prompt: 'SYNTHETIC', chatRevision: 1 },
    }),
  ).toMatchObject({ task: { chatRevision: 1 } });
  let version = 28,
    result: unknown = ack;
  let tasks: unknown = {};
  const posts: string[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-capability">');
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          configured: false,
          revision: 0,
        });
      if (init?.method === 'POST') {
        posts.push(url);
        return Response.json(result);
      }
      return Response.json({
        mode: 'agent',
        clientProtocol: version,
        bots: {},
        computers: { available: true, revision: 0, limit: 2, items: [] },
        recovery: { available: true, revision: 0 },
        skills: { available: true, revision: 0 },
        mcp: { available: true, revision: 0 },
        chats: { available: true, revision: 0, items: [] },
        model: {
          available: true,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          bots: tasks,
        },
      });
    },
  });
  await expect(client.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posts).toHaveLength(0);
  version = 29;
  expect(await client.invoke(command)).toEqual(ack);
  result = { ...ack, receipt: { ...ack.receipt, request: { ...request, id: 'mock-wrong' } } };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_CHAT_ACK');
  result = { bot: request.bot, revision: 0, items: [] };
  expect(isChatPage(result)).toBe(true);
  expect(
    isChatPage({
      bot: request.bot,
      revision: 0,
      items: [
        {
          chatRevision: 0,
          runId: 'mock-old',
          requestId: 'mock-old',
          prompt: 'SYNTHETIC',
          result: '',
          error: '',
          phase: { toString: 'completed' },
        },
      ],
    }),
  ).toBe(false);
  expect(
    await client.invoke(parseCommand({ type: 'chat.history', bot: request.bot, revision: 0 })),
  ).toEqual(result);
  result = { bot: 'mock-other', revision: 0, items: [] };
  await expect(
    client.invoke(parseCommand({ type: 'chat.history', bot: request.bot, revision: 0 })),
  ).rejects.toThrow('INVALID_CHAT_HISTORY');
  tasks = {
    a: {
      history: [
        {
          chatRevision: -1,
          runId: 'mock-old',
          requestId: 'mock-old',
          prompt: 'SYNTHETIC',
          result: '',
          error: '',
          phase: 'completed',
        },
      ],
    },
  };
  expect((await client.status()).phase).not.toBe('ready');
  tasks = {};
  result = {
    runId: 'mock-accepted-run',
    requestId: 'mock-accepted',
    prompt: 'SYNTHETIC OLD',
    phase: 'completed',
    running: false,
    chatRevision: 0,
    result: 'SYNTHETIC DONE',
    error: '',
    files: [],
    sessionId: 'mock-private-session',
    fingerprint: 'mock-private-fingerprint',
  };
  const start = parseCommand({
    type: 'task.start',
    bot: request.bot,
    task: { requestId: 'mock-accepted', prompt: 'SYNTHETIC OLD', chatRevision: 0 },
  });
  expect(await client.invoke(start)).toEqual({
    runId: 'mock-accepted-run',
    requestId: 'mock-accepted',
    prompt: 'SYNTHETIC OLD',
    phase: 'completed',
    running: false,
    chatRevision: 0,
    result: 'SYNTHETIC DONE',
    error: '',
    files: [],
  });
  result = { ...(result as object), requestId: 'mock-wrong' };
  await expect(client.invoke(start)).rejects.toThrow('INVALID_TASK_ACK');
  const continued = parseCommand({
    type: 'task.start',
    bot: request.bot,
    task: {
      requestId: 'mock-accepted',
      prompt: 'SYNTHETIC OLD',
      chatRevision: 2,
      contextRevision: 0,
    },
  });
  version = 45;
  await expect(client.invoke(continued)).rejects.toThrow('RUNTIME_TOO_OLD');
  version = 46;
  result = { ...(result as object), requestId: 'mock-accepted' };
  expect(await client.invoke(continued)).toMatchObject({ chatRevision: 0 });
  version = 47;
  const action = parseCommand({
    type: 'conversation.action',
    request: {
      title: 'SYNTHETIC TOPIC',
      action: 'trash',
      version: 0,
      revision: 0,
      bot: request.bot,
      id: 'mock-ui-order',
    },
  });
  result = {
    chat: ack.chat,
    conversation: {
      bot: request.bot,
      revision: 0,
      version: 1,
      trashed: true,
      title: 'SYNTHETIC TOPIC',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    receipt: {
      request: {
        id: 'mock-ui-order',
        bot: request.bot,
        revision: 0,
        version: 0,
        action: 'trash',
        title: 'SYNTHETIC TOPIC',
      },
      version: 1,
      completedAt: '2026-01-01T00:00:00Z',
    },
  };
  expect(await client.invoke(action)).toEqual(result);
  result = {
    runId: 'mock-accepted-run',
    requestId: 'mock-accepted',
    prompt: 'SYNTHETIC OLD',
    phase: 'completed',
    running: false,
    chatRevision: 0,
    result: 'SYNTHETIC DONE',
    error: '',
    files: [],
  };

  result = { ...(result as object), chatRevision: 2 };
  await expect(client.invoke(continued)).rejects.toThrow('INVALID_TASK_ACK');
});

it('rejects a receipt whose matching lifecycle version contradicts its action', () => {
  const request = {
    id: 'mock-invariant',
    bot: 'mock-alpha',
    revision: 0,
    version: 0,
    action: 'trash',
    title: 'SYNTHETIC TOPIC',
  };
  const at = '2026-01-01T00:00:00Z';
  const ack = {
    chat: { bot: request.bot, revision: 1, updatedAt: at },
    conversation: {
      bot: request.bot,
      revision: 0,
      version: 1,
      trashed: true,
      title: request.title,
      updatedAt: at,
    },
    receipt: { request, version: 1, completedAt: at },
  };
  expect(isConversationAck(ack)).toBe(true);
  expect(isConversationAck({ ...ack, conversation: { ...ack.conversation, trashed: false } })).toBe(
    false,
  );
  expect(
    isConversationAck({ ...ack, conversation: { ...ack.conversation, title: 'SYNTHETIC OTHER' } }),
  ).toBe(false);
  expect(
    isConversationAck({
      ...ack,
      conversation: { ...ack.conversation, version: 2, trashed: false },
    }),
  ).toBe(true);
});
