import {
  type BotProfile,
  disconnected,
  type MemoryPage,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useReducer } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { demoState as initialState } from './fixtures';
import { RuntimeProvider, useRuntime } from './Runtime';
import { reduce } from './state';
import { Workspace } from './Workspace';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function connect(protocol = 32) {
  const profiles = new Map<string, BotProfile>(
    ['a', 'b'].map((id) => [
      id,
      {
        id,
        name: `合成${id}`,
        instructions: '',
        color: 'mint',
        memory: `SYNTHETIC CURRENT ${id}`,
        revision: 8,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]),
  );
  const pages = (bot: string, before?: number): MemoryPage => ({
    bot,
    profileRevision: profiles.get(bot)!.revision,
    currentRevision: profiles.get(bot)!.revision,
    limited: true,
    ...(before ? {} : { nextBefore: profiles.get(bot)!.revision - 4 }),
    items: Array.from(
      { length: before ? Math.min(5, before - 1) : 5 },
      (_, index) => (before ?? profiles.get(bot)!.revision + 1) - index - 1,
    ).map((revision) => ({
      revision,
      content:
        revision === profiles.get(bot)!.revision
          ? profiles.get(bot)!.memory
          : `SYNTHETIC OLD ${bot} ${revision}`,
      source: revision === profiles.get(bot)!.revision ? 'agent' : 'edit',
      createdAt: '2026-01-01T00:00:00Z',
    })),
  });
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.profiles = [...profiles.values()];
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const publish = () => {
    snapshot.profiles = [...profiles.values()];
    for (const listener of listeners) listener({ ...snapshot });
  };
  let delayed: Promise<MemoryPage> | undefined;
  let failing = false;
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status') return { ok: true, value: { ...snapshot } };
    if (command.type === 'memory.history' && failing)
      return { ok: false, error: 'MEMORY_HISTORY_CORRUPT' };
    if (command.type === 'memory.history')
      return {
        ok: true,
        value: delayed ? await delayed : pages(command.bot, command.query.before),
      };
    if (command.type === 'bot.register')
      return { ok: true, value: profiles.get(command.profile.id) };
    if (command.type === 'bot.update') {
      const current = profiles.get(command.bot)!;
      if (command.revision !== current.revision)
        return { ok: false, error: 'BOT_PROFILE_CONFLICT' };
      const next = {
        ...current,
        memory: command.patch.memory ?? current.memory,
        revision: current.revision + 1,
      };
      profiles.set(next.id, next);
      publish();
      return { ok: true, value: next };
    }
    throw new Error('UNEXPECTED SYNTHETIC COMMAND');
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  return {
    invoke,
    profiles,
    pages,
    fail: () => {
      failing = true;
    },
    delay: (value: Promise<MemoryPage>) => {
      delayed = value;
    },
    advance: (patch: Partial<BotProfile>) => {
      profiles.set('a', {
        ...profiles.get('a')!,
        ...patch,
        revision: profiles.get('a')!.revision + 1,
      });
      act(publish);
    },
  };
}
function Harness({ target = 'research' }: { target?: string }) {
  const runtime = useRuntime();
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    const state = initialState();
    state.panel = 'memory';
    for (const id of ['research', 'writer']) state.memoryDrafts[id] = state.memories[id] = '';
    state.drafts.research = 'SYNTHETIC CHAT DRAFT';
    return state;
  });
  useEffect(
    () => dispatch({ type: 'profiles', profiles: runtime.snapshot.profiles }),
    [runtime.snapshot.profiles],
  );
  useEffect(() => dispatch({ type: 'select', bot: target }), [target]);
  return (
    <main id="root">
      <Workspace
        state={state}
        bot={state.bots.find((bot) => bot.id === state.selected)!}
        dispatch={dispatch}
        notify={() => {}}
        preview={() => {}}
        expand={() => {}}
      />
      <output aria-label="合成聊天草稿">{state.drafts.research}</output>
    </main>
  );
}
const view = (target = 'research') => (
  <RuntimeProvider>
    <Harness target={target} />
  </RuntimeProvider>
);
it('reads complete pages, stages a selected preference without mutation and saves through the existing current revision', async () => {
  const backend = connect();
  const user = userEvent.setup();
  render(view());
  await user.click(await screen.findByRole('button', { name: '历史版本' }));
  const dialog = await screen.findByRole('dialog', { name: '工作偏好历史' });
  await user.click(await within(dialog).findByRole('button', { name: /版本 7/ }));
  expect(within(dialog).getByLabelText('历史工作偏好')).toHaveValue('SYNTHETIC OLD a 7');
  await user.click(within(dialog).getByRole('button', { name: '载入编辑器' }));
  expect(screen.getByLabelText('工作偏好')).toHaveValue('SYNTHETIC OLD a 7');
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'bot.update')).toBe(false);
  expect(backend.profiles.get('a')!.memory).toBe('SYNTHETIC CURRENT a');
  expect(screen.getByLabelText('合成聊天草稿')).toHaveTextContent('SYNTHETIC CHAT DRAFT');
  await user.click(screen.getByRole('button', { name: '保存记忆' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'bot.update',
    bot: 'a',
    revision: 8,
    patch: { memory: 'SYNTHETIC OLD a 7' },
  });
  expect(backend.profiles.get('b')!.memory).toBe('SYNTHETIC CURRENT b');
});
it('protects unsaved drafts while allowing history paging, selection and keyboard dismissal', async () => {
  connect();
  const user = userEvent.setup();
  render(view());
  const memory = await screen.findByDisplayValue('SYNTHETIC CURRENT a');
  await user.clear(memory);
  await user.type(memory, 'SYNTHETIC UNSAVED PREF');
  const trigger = screen.getByRole('button', { name: '历史版本' });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog');
  await user.click(await within(dialog).findByRole('button', { name: '较早版本' }));
  await user.click(await within(dialog).findByRole('button', { name: /版本 2/ }));
  expect(within(dialog).getByLabelText('历史工作偏好')).toHaveValue('SYNTHETIC OLD a 2');
  expect(within(dialog).getByRole('button', { name: '载入编辑器' })).toBeDisabled();
  expect(within(dialog).getByText(/先保存或还原编辑器中的草稿/)).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(memory).toHaveValue('SYNTHETIC UNSAVED PREF');
  expect(trigger).toHaveFocus();
});
it('does not stage against changed or archived profiles and preserves a staged draft when a later save conflicts', async () => {
  const backend = connect();
  const user = userEvent.setup();
  render(view());
  await user.click(await screen.findByRole('button', { name: '历史版本' }));
  await user.click(await screen.findByRole('button', { name: /版本 7/ }));
  backend.advance({ memory: 'SYNTHETIC BACKGROUND UPDATE' });
  expect(screen.getByRole('button', { name: '载入编辑器' })).toBeDisabled();
  expect(screen.getByText(/当前偏好已更新/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '刷新最近版本' }));
  await user.click(await screen.findByRole('button', { name: /版本 7/ }));
  await user.click(screen.getByRole('button', { name: '载入编辑器' }));
  backend.advance({ memory: 'SYNTHETIC LATER UPDATE' });
  await user.click(screen.getByRole('button', { name: '保存记忆' }));
  expect(await screen.findByRole('button', { name: '保留草稿，按此版本重试' })).toBeVisible();
  expect(screen.getByLabelText('工作偏好')).toHaveValue('SYNTHETIC OLD a 7');
  expect(backend.profiles.get('a')!.memory).toBe('SYNTHETIC LATER UPDATE');
});
it('ignores late history after switching Bot and keeps old runtimes read-only for this feature', async () => {
  const backend = connect();
  const user = userEvent.setup();
  let finish!: (page: MemoryPage) => unknown;
  backend.delay(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const rendered = render(view());
  await user.click(await screen.findByRole('button', { name: '历史版本' }));
  rendered.rerender(view('writer'));
  await act(async () => {
    finish(backend.pages('a'));
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByLabelText('工作偏好')).toHaveValue('SYNTHETIC CURRENT b');
  rendered.unmount();
  connect(31);
  render(view());
  expect(await screen.findByRole('button', { name: '历史版本' })).toBeDisabled();
});
it('keeps history readable but cannot stage while the Bot lifecycle is changing', async () => {
  const backend = connect();
  const user = userEvent.setup();
  render(view());
  await user.click(await screen.findByRole('button', { name: '历史版本' }));
  await user.click(await screen.findByRole('button', { name: /版本 7/ }));
  backend.advance({
    archived: true,
    lifecycle: { id: 'mock-archive', action: 'archive', baseRevision: 8, phase: 'pending' },
  });
  expect(screen.getByRole('button', { name: '载入编辑器' })).toBeDisabled();
  expect(screen.getByText(/当前只能查看历史/)).toBeVisible();
});
it('does not stage a retained page after a failed refresh', async () => {
  const backend = connect();
  const user = userEvent.setup();
  render(view());
  await user.click(await screen.findByRole('button', { name: '历史版本' }));
  await user.click(await screen.findByRole('button', { name: /版本 7/ }));
  backend.fail();
  await user.click(screen.getByRole('button', { name: '刷新最近版本' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('当前内容已保留');
  expect(screen.getByRole('button', { name: '载入编辑器' })).toBeDisabled();
});
it('does not silently adopt a newer profile revision by paging into older history', async () => {
  const backend = connect();
  const user = userEvent.setup();
  render(view());
  await user.click(await screen.findByRole('button', { name: '历史版本' }));
  await screen.findByRole('button', { name: /版本 7/ });
  backend.advance({ memory: 'SYNTHETIC NEW HEAD WHILE READING' });
  await user.click(screen.getByRole('button', { name: '较早版本' }));
  await user.click(await screen.findByRole('button', { name: /版本 2/ }));
  expect(screen.getByRole('button', { name: '载入编辑器' })).toBeDisabled();
  expect(screen.getByText(/当前偏好已更新/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '刷新最近版本' }));
  await user.click(await screen.findByRole('button', { name: '较早版本' }));
  await user.click(await screen.findByRole('button', { name: /版本 2/ }));
  expect(screen.getByRole('button', { name: '载入编辑器' })).toBeEnabled();
  expect(backend.profiles.get('a')!.memory).toBe('SYNTHETIC NEW HEAD WHILE READING');
});
