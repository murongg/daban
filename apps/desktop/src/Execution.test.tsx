import {
  agentId,
  disconnected,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
  type TranscriptScope,
} from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatHistory } from './ChatHistory';
import { Conversation } from './Conversation';
import { Execution } from './Execution';
import { demoState as initialState } from './fixtures';
import { GroupChat } from './GroupChat';
import { RuntimeProvider } from './Runtime';

afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const item = (seq: number, characters = 4) => ({
  seq,
  kind: 'call' as const,
  name: 'web_search',
  callId: `mock-call-${seq}`,
  at: '2026-01-01T00:00:00Z',
  characters,
});
function bridge(read: (command: RuntimeCommand) => unknown | Promise<unknown>, protocol = 33) {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(
    async (command: RuntimeCommand): Promise<RuntimeReply> => ({
      ok: true,
      value: command.type === 'status' ? snapshot : await read(command),
    }),
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  return {
    invoke,
    get snapshot() {
      return snapshot;
    },
    publish(value: RuntimeSnapshot) {
      snapshot = value;
      for (const listener of listeners) listener(value);
    },
  };
}

it('loads metadata only after opening and pages full tool content and later events without invoking actions', async () => {
  const long = `${'x'.repeat(31999)}😀合成尾部`;
  const backend = bridge((command) => {
    if (command.type === 'transcript.list')
      return {
        ...scope,
        state: 'complete',
        items: command.query.after ? [item(2)] : [item(1, long.length)],
        ...(command.query.after ? {} : { nextAfter: 1 }),
      };
    if (command.type === 'transcript.content') {
      const offset = command.query.offset ?? 0;
      const text = long.slice(offset, offset + 32000);
      return {
        ...scope,
        seq: command.query.seq,
        offset,
        total: long.length,
        text,
        ...(offset + text.length < long.length ? { nextOffset: offset + text.length } : {}),
      };
    }
    throw new Error('UNEXPECTED_SYNTHETIC_ACTION');
  });
  render(
    <RuntimeProvider>
      <Execution scope={scope} phase="completed" />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await screen.findByText('执行过程');
  expect(backend.invoke.mock.calls.filter(([command]) => command.type !== 'status')).toHaveLength(
    0,
  );
  await user.click(screen.getByText('执行过程'));
  await user.click(await screen.findByText('搜索网页 · 调用'));
  const content = await screen.findByLabelText('第 1 条记录内容');
  expect(content.textContent).toBe(long.slice(0, 32000));
  await user.click(screen.getByRole('button', { name: '继续读取内容' }));
  expect((await screen.findByLabelText('第 1 条记录内容')).textContent).toBe(long);
  await user.click(screen.getByRole('button', { name: '加载后续记录' }));
  expect(await screen.findByText('第 2 条')).toBeInTheDocument();
  expect(
    backend.invoke.mock.calls.every(([command]) =>
      ['status', 'transcript.list', 'transcript.content'].includes(command.type),
    ),
  ).toBe(true);
});

it('drops late private reads after changing to a group scope and blocks reads from an old environment', async () => {
  let release: (value: unknown) => unknown = () => undefined;
  const old = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const group: TranscriptScope = {
    bot: scope.bot,
    runId: 'mock-group-run',
    conversationId: 'mock-group',
  };
  const backend = bridge((command) =>
    command.type === 'transcript.list' && command.query.scope.conversationId
      ? { ...group, state: 'interrupted', items: [item(7)] }
      : old,
  );
  const view = render(
    <RuntimeProvider>
      <Execution scope={scope} phase="failed" />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText('执行过程'));
  await screen.findByText('正在读取记录…');
  view.rerender(
    <RuntimeProvider>
      <Execution scope={group} phase="stopped" />
    </RuntimeProvider>,
  );
  await user.click(screen.getByText('执行过程'));
  expect(await screen.findByText('执行记录不完整')).toBeInTheDocument();
  await act(async () => {
    release({ ...scope, state: 'complete', items: [item(1)] });
    await old;
  });
  expect(screen.queryByText('第 1 条')).not.toBeInTheDocument();
  expect(screen.getByText('第 7 条')).toBeInTheDocument();
  const before = backend.invoke.mock.calls.length;
  await act(async () => backend.publish({ ...backend.snapshot, protocolVersion: 32 }));
  expect(await screen.findByText('更新本地环境后可查看执行过程。')).toBeInTheDocument();
  expect(backend.invoke.mock.calls).toHaveLength(before);
});

it('StrictMode and an interrupted connection cannot restore stale event pages', async () => {
  let release: (value: unknown) => unknown = () => undefined;
  let reads = 0;
  const first = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const backend = bridge(() =>
    ++reads === 1 ? first : { ...scope, state: 'unavailable', items: [] },
  );
  render(
    <StrictMode>
      <RuntimeProvider>
        <Execution scope={scope} phase="completed" />
      </RuntimeProvider>
    </StrictMode>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText('执行过程'));
  expect(await screen.findByText('这次任务没有保留执行详情。')).toBeInTheDocument();
  await act(async () => {
    release({ ...scope, state: 'complete', items: [item(9)] });
    await first;
  });
  expect(screen.queryByText('第 9 条')).not.toBeInTheDocument();
  await act(async () => backend.publish(disconnected('offline')));
  expect(await screen.findByText('重新连接本地环境后可查看执行过程。')).toBeInTheDocument();
});

it('private conversation exposes the exact task transcript while retaining an unsent draft and task failure', async () => {
  const state = initialState();
  const bot = state.bots[0];
  const target = { bot: agentId(bot.id), runId: 'mock-conversation-run', chatRevision: 0 };
  const backend = bridge(() => ({ ...target, state: 'complete', items: [] }));
  backend.snapshot.agents[target.bot] = {
    ...target,
    phase: 'failed',
    running: false,
    requestId: 'mock-user-request',
    prompt: '合成请求',
    result: '',
    error: '合成失败',
    files: [],
    trace: [],
    history: [],
    toolCount: 1,
    executedCount: 0,
  };
  state.messages[bot.id] = [
    { id: `runtime-result:${target.runId}`, role: 'bot', text: '合成失败' },
  ];
  state.drafts[bot.id] = 'SYNTHETIC UNSENT DRAFT';
  const dispatch = vi.fn();
  render(
    <RuntimeProvider>
      <Conversation
        state={state}
        bot={bot}
        dispatch={dispatch}
        preview={vi.fn()}
        notify={vi.fn()}
        onModel={vi.fn()}
      />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText('执行过程'));
  expect(await screen.findByText('本次没有记录到工具或交互步骤。')).toBeInTheDocument();
  expect(screen.getByText('合成失败')).toBeInTheDocument();
  expect(screen.getByDisplayValue('SYNTHETIC UNSENT DRAFT')).toBeInTheDocument();
  expect(dispatch).not.toHaveBeenCalled();
  expect(
    backend.invoke.mock.calls.some(
      ([command]) =>
        command.type === 'transcript.list' &&
        JSON.stringify(command.query.scope) === JSON.stringify(target),
    ),
  ).toBe(true);
});

it('saved private history and group replies use their own author, run and conversation boundary', async () => {
  const state = initialState();
  const personal = state.bots.find((bot) => agentId(bot.id) === 'a')!;
  const old = { bot: 'a', runId: 'mock-history-run', chatRevision: 0 };
  let groupMode = false;
  const groupBot = state.bots.find((bot) => bot.id === 'crew')!;
  const grouped = { bot: 'b', runId: 'mock-reply-run', conversationId: 'crew' };
  const group = {
    id: 'crew',
    name: '合成协作群',
    members: ['a', 'b'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const backend = bridge((command) => {
    if (command.type === 'chat.history')
      return {
        bot: 'a',
        revision: 0,
        items: [
          {
            chatRevision: 0,
            runId: old.runId,
            requestId: 'mock-history-request',
            prompt: '合成旧请求',
            result: '合成旧回复',
            error: '',
            phase: 'completed',
          },
        ],
      };
    if (command.type === 'group.read')
      return {
        group,
        revision: 1,
        deliveries: [],
        messages: [
          {
            id: 'mock-reply',
            group: 'crew',
            sequence: 1,
            sourceId: 'mock-source',
            role: 'bot',
            author: 'b',
            name: '合成成员乙',
            runId: grouped.runId,
            text: '合成群回复',
            phase: 'completed',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      };
    if (command.type === 'transcript.list')
      return { ...(groupMode ? grouped : old), state: 'complete', items: [] };
    throw new Error('UNEXPECTED_SYNTHETIC_ACTION');
  });
  backend.snapshot.groups = { available: true, revision: 1, items: [group] };
  const user = userEvent.setup();
  const view = render(
    <RuntimeProvider>
      <ChatHistory
        bot={personal}
        revision={1}
        initialRevision={0}
        close={vi.fn()}
        notify={vi.fn()}
        preview={vi.fn()}
      />
    </RuntimeProvider>,
  );
  await user.click(await screen.findByText('执行过程'));
  expect(await screen.findByText('本次没有记录到工具或交互步骤。')).toBeInTheDocument();
  expect(
    backend.invoke.mock.calls.some(
      ([command]) =>
        command.type === 'transcript.list' &&
        JSON.stringify(command.query.scope) === JSON.stringify(old),
    ),
  ).toBe(true);
  view.unmount();
  groupMode = true;
  state.drafts.crew = 'SYNTHETIC GROUP DRAFT';
  render(
    <RuntimeProvider>
      <GroupChat
        state={state}
        bot={groupBot}
        dispatch={vi.fn()}
        notify={vi.fn()}
        preview={vi.fn()}
      />
    </RuntimeProvider>,
  );
  await user.click(await screen.findByText('执行过程'));
  expect(await screen.findByText('本次没有记录到工具或交互步骤。')).toBeInTheDocument();
  expect(screen.getByDisplayValue('SYNTHETIC GROUP DRAFT')).toBeInTheDocument();
  expect(
    backend.invoke.mock.calls.some(
      ([command]) =>
        command.type === 'transcript.list' &&
        JSON.stringify(command.query.scope) === JSON.stringify(grouped),
    ),
  ).toBe(true);
  expect(
    backend.invoke.mock.calls.some(([command]) =>
      ['group.send', 'task.start', 'interaction.reply'].includes(command.type),
    ),
  ).toBe(false);
});

it('follows only a reached live tail and stops polling after a complete page', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const backend = bridge((command) => {
    if (command.type !== 'transcript.list') throw new Error('UNEXPECTED_SYNTHETIC_ACTION');
    const after = command.query.after ?? 0;
    return {
      ...scope,
      state: after === 2 ? 'complete' : 'recording',
      items: [item(after + 1)],
      ...(after === 0 ? { nextAfter: 1 } : {}),
    };
  });
  render(
    <RuntimeProvider>
      <Execution scope={scope} phase="running" />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText('执行过程'));
  await screen.findByText('第 1 条');
  const calls = () =>
    backend.invoke.mock.calls.filter(([command]) => command.type === 'transcript.list');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(calls()).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '加载后续记录' }));
  await screen.findByText('第 2 条');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(await screen.findByText('第 3 条')).toBeInTheDocument();
  expect(calls()).toHaveLength(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(calls()).toHaveLength(3);
});

it('rejects mismatched content length and keeps raw tool output inert through an explicit retry', async () => {
  let corrupt = true;
  const text = '<script>MOCK_INERT</script>';
  const backend = bridge((command) => {
    if (command.type === 'transcript.list')
      return { ...scope, state: 'complete', items: [item(1, text.length)] };
    if (command.type === 'transcript.content')
      return {
        ...scope,
        seq: 1,
        offset: 0,
        total: corrupt ? text.length + 1 : text.length,
        text,
        ...(corrupt ? { nextOffset: text.length } : {}),
      };
    throw new Error('UNEXPECTED_SYNTHETIC_ACTION');
  });
  render(
    <RuntimeProvider>
      <Execution scope={scope} phase="completed" />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText('执行过程'));
  await user.click(await screen.findByText('搜索网页 · 调用'));
  expect(await screen.findByRole('alert')).toHaveTextContent('步骤内容与当前记录不一致');
  expect(screen.queryByLabelText('第 1 条记录内容')).not.toBeInTheDocument();
  corrupt = false;
  await user.click(screen.getByRole('button', { name: '重新读取内容' }));
  expect((await screen.findByLabelText('第 1 条记录内容')).textContent).toBe(text);
  expect(document.querySelector('.execution-content script')).toBeNull();
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'transcript.content'),
  ).toHaveLength(2);
});

it('task-result dialogs include collapsed execution summaries in the keyboard focus loop', async () => {
  const state = initialState(),
    bot = state.bots.find((bot) => agentId(bot.id) === 'a')!;
  const target = { bot: 'a', runId: 'mock-keyboard-result', chatRevision: 0 };
  bridge((command) =>
    command.type === 'chat.history'
      ? {
          bot: 'a',
          revision: 0,
          items: [
            {
              chatRevision: 0,
              runId: target.runId,
              requestId: 'mock-keyboard-request',
              prompt: '合成请求',
              result: '合成完成',
              error: '',
              phase: 'completed',
            },
          ],
        }
      : { ...target, state: 'complete', items: [] },
  );
  render(
    <RuntimeProvider>
      <ChatHistory
        bot={bot}
        revision={1}
        initialRevision={0}
        runId={target.runId}
        close={vi.fn()}
        notify={vi.fn()}
        preview={vi.fn()}
      />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  const summary = (await screen.findByText('执行过程')).closest('summary');
  expect(screen.getByRole('button', { name: '关闭对话框' })).toHaveFocus();
  await user.tab();
  expect(summary).toHaveFocus();
  // jsdom does not activate native details on Enter; real-browser acceptance covers that native toggle.
  await user.click(summary!);
  await screen.findByText('本次没有记录到工具或交互步骤。');
  await user.tab();
  expect(screen.getByRole('button', { name: '刷新记录' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: '关闭对话框' })).toHaveFocus();
});

it('waits for task preparation to finish before asking for a durable transcript', async () => {
  const backend = bridge(() => ({ ...scope, state: 'complete', items: [] }));
  const view = render(
    <RuntimeProvider>
      <Execution scope={scope} phase="starting" />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText('执行过程'));
  expect(await screen.findByText('任务正在准备，执行开始后会显示记录。')).toBeInTheDocument();
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'transcript.list'),
  ).toHaveLength(0);
  view.rerender(
    <RuntimeProvider>
      <Execution scope={scope} phase="running" />
    </RuntimeProvider>,
  );
  expect(await screen.findByText('本次没有记录到工具或交互步骤。')).toBeInTheDocument();
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'transcript.list'),
  ).toHaveLength(1);
});
