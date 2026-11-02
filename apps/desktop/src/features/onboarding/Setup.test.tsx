import type { SetupStatus } from '@daban/protocol';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { selectControl, selectOption } from '../../test/select.fixture.ts';
import { Setup } from './Setup';

const mocks = vi.hoisted(() => ({
  state: { required: true, phase: 'available' } as SetupStatus,
  command: vi.fn(async () => ({})),
}));
vi.mock('../../app/Runtime', () => ({
  useRuntime: () => ({ snapshot: { setup: mocks.state }, command: mocks.command }),
}));
it('starts real installation with a narrow command and no path, provider key or VM settings', async () => {
  mocks.state = { required: true, phase: 'available' };
  render(<Setup />);
  expect(screen.getByRole('heading', { name: '给 Bot 一个本地工作空间' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '创建本地环境' }));
  expect(mocks.command).toHaveBeenCalledWith({ type: 'setup.start' });
});
it.each([0, 37, 100])(
  'shows measured extraction progress %s and allows pause',
  async (progress) => {
    mocks.state = { required: true, phase: 'extracting', progress };
    render(<Setup />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(progress));
    fireEvent.click(screen.getByRole('button', { name: '暂停安装' }));
    expect(mocks.command).toHaveBeenCalledWith({ type: 'setup.cancel' });
    expect(screen.queryByRole('button', { name: '创建本地环境' })).not.toBeInTheDocument();
  },
);
it('pairs the companion with an ordered live step and distinct completed and waiting steps', () => {
  mocks.state = { required: true, phase: 'starting' };
  render(<Setup />);
  expect(screen.getByRole('heading', { name: '搭子正在布置工作空间' })).toBeVisible();
  const steps = within(screen.getByRole('list', { name: '安装步骤' })).getAllByRole('listitem');
  expect(steps).toHaveLength(5);
  for (const step of steps.slice(0, 3)) expect(step).toHaveTextContent('已完成');
  expect(steps[3]).toHaveAttribute('aria-current', 'step');
  expect(steps[3]).toHaveTextContent('启动本地环境');
  expect(steps[3]).toHaveTextContent('进行中');
  expect(steps[4]).toHaveTextContent('待执行');
  expect(screen.getByRole('status')).toHaveTextContent('启动本地环境');
  expect(document.querySelector('.setup-companion')).toHaveAttribute('data-active', 'true');
});
it.each([undefined, Number.NaN, -1, 101])(
  'does not invent extraction progress for %s',
  (progress) => {
    mocks.state = { required: true, phase: 'extracting', progress };
    render(<Setup />);
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('准备 Linux 系统');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  },
);
it('stops the companion and offers recovery when pausing or paused without inventing completed steps', () => {
  mocks.state = { required: true, phase: 'cancelling' };
  const view = render(<Setup />);
  expect(screen.getByRole('status')).toHaveTextContent('正在保存当前进度');
  expect(screen.getByRole('button', { name: '暂停安装' })).toBeDisabled();
  expect(document.querySelector('.setup-companion')).toHaveAttribute('data-active', 'false');
  mocks.state = { required: true, phase: 'cancelled' };
  view.rerender(<Setup />);
  expect(screen.getByRole('status')).toHaveTextContent('安装已暂停');
  expect(screen.queryByRole('list', { name: '安装步骤' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '继续安装' })).toBeEnabled();
});
it('keeps failed progress recoverable and never exposes raw host paths as error copy', () => {
  mocks.state = { required: true, phase: 'failed', error: 'SETUP_BUSY' };
  render(<Setup />);
  expect(screen.getByRole('alert')).toHaveTextContent('上一次安装操作仍在处理中');
  expect(screen.getByRole('button', { name: '继续安装' })).toBeInTheDocument();
  expect(document.querySelector('.setup-companion')).toHaveAttribute('data-active', 'false');
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
  const view = render(<Setup />);
  await selectOption(userEvent, selectControl('界面语言'), 'en');
  expect(screen.getByRole('heading', { name: 'Give your Bot a local workspace' })).toBeVisible();
  expect(mocks.command).not.toHaveBeenCalled();
  mocks.state = { required: true, phase: 'connecting' };
  view.rerender(<Setup />);
  expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Connect workspace');
});
