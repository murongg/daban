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

it('sends a validated manual VM connection, retains failed drafts and offers return to native mode', async () => {
  let saved: VmConnectionStatus = { supported: true };
  let busy = true;
  mock.command.mockImplementation(async (command) => {
    if (command.type === 'vm.status') return saved;
    if (command.type === 'vm.configure') {
      if (busy) throw new Error('AGENT_UPDATE_BUSY');
      saved = { supported: true, connection: command.connection };
    }
    if (command.type === 'vm.native' && saved.connection)
      saved = { supported: true, connection: { ...saved.connection, enabled: false } };
    return saved;
  });
  render(<VirtualMachine />);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('高级：手动连接 Hyper-V'));
  const host = await screen.findByRole('textbox', { name: '虚拟机地址' });
  fireEvent.change(host, { target: { value: '192.0.2.10' } });
  for (const [name, value] of [
    ['Hyper-V 虚拟机 ID', '11111111-2222-4333-8444-555555555555'],
    ['SSH 用户名', 'mock-bot'],
    ['SSH 私钥路径', 'C:/mock/id_ed25519'],
    [
      'SSH 主机公钥',
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ],
  ])
    fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '保存并连接虚拟机' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('后台任务忙');
  expect(host).toHaveValue('192.0.2.10');
  busy = false;
  fireEvent.click(screen.getByRole('button', { name: '保存并连接虚拟机' }));
  const native = await screen.findByRole('button', { name: '返回本机模式' });
  await waitFor(() => expect(native).toBeEnabled());
  fireEvent.click(native);
  await waitFor(() => expect(mock.command).toHaveBeenCalledWith({ type: 'vm.native' }));
  expect(JSON.stringify(mock.command.mock.calls)).not.toContain('PRIVATE KEY');
});

it('does not offer Windows VM controls on macOS', () => {
  Object.defineProperty(window, 'daban', { configurable: true, value: { platform: 'darwin' } });
  const view = render(<VirtualMachine />);
  expect(view.container).toBeEmptyDOMElement();
  expect(mock.command).not.toHaveBeenCalled();
});
