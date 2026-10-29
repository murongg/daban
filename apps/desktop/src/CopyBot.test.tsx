import {
  agentId,
  type BotCopyRequest,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { initialState } from './state';
import { restore, serialize, storageKey } from './storage';

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'daban');
});
const request: BotCopyRequest = {
  id: 'mock-copy-resume',
  bot: 'a',
  revision: 1,
  name: '合成已提交副本',
  memory: true,
};
const result = (input: BotCopyRequest) => ({
  request: input,
  state: 'complete',
  profile: {
    id: input.id,
    name: input.name,
    instructions: 'MOCK-ROLE',
    memory: input.memory ? 'MOCK-PREFERENCE' : '',
    color: 'violet',
    model: 'deepseek-v4-pro',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
});

function connect(protocol = 34, pending = false) {
  const seed = initialState();
  seed.panel = null;
  seed.drafts.research = 'MOCK-SOURCE-DRAFT';
  if (pending) seed.botCopy = request;
  localStorage.setItem(storageKey, serialize(seed));
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.profiles = seed.bots
    .filter((bot) => !bot.members)
    .map((bot) => ({
      id: agentId(bot.id),
      name: bot.name,
      instructions: bot.id === 'research' ? 'MOCK-ROLE' : bot.role,
      memory: bot.id === 'research' ? 'MOCK-PREFERENCE' : '',
      color: bot.color,
      revision: 1,
      ...(bot.id === 'research' ? { model: 'deepseek-v4-pro' as const } : {}),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
  const copy = vi.fn<(input: BotCopyRequest) => Promise<unknown>>(async (input) => result(input));
  const read = vi.fn<(input: BotCopyRequest) => Promise<unknown>>(async (input) => ({
    request: input,
    state: 'unknown',
  }));
  const calls: RuntimeCommand[] = [];
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const bridge: RuntimeBridge = {
    async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
      calls.push(command);
      if (command.type === 'status') return { ok: true, value: snapshot as T };
      if (command.type === 'bot.copy')
        return { ok: true, value: (await copy(command.request)) as T };
      if (command.type === 'bot.copy.receipt')
        return { ok: true, value: (await read(command.request)) as T };
      return { ok: false, error: 'MOCK_UNEXPECTED_COMMAND' };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: bridge },
  });
  return {
    copy,
    read,
    calls,
    snapshot,
    publish: () => {
      for (const listener of listeners) listener({ ...snapshot });
    },
  };
}
async function openCopy() {
  await userEvent.click(screen.getByRole('button', { name: '整理 研究员' }));
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '复制 Bot' })).toBeEnabled());
  await userEvent.click(screen.getByRole('menuitem', { name: '复制 Bot' }));
  return screen.getByRole('dialog', { name: '复制 Bot' });
}

it('previews saved persona/model and creates an independent profile with only the selected preference', async () => {
  const fake = connect();
  render(<App />);
  const dialog = await openCopy();
  expect(within(dialog).getByRole('textbox', { name: '职责' })).toHaveValue('MOCK-ROLE');
  expect(within(dialog).getByText(/DeepSeek V4 Pro/)).toBeVisible();
  await userEvent.clear(within(dialog).getByRole('textbox', { name: '新 Bot 名称' }));
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: '新 Bot 名称' }),
    '合成复制结果',
  );
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '包含工作偏好' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  await waitFor(() => expect(fake.copy).toHaveBeenCalledTimes(1));
  const sent = fake.copy.mock.calls[0][0];
  expect(sent.bot).toBe('a');
  expect(sent.memory).toBe(false);
  expect(sent.name).toBe('合成复制结果');
  expect(await screen.findByRole('heading', { name: '合成复制结果' })).toBeVisible();
  const saved = restore(localStorage.getItem(storageKey));
  expect(saved.bots.some((bot) => bot.id === sent.id)).toBe(true);
  expect(saved.memories[sent.id]).toBe('');
  expect(saved.drafts.research).toBe('MOCK-SOURCE-DRAFT');
  expect(saved.botCopy).toBeUndefined();
  expect(
    fake.calls.every((command) =>
      ['status', 'bot.copy', 'bot.copy.receipt'].includes(command.type),
    ),
  ).toBe(true);
});

it('does not register a placeholder and keeps a late copy result from navigating away or clearing a newer draft', async () => {
  const fake = connect();
  let finish: ((value: unknown) => unknown) | undefined;
  fake.copy.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<App />);
  const dialog = await openCopy();
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  await waitFor(() => expect(fake.copy).toHaveBeenCalledTimes(1));
  const sent = fake.copy.mock.calls[0][0];
  expect(restore(localStorage.getItem(storageKey)).bots.some((bot) => bot.id === sent.id)).toBe(
    false,
  );
  expect(restore(localStorage.getItem(storageKey)).botCopy).toEqual(sent);
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  await userEvent.click(
    within(screen.getByRole('navigation', { name: 'Bot 列表' })).getByRole('button', {
      name: '写作搭档',
    }),
  );
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'MOCK-NEWER-DRAFT');
  await act(() => finish!(result(sent)));
  expect(screen.getByRole('heading', { name: '写作搭档' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('MOCK-NEWER-DRAFT');
  expect(restore(localStorage.getItem(storageKey)).bots.some((bot) => bot.id === sent.id)).toBe(
    true,
  );
});

it('reconstructs a sealed request by reading receipts only and retries the same request only on explicit action', async () => {
  const fake = connect(34, true);
  render(<App />);
  await waitFor(() => expect(fake.read).toHaveBeenCalled());
  expect(fake.copy).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Bot 复制 · 核对进度' }));
  const dialog = screen.getByRole('dialog', { name: '复制 Bot' });
  expect(within(dialog).getByText('合成已提交副本')).toBeVisible();
  expect(within(dialog).queryByRole('textbox', { name: '新 Bot 名称' })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: '重试同一次复制' }));
  expect(fake.copy).toHaveBeenCalledWith(request);
  expect(await screen.findByRole('heading', { name: request.name })).toBeVisible();
});

it('does not offer a copy mutation on an old runtime', async () => {
  const fake = connect(33);
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: '整理 研究员' }));
  expect(screen.getByRole('menuitem', { name: '复制 Bot' })).toBeDisabled();
  expect(fake.copy).not.toHaveBeenCalled();
  expect(fake.read).not.toHaveBeenCalled();
});

it('keeps the exact request after a foreign acknowledgement and never replays it on reopen', async () => {
  const fake = connect();
  fake.copy.mockImplementation(async (input) => ({
    ...result(input),
    request: { ...input, memory: !input.memory },
  }));
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  const dialog = await openCopy();
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('alert')).toHaveTextContent('复制回执不匹配'),
  );
  const sent = fake.copy.mock.calls[0][0];
  expect(restore(localStorage.getItem(storageKey)).botCopy).toEqual(sent);
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  await userEvent.click(screen.getByRole('button', { name: 'Bot 复制 · 核对进度' }));
  expect(fake.copy).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('textbox', { name: '新 Bot 名称' })).not.toBeInTheDocument();
});

it('keeps the editor choices after a source conflict and refreshes only the saved source on explicit action', async () => {
  const fake = connect();
  fake.copy.mockRejectedValueOnce(new Error('BOT_PROFILE_CONFLICT'));
  render(<App />);
  const dialog = await openCopy();
  await userEvent.clear(within(dialog).getByRole('textbox', { name: '新 Bot 名称' }));
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: '新 Bot 名称' }),
    '合成保留名称',
  );
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '包含工作偏好' }));
  const source = fake.snapshot.profiles.find((profile) => profile.id === 'a')!;
  source.revision = 2;
  source.instructions = 'MOCK-UPDATED-ROLE';
  await act(() => fake.publish());
  expect(within(dialog).getByRole('textbox', { name: '职责' })).toHaveValue('MOCK-ROLE');
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('资料已更新'));
  expect(fake.copy.mock.calls[0][0].revision).toBe(1);
  expect(within(dialog).getByRole('textbox', { name: '新 Bot 名称' })).toHaveValue('合成保留名称');
  expect(within(dialog).getByRole('checkbox', { name: '包含工作偏好' })).not.toBeChecked();
  expect(restore(localStorage.getItem(storageKey)).botCopy).toBeUndefined();
  await userEvent.click(within(dialog).getByRole('button', { name: '载入最新来源' }));
  expect(within(dialog).getByRole('textbox', { name: '职责' })).toHaveValue('MOCK-UPDATED-ROLE');
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  expect(fake.copy.mock.calls[1][0]).toMatchObject({
    name: '合成保留名称',
    memory: false,
    revision: 2,
  });
});

it('settles a confirmed receipt while the original response is delayed, then ignores that response during a newer operation', async () => {
  const fake = connect();
  let first: ((value: unknown) => unknown) | undefined;
  fake.copy.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        first = resolve;
      }),
  );
  fake.copy.mockImplementationOnce(() => new Promise(() => {}));
  render(<App />);
  const dialog = await openCopy();
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  const sent = fake.copy.mock.calls[0][0];
  fake.read.mockImplementation(async (input) => result(input));
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: '核对复制结果' })).toBeEnabled(),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '核对复制结果' }));
  await screen.findByRole('heading', { name: sent.name });
  fake.read.mockImplementation(async (input) => ({ request: input, state: 'unknown' }));
  const next = await openCopy();
  expect(within(next).getByRole('button', { name: '创建副本' })).toBeEnabled();
  await userEvent.click(within(next).getByRole('button', { name: '创建副本' }));
  const newer = fake.copy.mock.calls[1][0];
  await act(() => first!(result(sent)));
  expect(screen.getByRole('dialog', { name: '复制 Bot' })).toBeVisible();
  expect(restore(localStorage.getItem(storageKey)).botCopy).toEqual(newer);
});

it('does not create when the sealed request cannot be saved locally', async () => {
  const fake = connect();
  render(<App />);
  const dialog = await openCopy();
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('MOCK_FULL');
  });
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  expect(fake.copy).not.toHaveBeenCalled();
  expect(within(dialog).getByRole('alert')).toHaveTextContent('无法保存复制请求');
  expect(within(dialog).getByRole('textbox', { name: '新 Bot 名称' })).toBeVisible();
  save.mockRestore();
});

it('retains the source identity when a reconstructed request is rejected and the editor becomes editable', async () => {
  const fake = connect(34, true);
  fake.copy.mockRejectedValueOnce(new Error('BOT_PROFILE_CONFLICT'));
  render(<App />);
  await screen.findByRole('button', { name: 'Bot 复制 · 核对进度' });
  await userEvent.click(screen.getByRole('button', { name: 'Bot 复制 · 核对进度' }));
  const dialog = screen.getByRole('dialog', { name: '复制 Bot' });
  await userEvent.click(within(dialog).getByRole('button', { name: '重试同一次复制' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('textbox', { name: '新 Bot 名称' })).toHaveValue(request.name),
  );
  expect(within(dialog).getByRole('button', { name: '载入最新来源' })).toBeEnabled();
});

it('keeps a previously submitted request when retry is refused by an older runtime command reader', async () => {
  const fake = connect(34, true);
  fake.copy.mockRejectedValueOnce(new Error('RUNTIME_TOO_OLD'));
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: 'Bot 复制 · 核对进度' }));
  const dialog = screen.getByRole('dialog', { name: '复制 Bot' });
  await userEvent.click(within(dialog).getByRole('button', { name: '重试同一次复制' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: '重试同一次复制' })).toBeEnabled(),
  );
  expect(restore(localStorage.getItem(storageKey)).botCopy).toEqual(request);
});

it('keeps first-attempt source rejection editable when no previous submission could have completed', async () => {
  const fake = connect();
  fake.copy.mockRejectedValueOnce(new Error('BOT_PROFILE_NOT_FOUND'));
  render(<App />);
  const dialog = await openCopy();
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('textbox', { name: '新 Bot 名称' })).toBeVisible(),
  );
  expect(restore(localStorage.getItem(storageKey)).botCopy).toBeUndefined();
});
