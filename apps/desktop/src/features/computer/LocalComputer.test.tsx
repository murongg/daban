import {
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { demoState } from '../../test/fixtures';
import { LocalComputer } from './LocalComputer';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function fixture(permissions = true) {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 39;
  snapshot.model = {
    configured: true,
    available: true,
    provider: 'mock-provider',
    model: 'provider:mock-provider:mock-vision',
    revision: 1,
    connections: [
      {
        id: 'mock-provider',
        name: '合成供应商',
        baseURL: 'https://model.example.test/v1',
        models: [
          {
            id: 'mock-vision',
            name: '合成视觉模型',
            vision: true,
            contextWindow: 10000,
            maxTokens: 1000,
          },
        ],
      },
    ],
  };
  snapshot.localComputer = {
    platform: 'darwin',
    available: true,
    permissions: { screen: permissions, accessibility: permissions },
    shortcut: true,
  };
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'local.connect') {
      snapshot = {
        ...snapshot,
        localComputer: {
          ...snapshot.localComputer!,
          session: {
            id: 'mock-session',
            bot: command.bot,
            revision: 1,
            owner: 'agent',
            model: command.model,
            modelRevision: command.modelRevision,
          },
        },
      };
      for (const listener of listeners) listener(snapshot);
      return { ok: true, value: snapshot.localComputer };
    }
    return { ok: true, value: command.type === 'status' ? snapshot : undefined };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as RuntimeBridge,
    },
  });
  return { invoke };
}
it('requires a concrete screen-sharing consent before connecting the selected Bot', async () => {
  const backend = fixture();
  render(
    <RuntimeProvider>
      <LocalComputer bot={demoState().bots.find((bot) => bot.id === 'research')!} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '连接本机' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/合成供应商/)).toBeVisible();
  expect(within(dialog).getByText(/合成视觉模型/)).toBeVisible();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'local.connect')).toBe(
    false,
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '允许操作本机' }));
  expect(await screen.findByRole('button', { name: '断开本机' })).toBeVisible();
  expect(
    backend.invoke.mock.calls.find(([command]) => command.type === 'local.connect')?.[0],
  ).toMatchObject({
    type: 'local.connect',
    bot: 'a',
    model: 'provider:mock-provider:mock-vision',
    modelRevision: 1,
  });
});
it('does not grant host control when native OS permissions are absent', async () => {
  const backend = fixture(false);
  render(
    <RuntimeProvider>
      <LocalComputer bot={demoState().bots.find((bot) => bot.id === 'research')!} />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('button', { name: '连接本机' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '设置权限' }));
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'local.permissions')).toBe(
    true,
  );
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'local.connect')).toBe(
    false,
  );
});
