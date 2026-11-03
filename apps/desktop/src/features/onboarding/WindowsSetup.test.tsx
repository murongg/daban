import type { SetupStatus } from '@daban/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { LinuxSetup } from './LinuxSetup';

const mock = vi.hoisted(() => ({
  setup: {} as SetupStatus,
  command: vi.fn(async (_command: unknown) => ({})),
}));
vi.mock('../../app/Runtime', () => ({
  useRuntime: () => ({ snapshot: { setup: mock.setup }, command: mock.command }),
  runtimeError: () => '合成错误',
}));
beforeEach(() => {
  mock.command.mockClear();
  mock.setup = {
    required: true,
    target: 'linux',
    phase: 'available',
    windows: {
      acceleration: 'ready',
      memoryMiB: 6144,
      diskGiB: 64,
      requiredBytes: 8 * 1024 ** 3,
      availableBytes: 40 * 1024 ** 3,
    },
  };
});
it('installs the recommended environment with no virtual machine connection fields', async () => {
  render(<LinuxSetup />);
  expect(screen.getByText(/6 GB.*64 GB/)).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '安装 Linux 电脑' }));
  await waitFor(() =>
    expect(mock.command).toHaveBeenCalledWith({ type: 'setup.start', mode: 'whpx' }),
  );
});
it('requests Windows authorization only after install and makes slow compatibility mode an explicit choice', async () => {
  mock.setup.windows!.acceleration = 'disabled';
  render(<LinuxSetup />);
  expect(mock.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '安装 Linux 电脑' }));
  await waitFor(() =>
    expect(mock.command).toHaveBeenCalledWith({ type: 'setup.enable', confirmed: true }),
  );
  fireEvent.click(screen.getByText('其他安装方式'));
  fireEvent.click(screen.getByRole('button', { name: '使用兼容模式（较慢）' }));
  await waitFor(() =>
    expect(mock.command).toHaveBeenCalledWith({ type: 'setup.start', mode: 'tcg' }),
  );
});
it('explains a required restart and asks for confirmation without restarting on render or dismissal', async () => {
  mock.setup.phase = 'waiting';
  mock.setup.windows!.mode = 'whpx';
  mock.setup.windows!.acceleration = 'restart';
  render(<LinuxSetup />);
  expect(screen.getByText(/重启后.*继续安装/)).toBeVisible();
  expect(mock.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重启 Windows…' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '暂不重启' }));
  expect(mock.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重启 Windows…' }));
  fireEvent.click(screen.getByRole('button', { name: /^重启 Windows$/ }));
  await waitFor(() =>
    expect(mock.command).toHaveBeenCalledWith({ type: 'setup.restart', confirmed: true }),
  );
});

it('shows the optional download size and a measured download that can be paused', async () => {
  mock.setup.windows!.downloadBytes = 1.6 * 1024 ** 3;
  const view = render(<LinuxSetup />);
  expect(screen.getByText(/点击安装后下载.*1.6 GB/)).toBeVisible();
  expect(mock.command).not.toHaveBeenCalled();
  mock.setup = {
    ...mock.setup,
    phase: 'downloading',
    downloaded: 0.4 * 1024 ** 3,
    total: 1.6 * 1024 ** 3,
    progress: 25,
  };
  view.rerender(<LinuxSetup />);
  expect(screen.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute(
    'aria-valuenow',
    '25',
  );
  expect(screen.getByText(/0.4 GB.*1.6 GB.*25%/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '暂停安装' }));
  await waitFor(() => expect(mock.command).toHaveBeenCalledWith({ type: 'setup.cancel' }));
});
