import type {
  RemoteBridge,
  RemoteCommand,
  RemoteState,
  RuntimeBridge,
  RuntimeCommand,
  RuntimeReply,
} from '@daban/protocol';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteProvider } from '../../app/Remote';
import { RemoteButton } from './Remote';

afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
});
function fixture() {
  const state: RemoteState = {
    selected: null,
    hosting: false,
    server: '',
    pending: [],
    identity: { id: 'a'.repeat(64), publicKey: 'A'.repeat(59), name: 'Synthetic local' },
    hosts: [
      {
        identity: { id: 'b'.repeat(64), publicKey: 'B'.repeat(59), name: 'Synthetic remote' },
        server: 'https://127.0.0.1:45678',
        workspace: 'synthetic-workspace',
        platform: 'linux',
        state: 'offline',
        transport: 'unknown',
      },
    ],
  };
  const pairingCode = '123456';
  const clipboard = vi.fn(async (_command: RuntimeCommand) => ({
    ok: true as const,
    value: { copied: true },
  }));
  const runtime: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand) => (await clipboard(command)) as RuntimeReply<T>,
    subscribe: () => () => {},
  };
  const invoke = vi.fn(async (command: RemoteCommand) => {
    if (command.type === 'host') {
      state.hosting = command.enabled;
    }
    if (command.type === 'invite')
      state.pairingCode = { code: pairingCode, expiresAt: Date.now() + 300000 };
    if (command.type === 'pair') state.pairedHost = state.hosts[0].identity.id;
    if (command.type === 'select') state.selected = command.host;
    return structuredClone(state);
  });
  const bridge: RemoteBridge = { invoke, subscribe: () => () => {} };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { remote: bridge, runtime },
  });
  return { state, invoke, pairingCode, clipboard };
}
it('opens a paired host workspace through an explicit device action', async () => {
  const f = fixture();
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  expect(screen.getByRole('dialog', { name: '远程电脑' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '打开工作区 Synthetic remote' }));
  await waitFor(() =>
    expect(f.invoke).toHaveBeenCalledWith({ type: 'select', host: 'b'.repeat(64) }),
  );
});
it('keeps adding a host separate from enabling remote control of this computer', async () => {
  const f = fixture();
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '连接另一台电脑' }));
  expect(screen.getByRole('textbox', { name: '配对码' })).toHaveFocus();
  await userEvent.type(screen.getByRole('textbox', { name: '配对码' }), f.pairingCode);
  await userEvent.click(screen.getByRole('button', { name: '连接' }));
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith({ type: 'pair', code: f.pairingCode }));
  expect(f.invoke.mock.calls.some(([command]) => command.type === 'host')).toBe(false);
  await waitFor(() =>
    expect(f.invoke).toHaveBeenCalledWith({ type: 'select', host: 'b'.repeat(64) }),
  );
});

it('reports unavailable pairing state while keeping the local workspace usable', async () => {
  const f = fixture();
  f.invoke.mockRejectedValue(Error('REMOTE_STORE_UNAVAILABLE'));
  render(
    <RemoteProvider>
      <RemoteButton />
      <p>Synthetic local workspace</p>
    </RemoteProvider>,
  );
  expect(await screen.findByRole('status')).toHaveTextContent('远程电脑暂不可用');
  expect(screen.getByText('Synthetic local workspace')).toBeVisible();
});

it('shows a six-digit code and only copies it on an explicit copy action', async () => {
  const f = fixture();
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '允许连接本机' }));
  await userEvent.click(screen.getByRole('button', { name: '开启并生成配对码' }));
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith({ type: 'host', enabled: true }));
  expect(f.invoke).toHaveBeenCalledWith({ type: 'invite' });
  expect(await screen.findByLabelText('配对码')).toHaveTextContent('123 456');
  expect(f.clipboard).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '复制配对码' }));
  expect(f.clipboard).toHaveBeenCalledWith({ type: 'clipboard.write', text: f.pairingCode });
  expect(screen.getByText('已复制配对码')).toBeVisible();
  expect(screen.getByText('设备与授权').closest('details')).not.toHaveAttribute('open');
});

it('does not navigate on a late pairing approval after the dialog is closed', async () => {
  const f = fixture();
  let approve = () => {};
  const pending = new Promise<undefined>((resolve) => {
    approve = () => resolve(undefined);
  });
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'pair') {
      await pending;
      f.state.pairedHost = f.state.hosts[0].identity.id;
    }
    return structuredClone(f.state);
  });
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '连接另一台电脑' }));
  await userEvent.type(screen.getByRole('textbox', { name: '配对码' }), f.pairingCode);
  await userEvent.click(screen.getByRole('button', { name: '连接' }));
  await userEvent.keyboard('{Escape}');
  await act(async () => {
    approve();
    await pending;
  });
  expect(f.invoke.mock.calls.some(([command]) => command.type === 'select')).toBe(false);
});

it('requires six digits before making a pairing request', async () => {
  const f = fixture();
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '连接另一台电脑' }));
  await userEvent.type(screen.getByRole('textbox', { name: '配对码' }), '12345');
  expect(screen.getByRole('button', { name: '连接' })).toBeDisabled();
  expect(f.invoke.mock.calls.some(([command]) => command.type === 'pair')).toBe(false);
});
it('preserves a bounded refusal code wrapped by Electron IPC', async () => {
  const f = fixture();
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'pair')
      throw Error("Error invoking remote method 'daban:remote': Error: REMOTE_PAIR_REFUSED");
    return structuredClone(f.state);
  });
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '连接另一台电脑' }));
  await userEvent.type(screen.getByRole('textbox', { name: '配对码' }), f.pairingCode);
  await userEvent.click(screen.getByRole('button', { name: '连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('拒绝');
});
it.each([
  ['REMOTE_DISCOVERY_EMPTY', '没有发现已开启接入的电脑'],
  ['REMOTE_CODE_UNREACHABLE', '发现了电脑，但连接不到接入服务'],
])('explains the failed pairing stage for %s', async (code, message) => {
  const f = fixture();
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'pair') throw Error(code);
    return structuredClone(f.state);
  });
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '连接另一台电脑' }));
  await userEvent.type(screen.getByRole('textbox', { name: '配对码' }), f.pairingCode);
  await userEvent.click(screen.getByRole('button', { name: '连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
});
it('reports a local service startup failure without blaming the other computer network', async () => {
  const f = fixture();
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'host') throw TypeError('SYNTHETIC SERVICE STARTUP FAILURE');
    return structuredClone(f.state);
  });
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '允许连接本机' }));
  await userEvent.click(screen.getByRole('button', { name: '开启并生成配对码' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无法开启本机接入');
});
