import { disconnected, type RuntimeBridge, type RuntimeCommand } from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Computer } from './Computer';
import { Conversation } from './Conversation';
import { RuntimeProvider } from './Runtime';
import { initialState } from './state';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

it('shows an unavailable computer without disabling ordinary conversation or advertising takeover', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 17;
  snapshot.computerError = 'COMPUTER_START_FAILED';
  snapshot.bots = {};
  snapshot.model.configured = true;
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true,
    value: command.type === 'status' ? snapshot : 'data:image/jpeg;base64,c3ludGhldGlj',
  }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => {} } as unknown as RuntimeBridge,
    },
  });
  const state = initialState(),
    bot = state.bots.find((entry) => entry.id === 'research')!;
  state.drafts[bot.id] = '合成普通对话';
  const send = vi.fn();
  render(
    <RuntimeProvider>
      <Computer bot={bot} notify={vi.fn()} />
      <Conversation
        state={state}
        bot={bot}
        dispatch={vi.fn()}
        notify={vi.fn()}
        preview={vi.fn()}
        onModel={vi.fn()}
        onSend={send}
      />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('heading', { name: '电脑暂不可用' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '接管电脑' })).not.toBeInTheDocument();
  expect(screen.queryByText('Linux 桌面已连接')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls.map(([command]) => command.type)).not.toContain('frame');
});

it('offers managed computer connection for a newly registered logical Bot instead of the legacy two-target notice', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 19;
  snapshot.computers = { available: true, revision: 0, limit: 2, items: [] };
  const bot = { ...initialState().bots[0], id: 'mock-new-computer-bot', name: '合成新 Bot' };
  snapshot.profiles = [
    {
      id: bot.id,
      name: bot.name,
      instructions: '',
      memory: '',
      color: 'mint',
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true,
    value: command.type === 'status' ? snapshot : {},
  }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => {} } as unknown as RuntimeBridge,
    },
  });
  render(
    <RuntimeProvider>
      <Computer bot={bot} notify={vi.fn()} />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('button', { name: '连接电脑' })).toBeEnabled();
});

it('routes a new managed Bot screen and control through its own captured instance', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 19;
  const bot = { ...initialState().bots[0], id: 'mock-managed-screen', name: '合成独立屏幕' };
  snapshot.computers = {
    available: true,
    revision: 2,
    limit: 2,
    items: [
      {
        bot: bot.id,
        revision: 2,
        phase: 'connected',
        desired: true,
        reserved: true,
        instance: 'mock-managed-instance',
      },
    ],
  };
  snapshot.bots[bot.id] = {
    owner: 'human',
    epoch: 3,
    instance: 'mock-managed-instance',
    task: {
      running: false,
      phase: 'idle',
      prompt: '',
      result: '',
      error: '',
      files: [],
      toolCount: 0,
      executedCount: 0,
      trace: [],
      history: [],
    },
  };
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true,
    value:
      command.type === 'status'
        ? snapshot
        : command.type === 'frame'
          ? 'data:image/jpeg;base64,c3ludGhldGlj'
          : {},
  }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => {} } as unknown as RuntimeBridge,
    },
  });
  render(
    <RuntimeProvider>
      <Computer bot={bot} notify={vi.fn()} />
    </RuntimeProvider>,
  );
  await screen.findByRole('img', { name: `${bot.name}的 Linux 桌面` });
  await userEvent.click(screen.getByRole('button', { name: '交还给 Bot' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'control',
    bot: bot.id,
    epoch: 3,
    instance: 'mock-managed-instance',
    owner: 'agent',
  });
});

it('preserves a composed message while a computer change prevents starting another task', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 19;
  snapshot.model.configured = true;
  snapshot.computers = {
    available: true,
    revision: 1,
    limit: 2,
    items: [{ bot: 'a', revision: 1, phase: 'connecting', desired: true, reserved: true }],
  };
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true,
    value: command.type === 'status' ? snapshot : {},
  }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => {} } as unknown as RuntimeBridge,
    },
  });
  const state = initialState(),
    bot = state.bots.find((item) => item.id === 'research')!,
    send = vi.fn();
  state.drafts[bot.id] = '合成等待发送的内容';
  render(
    <RuntimeProvider>
      <Conversation
        state={state}
        bot={bot}
        dispatch={vi.fn()}
        notify={vi.fn()}
        preview={vi.fn()}
        onModel={vi.fn()}
        onSend={send}
      />
    </RuntimeProvider>,
  );
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  await userEvent.click(input);
  await userEvent.keyboard('{Enter}');
  expect(send).not.toHaveBeenCalled();
  expect(input).toHaveValue('合成等待发送的内容');
});
