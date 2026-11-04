import type { RemoteBridge, RemoteCommand, RemoteState } from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
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
        server: 'https://connect.example.test',
        workspace: 'synthetic-workspace',
        platform: 'linux',
        state: 'offline',
        transport: 'unknown',
      },
    ],
  };
  const invoke = vi.fn(async (command: RemoteCommand) => {
    if (command.type === 'select') state.selected = command.host;
    return structuredClone(state);
  });
  const bridge: RemoteBridge = { invoke, subscribe: () => () => {} };
  Object.defineProperty(window, 'daban', { configurable: true, value: { remote: bridge } });
  return { state, invoke };
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
  const invitation = 'daban://pair#synthetic-invitation';
  await userEvent.type(screen.getByRole('textbox', { name: '邀请链接' }), invitation);
  await userEvent.click(screen.getByRole('button', { name: '请求配对' }));
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith({ type: 'pair', invitation }));
  expect(f.invoke.mock.calls.some(([command]) => command.type === 'host')).toBe(false);
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
