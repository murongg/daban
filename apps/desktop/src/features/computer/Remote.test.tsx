import {
  type RemoteBridge,
  type RemoteCommand,
  type RemoteState,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  remoteInvitation,
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
  const link = remoteInvitation({
    version: 2,
    host: state.hosts[0].identity,
    server: 'https://127.0.0.1:45678',
    certificate: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
    code: 'synthetic-pairing-secret-0123456789',
    expiresAt: Date.now() + 300000,
  });
  const hostLink = remoteInvitation({
    version: 2,
    host: state.identity,
    server: 'https://127.0.0.1:45678',
    certificate: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
    code: 'synthetic-host-secret-01234567890123',
    expiresAt: Date.now() + 300000,
  });
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
    if (command.type === 'invite') state.invitation = hostLink;
    if (command.type === 'select') state.selected = command.host;
    return structuredClone(state);
  });
  const bridge: RemoteBridge = { invoke, subscribe: () => () => {} };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { remote: bridge, runtime },
  });
  return { state, invoke, link, hostLink, clipboard };
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
  expect(screen.getByRole('textbox', { name: '连接链接' })).toHaveFocus();
  const invitation = f.link;
  await userEvent.type(screen.getByRole('textbox', { name: '连接链接' }), invitation);
  await userEvent.click(screen.getByRole('button', { name: '连接' }));
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith({ type: 'pair', invitation }));
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

it('enables LAN hosting and copies a link without asking for a service address', async () => {
  const f = fixture();
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '允许连接本机' }));
  await userEvent.click(screen.getByRole('button', { name: '开启并复制连接链接' }));
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith({ type: 'host', enabled: true }));
  expect(f.invoke).toHaveBeenCalledWith({ type: 'invite' });
  expect(f.clipboard).toHaveBeenCalledWith({ type: 'clipboard.write', text: f.hostLink });
  expect(screen.getByRole('status')).toHaveTextContent('已复制');
  expect(screen.getByText('设备与授权').closest('details')).not.toHaveAttribute('open');
});

it('does not navigate on a late pairing approval after the dialog is closed', async () => {
  const f = fixture();
  let approve = () => {};
  const pending = new Promise<undefined>((resolve) => {
    approve = () => resolve(undefined);
  });
  f.invoke.mockImplementation(async (command) => {
    if (command.type === 'pair') await pending;
    return structuredClone(f.state);
  });
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '连接另一台电脑' }));
  await userEvent.type(screen.getByRole('textbox', { name: '连接链接' }), f.link);
  await userEvent.click(screen.getByRole('button', { name: '连接' }));
  await userEvent.keyboard('{Escape}');
  await act(async () => {
    approve();
    await pending;
  });
  expect(f.invoke.mock.calls.some(([command]) => command.type === 'select')).toBe(false);
});

it('reports malformed links without making a pairing request', async () => {
  const f = fixture();
  render(
    <RemoteProvider>
      <RemoteButton />
    </RemoteProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '当前电脑：本机' }));
  await userEvent.click(screen.getByRole('button', { name: '连接另一台电脑' }));
  await userEvent.type(screen.getByRole('textbox', { name: '连接链接' }), 'synthetic invalid link');
  await userEvent.click(screen.getByRole('button', { name: '连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('链接无效');
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
  await userEvent.type(screen.getByRole('textbox', { name: '连接链接' }), f.link);
  await userEvent.click(screen.getByRole('button', { name: '连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('拒绝');
});
