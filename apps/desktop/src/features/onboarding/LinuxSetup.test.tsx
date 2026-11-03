import type { SetupStatus } from '@daban/protocol';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LinuxSetup } from './LinuxSetup';

const mock = vi.hoisted(() => ({
  setup: { required: true, target: 'linux', phase: 'available' } as SetupStatus,
  command: vi.fn(async () => ({})),
}));
vi.mock('../../app/Runtime', () => ({
  useRuntime: () => ({ snapshot: { setup: mock.setup }, command: mock.command }),
}));
it('offers Linux as an explicit optional install', () => {
  render(<LinuxSetup />);
  expect(screen.getByText(/不影响聊天/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '安装 Linux 电脑' }));
  expect(mock.command).toHaveBeenCalledWith({ type: 'setup.start' });
});
it('shows actual download progress and a pause control', () => {
  mock.setup = {
    required: true,
    target: 'linux',
    phase: 'downloading',
    progress: 25,
    downloaded: 25,
    total: 100,
  };
  render(<LinuxSetup />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  fireEvent.click(screen.getByRole('button', { name: '暂停安装' }));
  expect(mock.command).toHaveBeenCalledWith({ type: 'setup.cancel' });
});
