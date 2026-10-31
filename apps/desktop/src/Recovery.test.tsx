import { beforeEach as seedBeforeEach } from 'vitest';
import { demoState as seedDemoState } from './fixtures';
import { serialize as seedSerialize, storageKey as seedStorageKey } from './storage';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  agentId,
  disconnected,
  type RebootOperation,
  type RebootStatus,
  type RecoveryReview,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { demoState as initialState } from './fixtures';
import { Recovery } from './Recovery';
import { RuntimeProvider } from './Runtime';
import { serialize, storageKey } from './storage';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const review: RecoveryReview = {
  boot: 'mock-ui-boot',
  instance: 'mock-ui-runtime',
  revision: 0,
  computersRevision: 0,
  digest: 'a'.repeat(64),
  running: [],
  changing: false,
  screens: [
    {
      computer: {
        bot: 'a',
        revision: 1,
        phase: 'connected',
        desired: true,
        reserved: true,
        instance: 'mock-screen-a',
      },
      lease: { owner: 'human', epoch: 2 },
    },
    {
      computer: {
        bot: 'b',
        revision: 1,
        phase: 'connected',
        desired: true,
        reserved: true,
        instance: 'mock-screen-b',
      },
      lease: { owner: 'agent', epoch: 1 },
    },
  ],
};
const bots = initialState().bots;
function bridge(operation?: RebootOperation) {
  let host: RebootStatus = {
    available: true,
    revision: operation ? 3 : 0,
    busy: false,
    vm: 'running',
    ...(operation ? { operation } : {}),
  };
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 24;
  snapshot.recovery = { available: true, revision: 0 };
  snapshot.reboot = host;
  snapshot.computers = {
    available: true,
    revision: 0,
    limit: 2,
    items: review.screens.map((row) => row.computer),
  };
  const idle = {
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
  };
  snapshot.bots = Object.fromEntries(
    review.screens.map((row) => [
      row.computer.bot,
      {
        instance: row.computer.instance,
        owner: row.lease!.owner,
        epoch: row.lease!.epoch,
        task: idle,
      },
    ]),
  );
  snapshot.model = {
    configured: true,
    available: true,
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    revision: 0,
  };
  snapshot.profiles = bots
    .filter((bot) => !bot.members)
    .map((bot) => ({
      id: agentId(bot.id),
      name: bot.name,
      instructions: bot.role,
      memory: 'SYNTHETIC',
      color: bot.color,
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
  const listeners = new Set<Parameters<RuntimeBridge['subscribe']>[0]>();
  const publish = () => {
    snapshot.reboot = host;
    for (const listener of listeners) listener(structuredClone(snapshot));
  };
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'status') return { ok: true, value: structuredClone(snapshot) };
    if (command.type === 'recovery.status') return { ok: true, value: host };
    if (command.type === 'recovery.review') return { ok: true, value: review };
    if (command.type === 'recovery.restart') {
      host = {
        available: true,
        revision: 3,
        busy: false,
        vm: 'unknown',
        operation: {
          id: command.request.id,
          stage: 'stop-issued',
          review,
          backend: { id: command.request.id, revision: 2, phase: 'claimed', review },
          error: 'RECOVERY_STOP_UNCONFIRMED',
        },
      };
      publish();
      return { ok: true, value: host };
    }
    if (command.type === 'recovery.inspect' && host.available && host.operation) {
      host = {
        ...host,
        revision: 4,
        vm: 'stopped',
        operation: { ...host.operation, stage: 'stopped', error: undefined },
      };
      publish();
      return { ok: true, value: host };
    }
    if (command.type === 'recovery.start' && host.available && host.operation) {
      // A new kernel has closed the old screens; this is the expected successful recovery state.
      snapshot.computers = { available: true, limit: 2, revision: 1, items: [] };
      snapshot.bots = {};
      host = {
        ...host,
        revision: 5,
        vm: 'running',
        operation: {
          ...host.operation,
          stage: 'complete',
          backend: {
            id: command.id,
            phase: 'complete',
            revision: 3,
            review,
            boot: 'mock-new-boot',
            instance: 'mock-new-runtime',
          },
          error: undefined,
        },
      };
      publish();
      return { ok: true, value: host };
    }
    return { ok: true, value: {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      runtime: {
        invoke,
        subscribe: (listener: Parameters<RuntimeBridge['subscribe']>[0]) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return invoke;
}
it('requires fresh all-screen saved-content confirmation and never repeats an uncertain stop automatically', async () => {
  const invoke = bridge();
  render(
    <RuntimeProvider>
      <Recovery bots={bots} close={() => undefined} />
    </RuntimeProvider>,
  );
  const button = await screen.findByRole('button', { name: '确认重启整个环境' });
  expect(button).toBeDisabled();
  expect(screen.getByText('研究员')).toBeVisible();
  expect(screen.getByText('写作搭档')).toBeVisible();
  await userEvent.click(screen.getByRole('checkbox', { name: '我已保存所有电脑中的内容' }));
  await userEvent.click(button);
  await screen.findByRole('button', { name: '核对恢复结果' });
  expect(invoke.mock.calls.filter(([command]) => command.type === 'recovery.restart')).toHaveLength(
    1,
  );
  const command = invoke.mock.calls.find(([value]) => value.type === 'recovery.restart')![0];
  expect(command).toMatchObject({
    request: { review: review.digest, revision: 0, confirmation: 'restart-all-apps' },
  });
});
it('reopens into read-only inspection and requires a separate explicit start after stopped proof', async () => {
  const operation: RebootOperation = {
    id: 'mock-reopened',
    stage: 'stop-issued',
    review,
    backend: { id: 'mock-reopened', phase: 'claimed', revision: 2, review },
    error: 'RECOVERY_STOP_UNCONFIRMED',
  };
  const invoke = bridge(operation);
  render(
    <RuntimeProvider>
      <Recovery bots={bots} close={() => undefined} />
    </RuntimeProvider>,
  );
  await screen.findByRole('button', { name: '核对恢复结果' });
  expect(screen.getByText('关机结果尚未确认。请先核对；客户端不会自动重复关机。')).toBeVisible();
  expect(
    invoke.mock.calls.some(([command]) =>
      ['recovery.restart', 'recovery.start'].includes(command.type),
    ),
  ).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '核对恢复结果' }));
  await userEvent.click(await screen.findByRole('button', { name: '启动运行环境' }));
  await screen.findByText('运行环境已恢复');
  expect(invoke.mock.calls.filter(([command]) => command.type === 'recovery.restart')).toHaveLength(
    0,
  );
  expect(invoke.mock.calls.filter(([command]) => command.type === 'recovery.start')).toHaveLength(
    1,
  );
});
it('successful reboot reports completion after the reviewed screens have closed', async () => {
  bridge();
  render(
    <RuntimeProvider>
      <Recovery bots={bots} close={() => undefined} />
    </RuntimeProvider>,
  );
  const confirm = await screen.findByRole('button', { name: '确认重启整个环境' });
  await userEvent.click(screen.getByRole('checkbox', { name: '我已保存所有电脑中的内容' }));
  await userEvent.click(confirm);
  await userEvent.click(await screen.findByRole('button', { name: '核对恢复结果' }));
  await userEvent.click(await screen.findByRole('button', { name: '启动运行环境' }));
  await screen.findByText('运行环境已恢复');
  expect(screen.queryByText('运行环境或控制状态已变化，请重新核对。')).not.toBeInTheDocument();
});
it('a later reboot uses a fresh review instead of the completed operation from the previous kernel', async () => {
  const previous = {
    ...review,
    boot: 'mock-previous-boot',
    instance: 'mock-previous-runtime',
    digest: 'b'.repeat(64),
    screens: [],
  };
  const invoke = bridge({
    id: 'mock-previous-reboot',
    stage: 'complete',
    review: previous,
    backend: {
      id: 'mock-previous-reboot',
      phase: 'complete',
      revision: 3,
      review: previous,
      boot: review.boot,
      instance: review.instance,
    },
  });
  render(
    <RuntimeProvider>
      <Recovery bots={bots} close={() => undefined} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('checkbox', { name: '我已保存所有电脑中的内容' }));
  expect(screen.getByText('研究员')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '确认重启整个环境' }));
  const next = invoke.mock.calls.find(([command]) => command.type === 'recovery.restart')?.[0];
  expect(next).toMatchObject({ request: { review: review.digest, revision: review.revision } });
});
it('does not retain saved-content consent when the dialog is closed and reopened', async () => {
  bridge();
  const first = render(
    <RuntimeProvider>
      <Recovery bots={bots} close={() => undefined} />
    </RuntimeProvider>,
  );
  const box = await screen.findByRole('checkbox', { name: '我已保存所有电脑中的内容' });
  await userEvent.click(box);
  first.unmount();
  await act(async () => {
    render(
      <RuntimeProvider>
        <Recovery bots={bots} close={() => undefined} />
      </RuntimeProvider>,
    );
  });
  expect(
    await screen.findByRole('checkbox', { name: '我已保存所有电脑中的内容' }),
  ).not.toBeChecked();
});
it('keeps chat drafts editable while global recovery disables sending and exposes the owned receipt', async () => {
  const operation: RebootOperation = {
    id: 'mock-global-ui',
    stage: 'stop-issued',
    review,
    backend: { id: 'mock-global-ui', phase: 'claimed', revision: 2, review },
  };
  const invoke = bridge(operation);
  const state = initialState();
  state.panel = null;
  state.drafts.research = 'SYNTHETIC-UNSENT';
  localStorage.setItem(storageKey, serialize(state));
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  expect(input).toHaveValue('SYNTHETIC-UNSENT');
  expect(input).not.toHaveAttribute('readonly');
  await userEvent.type(input, '-MORE');
  expect(input).toHaveValue('SYNTHETIC-UNSENT-MORE');
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '查看恢复' }));
  await screen.findByRole('dialog', { name: '恢复整个运行环境' });
  expect(invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
});
