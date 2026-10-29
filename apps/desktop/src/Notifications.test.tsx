import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { NoticeBridge, NoticeMessage, NoticeStatus } from '../notifications';
import { Notifications } from './Notifications';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
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
