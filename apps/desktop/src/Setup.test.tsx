import type { SetupStatus } from '@daban/protocol';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Setup } from './Setup';
import { selectControl, selectOption } from './select.fixture';

const mocks = vi.hoisted(() => ({
  state: { required: true, phase: 'available' } as SetupStatus,
  command: vi.fn(async () => ({})),
}));
vi.mock('./Runtime', () => ({
  useRuntime: () => ({ snapshot: { setup: mocks.state }, command: mocks.command }),
}));
it('starts real installation with a narrow command and no path, provider key or VM settings', async () => {
  mocks.state = { required: true, phase: 'available' };
  render(<Setup />);
  expect(screen.getByRole('heading', { name: '给 Bot 一个本地工作空间' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '创建本地环境' }));
  expect(mocks.command).toHaveBeenCalledWith({ type: 'setup.start' });
});
it('shows measured extraction progress and allows pause without claiming a running computer', async () => {
  mocks.state = { required: true, phase: 'extracting', progress: 37 };
  render(<Setup />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37');
  fireEvent.click(screen.getByRole('button', { name: '暂停安装' }));
  expect(mocks.command).toHaveBeenCalledWith({ type: 'setup.cancel' });
  expect(screen.queryByRole('button', { name: '创建本地环境' })).not.toBeInTheDocument();
});
it('keeps failed progress recoverable and never exposes raw host paths as error copy', () => {
  mocks.state = { required: true, phase: 'failed', error: 'SETUP_BUSY' };
  render(<Setup />);
  expect(screen.getByRole('alert')).toHaveTextContent('上一次安装操作仍在处理中');
  expect(screen.getByRole('button', { name: '继续安装' })).toBeInTheDocument();
});
it('makes missing bundles and unsupported hosts explicit without a fake install action', () => {
  mocks.state = { required: true, phase: 'unavailable', error: 'SETUP_MISSING' };
  const view = render(<Setup />);
  expect(screen.getByRole('alert')).toHaveTextContent('尚未附带本地运行环境');
  expect(screen.queryByRole('button', { name: '创建本地环境' })).not.toBeInTheDocument();
  mocks.state = { required: true, phase: 'unavailable', error: 'SETUP_PLATFORM' };
  view.rerender(<Setup />);
  expect(screen.getByRole('alert')).toHaveTextContent('Apple 芯片');
});

it('offers a language choice before installing Linux without starting setup', async () => {
  mocks.state = { required: true, phase: 'available' };
  mocks.command.mockClear();
  render(<Setup />);
  await selectOption(userEvent, selectControl('界面语言'), 'en');
  expect(screen.getByRole('heading', { name: 'Give your Bot a local workspace' })).toBeVisible();
  expect(mocks.command).not.toHaveBeenCalled();
});
