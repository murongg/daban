import {
  type ComputerAck,
  type ComputerState,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Connection } from './Connection';
import { beginComputer, pendingComputer } from './connections';
import { RuntimeProvider } from './Runtime';

const bot = 'mock-connected-bot';
const connected: ComputerState = {
  bot,
  phase: 'connected',
  revision: 2,
  desired: true,
  reserved: true,
  instance: 'mock-native-before',
};
const idle = () => ({
  running: false,
  phase: 'idle' as const,
  prompt: '',
  result: '',
  error: '',
  files: [],
  toolCount: 0,
  executedCount: 0,
  trace: [],
  history: [],
});
function state(computer?: ComputerState) {
  const value = disconnected('ready');
  value.protocolVersion = 19;
  value.model.configured = true;
  value.computers = {
    available: true,
    revision: computer?.revision ?? 0,
    limit: 2,
    items: computer ? [computer] : [],
  };
  value.profiles = [
    {
      id: bot,
      name: '合成 Bot',
      instructions: '',
      memory: '',
      color: 'mint',
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  if (computer?.phase === 'connected')
    value.bots[bot] = { owner: 'agent', epoch: 1, instance: computer.instance, task: idle() };
  return value;
}
function bridge(
  initial: RuntimeSnapshot,
  action: (command: Extract<RuntimeCommand, { type: 'computer.action' }>) => Promise<ComputerAck>,
) {
  let snapshot = initial,
    publish: (value: RuntimeSnapshot) => unknown = () => {};
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'status') return { ok: true, value: snapshot };
    if (command.type === 'computer.action') return { ok: true, value: await action(command) };
    if (command.type === 'computer.receipt')
      return {
        ok: true,
        value: { receipt: { id: command.id, bot, phase: 'settled' }, state: connected },
      };
    throw new Error('unexpected synthetic command');
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown) => {
          publish = listener;
          return () => {};
        },
      } as unknown as RuntimeBridge,
    },
  });
  return {
    invoke,
    update: (value: RuntimeSnapshot) => {
      snapshot = value;
      publish(value);
    },
  };
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
  localStorage.clear();
});

it('connects an ordinary registered Bot only after an explicit click and clears the exact settled nonce', async () => {
  const mock = bridge(state(), async (command) => {
    mock.update(state(connected));
    return { receipt: { id: command.request.id, bot, phase: 'settled' }, state: connected };
  });
  render(
    <RuntimeProvider>
      <Connection bot={bot} name="合成 Bot" notify={vi.fn()} />
    </RuntimeProvider>,
  );
  const button = await screen.findByRole('button', { name: '连接电脑' });
  await waitFor(() => expect(button).toBeEnabled());
  expect(
    mock.invoke.mock.calls.filter(([command]) => command.type === 'computer.action'),
  ).toHaveLength(0);
  await userEvent.click(button);
  await screen.findByRole('button', { name: '停止电脑' });
  const command = mock.invoke.mock.calls
    .map(([value]) => value)
    .find((value) => value.type === 'computer.action');
  expect(command).toMatchObject({
    type: 'computer.action',
    request: { bot, action: 'connect', revision: 0 },
  });
  expect(pendingComputer(bot)).toBeUndefined();
});

it('requires saved-content confirmation and never fills a stale stop dialog with a replacement binding', async () => {
  const mock = bridge(state(connected), async () => {
    mock.update(state({ ...connected, revision: 4, instance: 'mock-native-after' }));
    throw new Error('COMPUTER_CONFLICT');
  });
  render(
    <RuntimeProvider>
      <Connection bot={bot} name="合成 Bot" notify={vi.fn()} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '停止电脑' }));
  const dialog = screen.getByRole('dialog');
  const submit = within(dialog).getByRole('button', { name: '停止电脑' });
  expect(submit).toBeDisabled();
  await userEvent.click(
    within(dialog).getByRole('checkbox', { name: '已保存这台电脑中未保存的内容' }),
  );
  await userEvent.click(submit);
  await waitFor(() =>
    expect(mock.invoke.mock.calls.some(([command]) => command.type === 'computer.action')).toBe(
      true,
    ),
  );
  expect(
    mock.invoke.mock.calls
      .map(([command]) => command)
      .find((command) => command.type === 'computer.action'),
  ).toMatchObject({
    request: {
      action: 'stop',
      bot,
      revision: 2,
      instance: 'mock-native-before',
      confirmation: 'close-apps',
    },
  });
  expect(submit).toBeDisabled();
  expect(dialog).toHaveTextContent('电脑状态已变化');
});

it('keeps an uncertain operation across remount and inspects its receipt without resending the effect', async () => {
  const notify = vi.fn();
  const mock = bridge(state(), async () => {
    mock.update(state(connected));
    throw new Error('RUNTIME_UNAVAILABLE');
  });
  const view = render(
    <RuntimeProvider>
      <Connection bot={bot} name="合成 Bot" notify={notify} />
    </RuntimeProvider>,
  );
  const connect = await screen.findByRole('button', { name: '连接电脑' });
  await waitFor(() => expect(connect).toBeEnabled());
  await userEvent.click(connect);
  await waitFor(() => expect(pendingComputer(bot)).toBeDefined());
  const pending = pendingComputer(bot)!;
  view.unmount();
  render(
    <RuntimeProvider>
      <Connection bot={bot} name="合成 Bot" notify={notify} />
    </RuntimeProvider>,
  );
  await waitFor(() =>
    expect(mock.invoke.mock.calls.some(([command]) => command.type === 'computer.receipt')).toBe(
      true,
    ),
  );
  expect(
    mock.invoke.mock.calls.filter(([command]) => command.type === 'computer.action'),
  ).toHaveLength(1);
  expect(mock.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'computer.receipt',
    id: pending.id,
    bot,
  });
  await waitFor(() => expect(pendingComputer(bot)).toBeUndefined());
});

it('does not change a computer while its Bot is running and does not offer fake retry for an abandoned reservation', async () => {
  const initial = state();
  initial.agents[bot] = { ...idle(), running: true, phase: 'running' };
  const mock = bridge(initial, async () => {
    throw new Error('must not mutate');
  });
  render(
    <RuntimeProvider>
      <Connection bot={bot} name="合成 Bot" notify={vi.fn()} />
    </RuntimeProvider>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: '连接电脑' })).toBeDisabled());
  act(() =>
    mock.update(
      state({
        bot,
        revision: 3,
        phase: 'interrupted',
        desired: true,
        reserved: true,
        recovery: 'restart',
        error: 'COMPUTER_OUTCOME_UNKNOWN',
      }),
    ),
  );
  expect(screen.queryByRole('button', { name: '连接电脑' })).not.toBeInTheDocument();
  expect(screen.getByText(/重启本地虚拟机/)).toBeVisible();
});

it('keeps connected uncertainty visible when receipt inspection fails after remount and never resends it', async () => {
  const request = { id: 'mock-lost-connect', bot, action: 'connect' as const, revision: 0 };
  beginComputer(request);
  const initial = state(connected);
  const mock = bridge(initial, async () => {
    throw new Error('must not replay');
  });
  mock.invoke.mockImplementation(async (command) => {
    if (command.type === 'status') return { ok: true, value: initial };
    throw new Error('RUNTIME_UNAVAILABLE');
  });
  render(
    <RuntimeProvider>
      <Connection bot={bot} name="合成 Bot" notify={vi.fn()} />
    </RuntimeProvider>,
  );
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).not.toBe('');
  expect(screen.getByRole('button', { name: '停止电脑' })).toBeDisabled();
  const inspect = screen.getByRole('button', { name: '核对电脑操作' });
  await waitFor(() => expect(inspect).toBeEnabled());
  await userEvent.click(inspect);
  expect(
    mock.invoke.mock.calls.filter(([command]) => command.type === 'computer.receipt'),
  ).toHaveLength(2);
  expect(
    mock.invoke.mock.calls.filter(([command]) => command.type === 'computer.action'),
  ).toHaveLength(0);
  expect(pendingComputer(bot)?.id).toBe(request.id);
  const running = state(connected);
  running.agents[bot] = { ...idle(), running: true, phase: 'running' };
  act(() => mock.update(running));
  expect(await screen.findByText(/任务在执行.*结束后/)).toBeVisible();
});

it('explains why stopping a connected computer is unavailable while its Bot is running', async () => {
  const initial = state(connected);
  initial.agents[bot] = { ...idle(), running: true, phase: 'running' };
  bridge(initial, async () => {
    throw new Error('must not mutate');
  });
  render(
    <RuntimeProvider>
      <Connection bot={bot} name="合成 Bot" notify={vi.fn()} />
    </RuntimeProvider>,
  );
  expect(await screen.findByText(/任务在执行.*结束后/)).toBeVisible();
  expect(screen.getByRole('button', { name: '停止电脑' })).toBeDisabled();
});
