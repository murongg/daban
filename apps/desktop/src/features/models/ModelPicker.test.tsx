import {
  type BotProfile,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { selectControl, selectOption } from '../../test/select.fixture';
import { ModelPicker } from './ModelPicker';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const bot: Bot = {
  id: 'synthetic-bot',
  name: 'Synthetic Bot',
  role: 'Synthetic role',
  color: 'mint',
  preview: '',
  time: '',
};
function connect() {
  let profile: BotProfile = {
    id: bot.id,
    name: bot.name,
    instructions: bot.role,
    color: bot.color,
    memory: 'Synthetic memory',
    revision: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 39;
  snapshot.model = {
    configured: true,
    available: true,
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    revision: 1,
  };
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'bot.register') return { ok: true, value: profile };
    if (command.type === 'bot.update') {
      if (command.revision !== profile.revision)
        return { ok: false, error: 'BOT_PROFILE_CONFLICT' };
      const model = command.patch.model;
      profile = { ...profile, revision: profile.revision + 1 };
      if (model === null) delete profile.model;
      else if (model !== undefined) profile.model = model;
      return { ok: true, value: profile };
    }
    return { ok: true, value: snapshot };
  });
  const bridge: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand): Promise<RuntimeReply<T>> => {
      const reply = await invoke(command);
      return reply as RuntimeReply<T>;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.defineProperty(window, 'daban', { configurable: true, value: { runtime: bridge } });
  return {
    invoke,
    current: () => profile,
    conflict() {
      profile = {
        ...profile,
        name: 'Changed elsewhere',
        memory: 'New synthetic memory',
        revision: 3,
      };
    },
    offline() {
      snapshot = disconnected('offline');
      act(() => {
        for (const listener of listeners) listener(snapshot);
      });
    },
  };
}
function mount(version: number | undefined = 2) {
  const dispatch = vi.fn(),
    close = vi.fn(),
    notify = vi.fn();
  const view = render(
    <RuntimeProvider>
      <ModelPicker
        bot={bot}
        memory="Synthetic memory"
        version={version}
        dispatch={dispatch}
        close={close}
        notify={notify}
      />
    </RuntimeProvider>,
  );
  return { ...view, dispatch, close, notify };
}

it('offers only model settings and saves a model-only patch after registering the Bot', async () => {
  const backend = connect();
  const view = mount();
  await vi.waitFor(() => expect(selectControl('此 Bot 的模型')).toBeEnabled());
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await selectOption(userEvent, selectControl('此 Bot 的模型'), 'deepseek-v4-pro');
  await userEvent.click(screen.getByRole('button', { name: '保存模型' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'bot.update',
    bot: bot.id,
    revision: 2,
    patch: { model: 'deepseek-v4-pro' },
  });
  expect(backend.current()).toMatchObject({
    name: bot.name,
    instructions: bot.role,
    memory: 'Synthetic memory',
  });
  expect(view.close).toHaveBeenCalledOnce();
});

it('retains the selected model through a conflict and retries only after explicit review', async () => {
  const backend = connect();
  mount();
  await vi.waitFor(() => expect(selectControl('此 Bot 的模型')).toBeEnabled());
  await selectOption(userEvent, selectControl('此 Bot 的模型'), 'deepseek-v4-pro');
  backend.conflict();
  await userEvent.click(screen.getByRole('button', { name: '保存模型' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(selectControl('此 Bot 的模型')).toHaveAttribute('data-value', 'deepseek-v4-pro');
  expect(screen.getByRole('button', { name: '保存模型' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '保留编辑，按此版本重试' }));
  await userEvent.click(screen.getByRole('button', { name: '保存模型' }));
  expect(backend.current()).toMatchObject({
    name: 'Changed elsewhere',
    memory: 'New synthetic memory',
    model: 'deepseek-v4-pro',
  });
});

it('disables model saving while offline and ignores late UI completion after closing', async () => {
  const backend = connect();
  const view = mount();
  await vi.waitFor(() => expect(selectControl('此 Bot 的模型')).toBeEnabled());
  await selectOption(userEvent, selectControl('此 Bot 的模型'), 'deepseek-v4-pro');
  let finish: ((reply: RuntimeReply) => unknown) | undefined;
  const reply = new Promise<RuntimeReply>((resolve) => {
    finish = resolve;
  });
  const invoke = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation((command) =>
    command.type === 'bot.update' ? reply : invoke(command),
  );
  await userEvent.click(screen.getByRole('button', { name: '保存模型' }));
  expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
  view.unmount();
  await act(async () => {
    finish!({ ok: true, value: { ...backend.current(), model: 'deepseek-v4-pro', revision: 3 } });
    await reply;
  });
  expect(view.close).not.toHaveBeenCalled();
  expect(view.notify).not.toHaveBeenCalled();
  const next = mount();
  await vi.waitFor(() => expect(selectControl('此 Bot 的模型')).toBeEnabled());
  backend.offline();
  expect(screen.getByRole('button', { name: '保存模型' })).toBeDisabled();
  next.unmount();
});
