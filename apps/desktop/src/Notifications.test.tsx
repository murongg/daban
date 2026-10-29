import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { NoticeBridge, NoticeMessage, NoticeStatus } from '../notifications';
import { Notifications } from './Notifications';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

function mockBotStatus(scope = 'a'.repeat(64), name = '合成甲'): NoticeStatus {
  return {
    available: true,
    supported: true,
    enabled: false,
    revision: 4,
    delivery: 'untried',
    runtime: 'ready',
    scope,
    bots: [
      { id: 'mock-alpha', name, enabled: true },
      { id: 'mock-beta', name: '合成乙', enabled: true },
    ],
  };
}

it('ignores the initial read from a disposed StrictMode effect after its replacement has loaded', async () => {
  const finish: ((value: unknown) => unknown)[] = [];
  const invoke = vi.fn(
    () =>
      new Promise((resolve) => {
        finish.push(resolve);
      }),
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      notifications: { invoke, subscribe: () => () => {} } as NoticeBridge,
    },
  });
  render(
    <StrictMode>
      <Notifications />
    </StrictMode>,
  );
  await waitFor(() => expect(finish).toHaveLength(2));
  const current = {
    ...mockBotStatus('b'.repeat(64)),
    bots: [{ id: 'mock-new', name: '合成新工作区', enabled: true }],
  };
  await act(async () => finish[1]({ ok: true, value: current }));
  expect(await screen.findByRole('checkbox', { name: '合成新工作区的私聊桌面提醒' })).toBeChecked();
  await act(async () => finish[0]({ ok: true, value: mockBotStatus() }));
  expect(screen.queryByRole('checkbox', { name: '合成甲的私聊桌面提醒' })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '合成新工作区的私聊桌面提醒' })).toBeChecked();
});

it('never enables a private control from an offline status carrying cached scope metadata', async () => {
  const status = { ...mockBotStatus(), runtime: 'offline' as const };
  const invoke = vi.fn(async () => ({ ok: true, value: status }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      notifications: { invoke, subscribe: () => () => {} } as NoticeBridge,
    },
  });
  render(<Notifications />);
  expect(await screen.findByRole('checkbox', { name: '合成甲的私聊桌面提醒' })).toBeDisabled();
});

it('saves private Bot choices without enabling global notifications and preserves choices after a failed write', async () => {
  let status = mockBotStatus();
  const invoke = vi.fn(async (command) => {
    if (command.type === 'bot.configure') {
      if (command.bot === 'mock-beta') return { ok: false, error: 'NOTIFICATION_SCOPE_CHANGED' };
      status = {
        ...status,
        revision: status.revision + 1,
        bots: status.bots!.map((bot) =>
          bot.id === command.bot ? { ...bot, enabled: command.enabled } : bot,
        ),
      };
    }
    return { ok: true, value: status };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      notifications: { invoke, subscribe: () => () => {} } as NoticeBridge,
    },
  });
  render(<Notifications />);
  const alpha = await screen.findByRole('checkbox', { name: '合成甲的私聊桌面提醒' });
  const beta = screen.getByRole('checkbox', { name: '合成乙的私聊桌面提醒' });
  await userEvent.click(alpha);
  expect(invoke).toHaveBeenCalledWith({
    type: 'bot.configure',
    revision: 4,
    scope: 'a'.repeat(64),
    bot: 'mock-alpha',
    enabled: false,
  });
  await waitFor(() => expect(alpha).not.toBeChecked());
  expect(screen.getByRole('checkbox', { name: '接收桌面提醒' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: '发送测试提醒' })).toBeDisabled();
  await userEvent.click(beta);
  expect(await screen.findByRole('alert')).toHaveTextContent('工作区已切换');
  expect(beta).toBeChecked();
  expect(alpha).not.toBeChecked();
});

it('keeps a newer scoped subscription snapshot when an older initial read arrives late', async () => {
  let finish: (value: unknown) => unknown = () => {};
  let listener: (value: NoticeMessage) => unknown = () => {};
  const invoke = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      notifications: {
        invoke,
        subscribe: (callback) => {
          listener = callback;
          return () => {};
        },
      } as NoticeBridge,
    },
  });
  render(<Notifications />);
  const current = {
    ...mockBotStatus('b'.repeat(64)),
    bots: [{ id: 'mock-new', name: '合成新工作区', enabled: true }],
  };
  await act(async () => listener({ type: 'status', status: current }));
  expect(await screen.findByRole('checkbox', { name: '合成新工作区的私聊桌面提醒' })).toBeChecked();
  await act(async () => finish({ ok: true, value: mockBotStatus() }));
  expect(screen.queryByRole('checkbox', { name: '合成甲的私聊桌面提醒' })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '合成新工作区的私聊桌面提醒' })).toBeChecked();
});

it('does not replace new workspace choices with a delayed mutation response', async () => {
  const first = mockBotStatus();
  let finish: (value: unknown) => unknown = () => {};
  let listener: (value: NoticeMessage) => unknown = () => {};
  const invoke = vi.fn((command) =>
    command.type === 'status'
      ? Promise.resolve({ ok: true, value: first })
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      notifications: {
        invoke,
        subscribe: (callback) => {
          listener = callback;
          return () => {};
        },
      } as NoticeBridge,
    },
  });
  render(<Notifications />);
  await userEvent.click(await screen.findByRole('checkbox', { name: '合成甲的私聊桌面提醒' }));
  const next = {
    ...mockBotStatus('b'.repeat(64)),
    revision: 5,
    bots: [{ id: 'mock-new', name: '合成新工作区', enabled: true }],
  };
  await act(async () => listener({ type: 'status', status: next }));
  await act(async () =>
    finish({
      ok: true,
      value: {
        ...first,
        revision: 5,
        bots: [{ id: 'mock-alpha', name: '合成甲', enabled: false }],
      },
    }),
  );
  expect(screen.queryByRole('checkbox', { name: '合成甲的私聊桌面提醒' })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '合成新工作区的私聊桌面提醒' })).toBeEnabled();
});

it('leaves saved private choices visible but disabled without a current workspace scope', async () => {
  const status = { ...mockBotStatus(), scope: undefined, runtime: 'offline' as const };
  const invoke = vi.fn(async () => ({ ok: true, value: status }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      notifications: { invoke, subscribe: () => () => {} } as NoticeBridge,
    },
  });
  render(<Notifications />);
  expect(await screen.findByRole('checkbox', { name: '合成甲的私聊桌面提醒' })).toBeDisabled();
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('requires explicit opt-in and reports a test as submitted, never as proven OS delivery', async () => {
  let status: NoticeStatus = {
    available: true,
    supported: true,
    enabled: false,
    revision: 0,
    delivery: 'untried',
    runtime: 'ready',
  };
  let listener: (value: NoticeMessage) => unknown = () => {};
  const invoke = vi.fn(async (command) => {
    if (command.type === 'configure')
      status = { ...status, enabled: command.enabled, revision: status.revision + 1 };
    if (command.type === 'test') status = { ...status, delivery: 'submitted' };
    return { ok: true, value: status };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      notifications: {
        invoke,
        subscribe: (callback) => {
          listener = callback;
          return () => {};
        },
      } as NoticeBridge,
    },
  });
  render(<Notifications />);
  const enabled = await screen.findByRole('checkbox', { name: '接收桌面提醒' });
  expect(enabled).not.toBeChecked();
  expect(screen.getByRole('button', { name: '发送测试提醒' })).toBeDisabled();
  expect(invoke.mock.calls.map(([value]) => value.type)).toEqual(['status']);
  await userEvent.click(enabled);
  expect(invoke).toHaveBeenCalledWith({ type: 'configure', enabled: true, revision: 0 });
  await waitFor(() => expect(enabled).toBeChecked());
  await userEvent.click(screen.getByRole('button', { name: '发送测试提醒' }));
  expect(await screen.findByText(/测试提醒已提交给系统/)).toBeVisible();
  await act(async () => {
    listener({
      type: 'status',
      status: { ...status, delivery: 'failed', error: 'NOTIFICATION_DELIVERY_FAILED' },
    });
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('系统未接受提醒');
});
it('keeps the setting unchanged on a failed save and leaves other work available', async () => {
  const status: NoticeStatus = {
    available: true,
    supported: true,
    enabled: false,
    revision: 0,
    delivery: 'untried',
    runtime: 'partial',
  };
  const invoke = vi.fn(async (command) =>
    command.type === 'configure'
      ? { ok: false, error: 'NOTIFICATION_CONFIG_CHANGED' }
      : { ok: true, value: status },
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      notifications: { invoke, subscribe: () => () => {} } as NoticeBridge,
    },
  });
  render(<Notifications />);
  const control = await screen.findByRole('checkbox', { name: '接收桌面提醒' });
  await userEvent.click(control);
  expect(await screen.findByRole('alert')).toHaveTextContent('通知设置文件已变化');
  expect(control).not.toBeChecked();
});
