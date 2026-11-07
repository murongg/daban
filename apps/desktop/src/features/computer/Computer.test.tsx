import {
  disconnected,
  type HostBrowserStatus,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { demoState as initialState } from '../../test/fixtures';
import { Conversation } from '../chat/Conversation';
import { Computer } from './Computer';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

it('opens a standalone browser without Linux or desktop permission and explicitly hands it back', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 47;
  snapshot.agent = {
    location: 'host',
    execution: 'local-workspace',
    privilege: 'workspace',
    approvals: 'host',
  };
  snapshot.localComputer = {
    platform: 'darwin',
    available: true,
    permissions: { screen: false, accessibility: false },
    shortcut: true,
  };
  snapshot.hostBrowser = { available: true, connections: [] };
  const bot = { ...initialState().bots[0], id: 'mock-browser-bot' };
  let publish: (value: typeof snapshot) => unknown = () => {};
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status') return { ok: true, value: { ...snapshot } };
    if (command.type !== 'hostBrowser') return { ok: false, error: 'SYNTHETIC_UNEXPECTED_COMMAND' };
    const request = command.request;
    if (request.action === 'open')
      snapshot.hostBrowser = {
        available: true,
        connections: [
          {
            bot: bot.id,
            owner: 'human',
            epoch: 1,
            state: {
              bot: bot.id,
              available: true,
              instance: 'mock-instance',
              revision: 0,
              active: 'mock-tab',
              tabs: [{ id: 'mock-tab', url: 'about:blank', title: '', generation: 0 }],
            },
          },
        ],
      };
    const connection = snapshot.hostBrowser!.connections[0];
    if (request.action === 'state') return { ok: true, value: connection.state };
    if (request.action === 'view')
      return {
        ok: true,
        value: {
          bot: bot.id,
          epoch: connection.epoch,
          binding: { instance: 'mock-instance', tab: 'mock-tab', generation: 0 },
          width: 960,
          height: 640,
          image: 'data:image/jpeg;base64,c3ludGhldGlj',
        },
      };
    if (request.action === 'control') {
      snapshot.hostBrowser = {
        ...snapshot.hostBrowser!,
        connections: [{ ...connection, owner: request.owner, epoch: request.epoch + 1 }],
      };
      publish({ ...snapshot });
      return { ok: true, value: { owner: request.owner, epoch: request.epoch + 1 } };
    }
    publish({ ...snapshot });
    return { ok: true, value: snapshot.hostBrowser as HostBrowserStatus };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: typeof publish) => {
          publish = listener;
          return () => {};
        },
      } as RuntimeBridge,
    },
  });
  render(
    <RuntimeProvider>
      <Computer bot={bot} notify={vi.fn()} />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('textbox', { name: '网页地址' })).toBeDisabled();
  expect(screen.getByRole('form', { name: '浏览器导航' })).toBeVisible();
  await userEvent.click(await screen.findByRole('button', { name: '打开浏览器' }));
  expect(await screen.findByRole('button', { name: '交还给 Bot' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: '交还给 Bot' }));
  expect(await screen.findByRole('button', { name: '接管浏览器' })).toBeEnabled();
  expect(invoke.mock.calls.map(([command]) => command.type)).not.toContain('local.permissions');
  expect(invoke.mock.calls.map(([command]) => command.type)).not.toContain('setup.start');
  expect(invoke.mock.calls.map(([command]) => command.type)).not.toContain('computer.action');
});

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
