import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  UpdateBridge,
  UpdateCommand,
  UpdateMessage,
  UpdateStatus,
} from '../../../shared/updates';
import { UpdatesPanel } from './Updates';
import { UpdateProvider, useUpdateSave } from './update';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function Workspace({ save }: { save: () => unknown }) {
  useUpdateSave(save);
  return <p>Synthetic workspace</p>;
}
function fixture(initial: UpdateStatus) {
  let status = initial;
  let receive: (message: UpdateMessage) => unknown = () => {};
  const invoke = vi.fn(async (command: UpdateCommand) => {
    if (command.type === 'download') status = { ...status, phase: 'downloading', percent: 0 };
    if (command.type === 'install') status = { ...status, phase: 'installing' };
    return { ok: true as const, value: status };
  });
  const bridge: UpdateBridge = {
    invoke,
    subscribe: (callback) => {
      receive = callback;
      return () => {};
    },
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', updates: bridge },
  });
  return { invoke, emit: (message: UpdateMessage) => receive(message) };
}
it('shows download progress and requires explicit confirmation before restarting', async () => {
  const live = fixture({
    phase: 'available',
    version: '1.0.0',
    nextVersion: '1.1.0',
    notes: 'Synthetic release',
  });
  render(
    <UpdateProvider>
      <UpdatesPanel />
    </UpdateProvider>,
  );
  expect(await screen.findByText(/1.1.0/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '下载更新' }));
  await act(async () =>
    live.emit({
      type: 'status',
      status: { phase: 'downloading', version: '1.0.0', nextVersion: '1.1.0', percent: 42 },
    }),
  );
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  await act(async () =>
    live.emit({
      type: 'status',
      status: { phase: 'downloaded', version: '1.0.0', nextVersion: '1.1.0', percent: 100 },
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: '重启并安装' }));
  expect(live.invoke).not.toHaveBeenCalledWith({ type: 'install' });
  expect(screen.getByText(/保存尚未提交的设置/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '已保存，重启安装' }));
  await waitFor(() => expect(live.invoke).toHaveBeenCalledWith({ type: 'install' }));
});
it('acknowledges workspace persistence and refuses a failed save', async () => {
  const live = fixture({ phase: 'idle', version: '1.0.0' });
  const save = vi.fn(() => {
    throw Error('SYNTHETIC_QUOTA');
  });
  render(
    <UpdateProvider>
      <Workspace save={save} />
    </UpdateProvider>,
  );
  await act(async () => live.emit({ type: 'prepare', id: 'a'.repeat(48) }));
  await waitFor(() =>
    expect(live.invoke).toHaveBeenCalledWith({ type: 'saved', id: 'a'.repeat(48), success: false }),
  );
});
it('cannot check or install updates in a plain browser preview', () => {
  render(
    <UpdateProvider>
      <UpdatesPanel />
    </UpdateProvider>,
  );
  expect(screen.queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument();
  expect(screen.getByText(/网页预览/)).toBeVisible();
});

it('returns to the update card and exposes a busy-host rejection after confirmation', async () => {
  const live = fixture({ phase: 'downloaded', version: '1.0.0', nextVersion: '1.1.0' });
  render(
    <UpdateProvider>
      <UpdatesPanel />
    </UpdateProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '重启并安装' }));
  live.invoke.mockRejectedValueOnce(Error('AGENT_UPDATE_BUSY'));
  await userEvent.click(screen.getByRole('button', { name: '已保存，重启安装' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('alert')).toHaveTextContent('后台仍有任务');
});
