import {
  disconnected,
  type LocalComputerSession,
  type RemoteBridge,
  type RemoteState,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteProvider } from '../../app/Remote';
import { RuntimeProvider } from '../../app/Runtime';
import { NativeDesktop } from './NativeDesktop';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
it('sends human input with a fresh native observation and the captured remote Host', async () => {
  const host = 'a'.repeat(64);
  const session: LocalComputerSession = {
    id: 'synthetic-desktop',
    bot: 'synthetic-bot',
    revision: 2,
    owner: 'human',
    model: 'synthetic-model',
    modelRevision: 1,
  };
  let observation = 0;
  const frame = () => ({
    session: session.id,
    observation: `synthetic-observation-${++observation}`,
    bot: session.bot,
    runId: 'human',
    width: 800,
    height: 600,
    image: 'data:image/jpeg;base64,AA==',
  });
  const invoke = vi.fn(async (command: RuntimeCommand, _target?: string | null) => ({
    ok: true as const,
    value: command.type === 'status' ? disconnected('ready') : frame(),
  }));
  const remoteState: RemoteState = {
    selected: host,
    identity: { id: 'b'.repeat(64), publicKey: 'B'.repeat(59), name: 'Synthetic controller' },
    hosting: false,
    server: '',
    hosts: [],
    pending: [],
  };
  const remote: RemoteBridge = { invoke: async () => remoteState, subscribe: () => () => {} };
  const runtime: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand, target?: string | null) => {
      const result = await invoke(command, target);
      return result as RuntimeReply<T>;
    },
    subscribe: () => () => {},
  };
  Object.defineProperty(window, 'daban', { configurable: true, value: { remote, runtime } });
  render(
    <RemoteProvider>
      <RuntimeProvider host={host}>
        <NativeDesktop
          session={session}
          name="Synthetic native"
          platform="darwin"
          notify={vi.fn()}
        />
      </RuntimeProvider>
    </RemoteProvider>,
  );
  const input = await screen.findByRole('textbox', { name: '向远程电脑发送文字' });
  await waitFor(() => expect(input).toBeEnabled());
  await userEvent.type(input, 'SYNTHETIC HUMAN');
  await userEvent.click(screen.getByRole('button', { name: '向远程电脑发送文字' }));
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([command, target]) =>
          command.type === 'local.input' &&
          command.session === session.id &&
          command.revision === 2 &&
          command.input.type === 'text' &&
          command.input.text === 'SYNTHETIC HUMAN' &&
          target === host,
      ),
    ).toBe(true),
  );
});
