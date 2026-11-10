import {
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { demoState } from '../../test/fixtures';
import { LocalComputer } from './LocalComputer';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function fixture(permissions = true, platform: 'darwin' | 'win32' = 'darwin') {
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
    platform,
    available: true,
    permissions: { screen: permissions, accessibility: permissions },
    shortcut: true,
  };
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'local.status') {
      for (const listener of listeners) listener(snapshot);
      return { ok: true, value: snapshot.localComputer };
    }
    if (command.type === 'local.windows')
      return { ok: true, value: [{ id: '11:22', name: '合成窗口' }] };
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
      platform,
      runtime: {
        invoke,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as RuntimeBridge,
    },
  });
  return {
    invoke,
    permissions: (screen: boolean, accessibility: boolean, publish = true) => {
      snapshot = {
        ...snapshot,
        localComputer: { ...snapshot.localComputer!, permissions: { screen, accessibility } },
      };
      if (publish) for (const listener of listeners) listener(snapshot);
    },
  };
}
it.each(['darwin', 'win32'] as const)(
  'requires concrete screen-sharing consent on %s',
  async (platform) => {
    const backend = fixture(true, platform);
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
    const allow = within(dialog).getByRole('button', { name: '允许操作本机' });
    expect(allow).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: /操作范围/ }));
    await userEvent.click(await screen.findByRole('option', { name: '合成窗口' }));
    expect(
      within(dialog).getByText(platform === 'darwin' ? /只观察和操作/ : /只观察和点击/),
    ).toBeVisible();
    await userEvent.click(allow);
    expect(await screen.findByRole('button', { name: '断开本机' })).toBeVisible();
    expect(
      backend.invoke.mock.calls.find(([command]) => command.type === 'local.connect')?.[0],
    ).toMatchObject({
      type: 'local.connect',
      bot: 'a',
      model: 'provider:mock-provider:mock-vision',
      modelRevision: 1,
      window: '11:22',
    });
  },
);
it('guides each missing permission from live status without granting host control', async () => {
  const backend = fixture(false);
  render(
    <RuntimeProvider>
      <LocalComputer bot={demoState().bots.find((bot) => bot.id === 'research')!} />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('button', { name: '连接本机' })).toBeDisabled();
  const guide = screen.getByRole('region', { name: '设置本机权限' });
  expect(within(guide).getByText(/允许 Daban 点击和输入/)).toBeVisible();
  expect(within(guide).getByText(/允许 Daban 查看屏幕画面/)).toBeVisible();
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'local.permissions')).toBe(
    false,
  );
  await userEvent.click(within(guide).getByRole('button', { name: '开启辅助功能' }));
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'local.permissions')).toBe(
    true,
  );
  act(() => backend.permissions(false, true));
  expect(within(guide).getByRole('button', { name: '开启屏幕录制' })).toBeEnabled();
  expect(within(guide).queryByRole('button', { name: '开启辅助功能' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '连接本机' })).toBeDisabled();
  await userEvent.click(within(guide).getByRole('button', { name: '开启屏幕录制' }));
  act(() => backend.permissions(true, true));
  expect(screen.getByRole('button', { name: '连接本机' })).toBeEnabled();
  expect(screen.getByRole('status')).toHaveTextContent('系统权限已就绪');
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'local.connect')).toBe(
    false,
  );
});

it('rechecks current permissions without opening System Settings or starting a session', async () => {
  const backend = fixture(false);
  render(
    <RuntimeProvider>
      <LocalComputer bot={demoState().bots.find((bot) => bot.id === 'research')!} />
    </RuntimeProvider>,
  );
  await screen.findByRole('button', { name: '开启辅助功能' });
  backend.permissions(true, true, false);
  await userEvent.click(screen.getByRole('button', { name: '重新检查权限' }));
  expect(await screen.findByRole('button', { name: '连接本机' })).toBeEnabled();
  expect(
    backend.invoke.mock.calls.some(([command]) =>
      ['local.permissions', 'local.connect'].includes(command.type),
    ),
  ).toBe(false);
});

it('preserves the guide and connection lock when checking permissions fails', async () => {
  const backend = fixture(false);
  render(
    <RuntimeProvider>
      <LocalComputer bot={demoState().bots.find((bot) => bot.id === 'research')!} />
    </RuntimeProvider>,
  );
  await screen.findByRole('button', { name: '开启辅助功能' });
  backend.invoke.mockImplementationOnce(async () => ({ ok: false, error: 'RUNTIME_OFFLINE' }));
  await userEvent.click(screen.getByRole('button', { name: '重新检查权限' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByRole('button', { name: '连接本机' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '开启辅助功能' })).toBeEnabled();
});

it('refreshes permissions on returning to the app without requesting additional access', async () => {
  const backend = fixture(false);
  // Flush the initial snapshot and its effects before simulating a return to the window.
  const mounted = await act(async () =>
    render(
      <RuntimeProvider>
        <LocalComputer bot={demoState().bots.find((bot) => bot.id === 'research')!} />
      </RuntimeProvider>,
    ),
  );
  await screen.findByRole('button', { name: '开启辅助功能' });
  backend.permissions(true, true, false);
  fireEvent.focus(window);
  expect(await screen.findByRole('status')).toHaveTextContent('系统权限已就绪');
  expect(backend.invoke).toHaveBeenCalledWith({ type: 'local.status' });
  expect(screen.getByRole('button', { name: '连接本机' })).toBeEnabled();
  expect(
    backend.invoke.mock.calls.some(([command]) =>
      ['local.permissions', 'local.connect'].includes(command.type),
    ),
  ).toBe(false);
  mounted.unmount();
  backend.invoke.mockClear();
  fireEvent.focus(window);
  expect(backend.invoke).not.toHaveBeenCalled();
});

it('only offers the accessibility step if screen recording is already allowed', async () => {
  const backend = fixture(false);
  backend.permissions(true, false, false);
  render(
    <RuntimeProvider>
      <LocalComputer bot={demoState().bots.find((bot) => bot.id === 'research')!} />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('button', { name: '开启辅助功能' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '开启屏幕录制' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '连接本机' })).toBeDisabled();
});
