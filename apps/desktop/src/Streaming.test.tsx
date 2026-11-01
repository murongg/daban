import { beforeEach as seedBeforeEach } from 'vitest';
import { demoState as seedDemoState } from './fixtures';
import { serialize as seedSerialize, storageKey as seedStorageKey } from './storage';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
  type RuntimeTask,
} from '@daban/protocol';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { Conversation } from './Conversation';
import { demoState as initialState } from './fixtures';
import { RuntimeProvider } from './Runtime';
import * as workspace from './state';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const base: RuntimeTask = {
  running: true,
  phase: 'running',
  runId: 'mock-stream-a',
  requestId: 'mock-request-a',
  prompt: '合成请求',
  result: '',
  error: '',
  files: [],
  toolCount: 0,
  executedCount: 0,
  trace: [],
  history: [],
  response: { revision: 1, text: '合成前缀甲', state: 'streaming' },
};
function connect() {
  let state = disconnected('ready');
  state.protocolVersion = 4;
  state.model.configured = true;
  state.agents = {
    a: { ...base },
    b: {
      ...base,
      runId: 'mock-stream-b',
      requestId: 'mock-request-b',
      response: { revision: 1, text: '合成前缀乙', state: 'streaming' },
    },
  };
  const listeners = new Set<(state: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(
    async (command: RuntimeCommand): Promise<RuntimeReply> => ({
      ok: true,
      value: command.type === 'status' ? state : {},
    }),
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (state: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return {
    state,
    invoke,
    emit(bot: string, patch: Partial<RuntimeTask>) {
      state = { ...state, agents: { ...state.agents, [bot]: { ...state.agents[bot], ...patch } } };
      act(() => {
        for (const listener of listeners) listener(state);
      });
    },
  };
}

it('labels model schedule management as a tool operation instead of computer control', async () => {
  const backend = connect();
  backend.emit('a', {
    toolCount: 1,
    response: undefined,
    trace: [
      {
        name: 'bot_schedule_list',
        surface: 'schedule',
        phase: 'running',
        at: '2026-01-01T00:00:00Z',
      },
    ],
  });
  render(<App />);
  expect(await screen.findByText('正在管理定时任务')).toBeVisible();
  expect(screen.queryByText('正在操作电脑')).not.toBeInTheDocument();
});

it('labels preference reads and saves without implying computer operation', async () => {
  const backend = connect();
  backend.emit('a', {
    toolCount: 1,
    response: undefined,
    trace: [
      { name: 'bot_memory_write', surface: 'memory', phase: 'running', at: '2026-01-01T00:00:00Z' },
    ],
  });
  render(<App />);
  expect(await screen.findByText('正在整理工作偏好')).toBeVisible();
  expect(screen.queryByText('正在操作电脑')).not.toBeInTheDocument();
});

it('labels history retrieval and unknown general tools without implying computer control', async () => {
  const backend = connect();
  backend.emit('a', {
    toolCount: 1,
    response: undefined,
    trace: [
      {
        name: 'bot_history_search',
        surface: 'history',
        phase: 'running',
        at: '2026-01-01T00:00:00Z',
      },
    ],
  });
  render(<App />);
  expect(await screen.findByText('正在查找历史')).toBeVisible();
  backend.emit('a', {
    trace: [
      {
        name: 'mock_tool',
        surface: 'mock-extension',
        phase: 'running',
        at: '2026-01-01T00:00:00Z',
      },
    ],
  });
  expect(await screen.findByText('正在使用工具')).toBeVisible();
  expect(screen.queryByText('正在操作电脑')).not.toBeInTheDocument();
});
it('replaces a streamed prefix with one final bubble and preserves another Bot response while switching', async () => {
  const runtime = connect();
  render(<App />);
  const prefix = await screen.findByText('合成前缀甲');
  const bubble = prefix.closest('article');
  expect(localStorage.getItem('daban.workspace.v1')).not.toContain('合成前缀甲');
  runtime.emit('a', { response: { revision: 2, text: '合成前缀甲继续', state: 'streaming' } });
  expect(screen.getByText('合成前缀甲继续').closest('article')).toBe(bubble);
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
  expect(screen.getByText('合成前缀乙')).toBeVisible();
  runtime.emit('a', {
    running: false,
    phase: 'completed',
    result: '合成最终回答甲',
    response: undefined,
  });
  expect(screen.queryByText('合成最终回答甲')).not.toBeInTheDocument();
  await userEvent.click(within(nav).getByRole('button', { name: '研究员' }));
  expect(screen.getAllByText('合成最终回答甲')).toHaveLength(1);
  expect(screen.queryByText('合成前缀甲继续')).not.toBeInTheDocument();
});
it('follows streaming and late layout growth without mistaking layout scrolls for reading history', async () => {
  const observers = new Map<Element, () => unknown>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private elements: Element[] = [];
      constructor(private callback: () => unknown) {}
      observe(element: Element) {
        this.elements.push(element);
        observers.set(element, this.callback);
      }
      unobserve(element: Element) {
        observers.delete(element);
      }
      disconnect() {
        for (const element of this.elements) observers.delete(element);
      }
    },
  );
  try {
    const runtime = connect();
    const local = initialState();
    local.messages.research = [{ id: 'mock-request-a', role: 'user', text: '合成请求' }];
    render(
      <RuntimeProvider>
        <Conversation
          state={local}
          bot={local.bots.find((bot) => bot.id === 'research')!}
          dispatch={vi.fn()}
          notify={vi.fn()}
          preview={vi.fn()}
          onModel={vi.fn()}
        />
      </RuntimeProvider>,
    );
    await screen.findByText('合成前缀甲');
    const log = screen.getByRole('log', { name: '对话记录' });
    let height = 1000;
    let viewport = 400;
    let top = 600;
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => viewport },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, height - viewport));
        },
      },
    });
    fireEvent.scroll(log);
    // New layout can emit a scroll event before the reply's effect runs.
    height = 1800;
    fireEvent.scroll(log);
    runtime.emit('a', { response: { revision: 2, text: '合成前缀甲继续', state: 'streaming' } });
    expect(log.scrollTop).toBe(1400);
    fireEvent.scroll(log);
    const resize = () =>
      act(() => {
        observers.get(log)?.();
        if (log.firstElementChild) observers.get(log.firstElementChild)?.();
      });
    // Markdown, images and execution disclosures can grow without a new response revision.
    height = 2200;
    resize();
    expect(log.scrollTop).toBe(1800);
    viewport = 300;
    resize();
    expect(log.scrollTop).toBe(1900);
    log.scrollTop = 200;
    fireEvent.scroll(log);
    height = 2600;
    resize();
    runtime.emit('a', {
      response: { revision: 3, text: '合成前缀甲继续更多', state: 'streaming' },
    });
    expect(log.scrollTop).toBe(200);
    log.scrollTop = 2300;
    fireEvent.scroll(log);
    height = 3000;
    resize();
    expect(log.scrollTop).toBe(2700);
  } finally {
    vi.unstubAllGlobals();
  }
});
it('places a continued response after its settled question card', async () => {
  const runtime = connect();
  runtime.state.interactions = [
    {
      id: 'mock-question',
      bot: 'a',
      runId: 'mock-stream-a',
      sessionId: 'mock-session',
      kind: 'question',
      questions: [{ id: 'format', question: '合成格式？' }],
      status: 'resolved',
      reply: { kind: 'answer', answers: [{ id: 'format', selected: [], custom: 'Markdown' }] },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  render(<App />);
  const answer = (await screen.findByText('合成前缀甲')).closest('article')!;
  const question = screen.getByText('已回复').closest('article')!;
  expect(question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('does not replay unchanged task history through the reducer on each response snapshot', async () => {
  const reduce = vi.spyOn(workspace, 'reduce');
  try {
    const runtime = connect();
    runtime.state.agents.a.history = [
      {
        runId: base.runId!,
        requestId: base.requestId!,
        phase: base.phase,
        prompt: base.prompt,
        result: '',
        error: '',
        files: [],
      },
    ];
    render(<App />);
    await screen.findByText('合成前缀甲');
    await act(async () => {
      await Promise.resolve();
    });
    reduce.mockClear();
    runtime.emit('a', { response: { revision: 2, text: '合成增量甲', state: 'streaming' } });
    expect(reduce.mock.calls.filter(([, action]) => action.type === 'runtime-task')).toHaveLength(
      0,
    );
    runtime.emit('a', {
      running: false,
      phase: 'completed',
      result: '合成完整甲',
      response: undefined,
    });
    expect(await screen.findByText('合成完整甲')).toBeVisible();
  } finally {
    reduce.mockRestore();
  }
});

it.each([
  ['browser_navigate', '正在浏览网页'],
  ['browser_snapshot', '正在读取页面'],
  ['browser_act', '正在操作网页'],
  ['browser_tabs', '正在管理标签页'],
  ['browser_upload', '正在上传文件'],
  ['browser_download', '正在下载文件'],
])('labels %s as its actual browser operation', async (name, label) => {
  const backend = connect();
  backend.emit('a', {
    toolCount: 1,
    response: undefined,
    trace: [{ name, surface: 'browser', phase: 'running', at: '2026-01-01T00:00:00Z' }],
  });
  render(<App />);
  expect(await screen.findByText(label)).toBeVisible();
  expect(screen.queryByText('正在操作电脑')).not.toBeInTheDocument();
});
