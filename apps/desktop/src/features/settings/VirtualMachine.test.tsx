import { disconnected, type RuntimeCommand, type VmConnectionStatus } from '@daban/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VirtualMachine } from './VirtualMachine';

const mock = vi.hoisted(() => ({
  command: vi.fn<(command: RuntimeCommand) => Promise<unknown>>(),
}));
vi.mock('../../app/Runtime', () => ({
  useRuntime: () => ({ enabled: true, snapshot: disconnected('ready'), command: mock.command }),
  runtimeError: () => '合成：后台任务忙，请稍后重试',
}));
beforeEach(() => {
  Object.defineProperty(window, 'daban', { configurable: true, value: { platform: 'win32' } });
  mock.command.mockReset();
});
afterEach(() => Reflect.deleteProperty(window, 'daban'));

it('shows managed Linux status and returns to native mode only after an idle handoff', async () => {
  let saved: VmConnectionStatus = {
    supported: true,
    connection: {
      provider: 'qemu',
      enabled: true,
      vmId: '11111111-2222-4333-8444-555555555555',
      host: '127.0.0.1',
      sshPort: 23456,
      user: 'mock-bot',
      identityFile: 'C:/mock/id_ed25519',
      hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  };
  let busy = true;
  mock.command.mockImplementation(async (command) => {
    if (command.type === 'vm.status') return saved;
    if (command.type === 'vm.native') {
      if (busy) throw new Error('AGENT_UPDATE_BUSY');
    }
    if (command.type === 'vm.native' && saved.connection)
      saved = { supported: true, connection: { ...saved.connection, enabled: false } };
    return saved;
  });
  render(<VirtualMachine />);
  const native = await screen.findByRole('button', { name: '返回本机模式' });
  fireEvent.click(native);
  expect(await screen.findByRole('alert')).toHaveTextContent('后台任务忙');
  busy = false;
  await waitFor(() => expect(native).toBeEnabled());
  fireEvent.click(native);
  await waitFor(() => expect(saved.connection?.enabled).toBe(false));
  expect(mock.command).toHaveBeenCalledWith({ type: 'vm.native' });
});

it('does not offer Windows VM controls on macOS', () => {
  Object.defineProperty(window, 'daban', { configurable: true, value: { platform: 'darwin' } });
  const view = render(<VirtualMachine />);
  expect(view.container).toBeEmptyDOMElement();
  expect(mock.command).not.toHaveBeenCalled();
});
