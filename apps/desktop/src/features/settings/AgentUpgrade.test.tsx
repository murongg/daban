import { disconnected, type RuntimeSnapshot } from '@daban/protocol';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentUpgradeNotice, AgentUpgradePanel } from './AgentUpgrade';

const mock = vi.hoisted(() => ({
  snapshot: {} as RuntimeSnapshot,
  command: vi.fn(async () => ({})),
}));
vi.mock('../../app/Runtime', () => ({
  useRuntime: () => mock,
  runtimeError: () => 'Synthetic failure',
}));
afterEach(() => Reflect.deleteProperty(window, 'daban'));
function fixture() {
  mock.command.mockClear();
  mock.snapshot = {
    ...disconnected('ready'),
    protocolVersion: 42,
    model: { configured: true, available: true, provider: 'mock', model: 'mock-chat' },
    groups: { available: true, revision: 0, items: [] },
    schedules: { available: true, items: [] },
    setup: {
      required: false,
      target: 'agent',
      phase: 'waiting',
      error: 'AGENT_LEGACY_RESTART_REQUIRED',
    },
  };
  Object.defineProperty(window, 'daban', { configurable: true, value: { platform: 'darwin' } });
}
it('explains the legacy upgrade and defers without restarting anything', () => {
  fixture();
  render(<AgentUpgradeNotice />);
  expect(screen.getByRole('dialog', { name: '后台需要升级' })).toBeVisible();
  expect(screen.getByText(/Linux 电脑和数据会保留/)).toBeVisible();
  expect(mock.command).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '稍后' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: '稍后' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mock.command).not.toHaveBeenCalled();
});
it('sends a confirmed upgrade only after the user chooses restart', async () => {
  fixture();
  render(<AgentUpgradeNotice />);
  fireEvent.click(screen.getByRole('button', { name: '重启并升级后台' }));
  expect(mock.command).toHaveBeenCalledWith({ type: 'agent.upgrade', confirmed: true });
});
it('disables restart while a task is still running', () => {
  fixture();
  mock.snapshot.agents['mock-bot'] = {
    running: true,
    phase: 'waiting',
    prompt: 'Synthetic',
    result: '',
    error: '',
    files: [],
    toolCount: 0,
    executedCount: 0,
    trace: [],
    history: [],
  };
  render(<AgentUpgradeNotice />);
  expect(screen.getByRole('button', { name: '重启并升级后台' })).toBeDisabled();
});

it('releases the settings parent when another owner finishes the legacy upgrade', () => {
  fixture();
  const changed = vi.fn();
  const view = render(<AgentUpgradePanel onDialogChange={changed} />);
  fireEvent.click(screen.getByRole('button', { name: '查看后台升级' }));
  expect(changed).toHaveBeenLastCalledWith(true);
  mock.snapshot = { ...mock.snapshot, setup: { required: false, phase: 'complete' } };
  view.rerender(<AgentUpgradePanel onDialogChange={changed} />);
  expect(changed).toHaveBeenLastCalledWith(false);
});
