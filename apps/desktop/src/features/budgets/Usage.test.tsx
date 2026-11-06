import { type BudgetView, defaultBudgetPolicy } from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Usage } from './Usage';

const backend = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('../../app/Runtime', () => ({
  useRuntime: () => backend,
  runtimeError: () => 'SYNTHETIC ERROR',
}));
const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const view: BudgetView = {
  owner: scope,
  scope: { budgetId: 'synthetic-budget', revision: 1 },
  rootId: 'synthetic-root',
  policy: { ...defaultBudgetPolicy, maxRequests: 2 },
  state: 'limit-reached',
  availability: 'recorded',
  historyUnmetered: false,
  requests: 2,
  reported: {
    state: 'reported',
    inputTokens: 8,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  reservedTokens: 100,
  unknownCount: 1,
  unknownCostCount: 2,
  warned: true,
  receipts: [],
};
beforeEach(() => {
  backend.command.mockReset();
});
test('reported, estimated, reserved and unknown remain distinct without inventing a free bill', async () => {
  backend.command.mockResolvedValue(view);
  render(<Usage scope={scope} />);
  expect(await screen.findByText('用量与预算')).toBeVisible();
  expect(screen.getByText('未知费用项：2')).toBeVisible();
  expect(screen.getByText('未知请求：1')).toBeVisible();
  expect(screen.getByText('费用为估算，不是供应商账单。')).toBeVisible();
  expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument();
});
test('quota dialog keeps native keyboard dismissal and starts no task on Escape', async () => {
  backend.command.mockResolvedValue(view);
  render(<Usage scope={scope} />);
  const opener = await screen.findByRole('button', { name: '增加额度并继续' });
  await userEvent.click(opener);
  expect(screen.getByRole('dialog')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
  expect(backend.command.mock.calls.every(([c]) => c.type === 'budget.read')).toBe(true);
});
test('a late read cannot attach the previous task budget to a new scope', async () => {
  let release: (value: BudgetView) => unknown = () => {};
  backend.command
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(null);
  const rendered = render(<Usage scope={scope} />);
  rendered.rerender(<Usage scope={{ ...scope, runId: 'mock-next' }} />);
  await act(async () => {
    release(view);
  });
  expect(screen.queryByText('未知请求：1')).not.toBeInTheDocument();
});
test('legacy tasks show missing provider recording without blocking execution history', async () => {
  backend.command.mockResolvedValue(null);
  render(<Usage scope={scope} />);
  expect(await screen.findByText('未记录供应商用量')).toBeVisible();
});

test('a foreign-owner increase acknowledgement cannot continue another task', async () => {
  backend.command.mockImplementation(async (command) =>
    command.type === 'budget.read'
      ? view
      : {
          ...view,
          owner: { ...scope, runId: 'foreign-run' },
          scope: { ...view.scope, revision: 2 },
          state: 'active',
        },
  );
  render(<Usage scope={scope} />);
  await userEvent.click(await screen.findByRole('button', { name: '增加额度并继续' }));
  const buttons = screen.getAllByRole('button', { name: '增加额度并继续' });
  await userEvent.click(buttons.at(-1)!);
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(backend.command.mock.calls.some(([c]) => c.type === 'budget.continue')).toBe(false);
});

for (const code of ['BUDGET_INCREASE_REQUIRED', 'BUDGET_REVISION_CONFLICT']) {
  test(`a definite ${code} leaves the draft editable and rereads only on explicit request`, async () => {
    let reject = true;
    let current = view;
    backend.command.mockImplementation(
      async (command: import('@daban/protocol').RuntimeCommand) => {
        if (command.type === 'budget.read') return current;
        if (command.type === 'budget.increase') {
          if (reject) throw new Error(code);
          current = {
            ...view,
            policy: command.request.policy,
            scope: { ...view.scope, revision: command.request.revision + 1 },
            state: 'stopped',
          };
          return current;
        }
        return {
          budget: current.scope,
          owner: scope,
          id: command.type === 'budget.continue' ? command.id : '',
          queued: false,
          runId: 'mock-resumed',
        };
      },
    );
    render(<Usage scope={scope} />);
    const opener = await screen.findByRole('button', { name: '增加额度并继续' });
    await userEvent.click(opener);
    let tools = screen.getByRole('spinbutton', { name: '工具调用上限' });
    let requests = screen.getByRole('spinbutton', { name: '模型请求数' });
    await userEvent.clear(tools);
    await userEvent.type(tools, '1');
    await userEvent.clear(requests);
    await userEvent.type(requests, '7');
    await userEvent.click(screen.getAllByRole('button', { name: '增加额度并继续' }).at(-1)!);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(tools).toBeEnabled();
    expect(tools).toHaveValue(1);
    expect(requests).toHaveValue(7);
    expect(backend.command.mock.calls.filter(([c]) => c.type === 'budget.continue')).toHaveLength(
      0,
    );
    const first = backend.command.mock.calls.find(([c]) => c.type === 'budget.increase')![0];
    current = { ...view, scope: { ...view.scope, revision: 2 } };
    const reloadButton = screen.getByRole('button', { name: '重新读取预算' });
    await userEvent.click(reloadButton);
    expect(reloadButton).toHaveFocus();
    expect(tools).toHaveValue(1);
    expect(requests).toHaveValue(7);
    expect(backend.command.mock.calls.filter(([c]) => c.type === 'budget.increase')).toHaveLength(
      1,
    );
    expect(backend.command.mock.calls.filter(([c]) => c.type === 'budget.continue')).toHaveLength(
      0,
    );
    await userEvent.keyboard('{Escape}');
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    tools = screen.getByRole('spinbutton', { name: '工具调用上限' });
    requests = screen.getByRole('spinbutton', { name: '模型请求数' });
    expect(tools).toHaveValue(1);
    expect(requests).toHaveValue(7);
    reject = false;
    await userEvent.clear(tools);
    await userEvent.type(tools, '70');
    await userEvent.keyboard('{Enter}');
    expect(
      await screen.findByText('采用额度：工具 70 次，有效执行 300 秒，目标续行 3 轮。'),
    ).toBeVisible();
    const sends = backend.command.mock.calls.filter(([c]) => c.type === 'budget.increase');
    expect(sends).toHaveLength(2);
    expect(sends[1][0].request).toMatchObject({
      revision: 2,
      scope,
      policy: { toolLimit: 70, maxRequests: 7 },
    });
    expect(sends[1][0].request.id).not.toBe(first.request.id);
    expect(backend.command.mock.calls.filter(([c]) => c.type === 'budget.continue')).toHaveLength(
      1,
    );
  });
}

test.each([
  ['increase', 'RUNTIME_UNAVAILABLE'],
  ['continue', 'RUNTIME_UNAVAILABLE'],
  ['continue', 'BUDGET_REVISION_CONFLICT'],
])('an uncertain %s result (%s) retains the exact request across remount', async (stage, code) => {
  let raised: BudgetView | undefined;
  backend.command.mockImplementation(async (command: import('@daban/protocol').RuntimeCommand) => {
    if (command.type === 'budget.read') return raised ?? view;
    if (command.type === 'budget.increase') {
      raised ??= {
        ...view,
        policy: command.request.policy,
        scope: { ...view.scope, revision: command.request.revision + 1 },
        state: 'stopped',
      };
      if (stage === 'increase') throw new Error(code);
      return raised;
    }
    throw new Error(code);
  });
  const first = render(<Usage scope={scope} />);
  await userEvent.click(await screen.findByRole('button', { name: '增加额度并继续' }));
  await userEvent.click(screen.getAllByRole('button', { name: '增加额度并继续' }).at(-1)!);
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByRole('spinbutton', { name: '工具调用上限' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '重新读取预算' })).not.toBeInTheDocument();
  first.unmount();
  render(<Usage scope={scope} />);
  await userEvent.click(await screen.findByRole('button', { name: '增加额度并继续' }));
  expect(screen.getByRole('spinbutton', { name: '工具调用上限' })).toBeDisabled();
  await userEvent.click(screen.getAllByRole('button', { name: '增加额度并继续' }).at(-1)!);
  expect(await screen.findByRole('alert')).toBeVisible();
  const increases = backend.command.mock.calls.filter(([c]) => c.type === 'budget.increase');
  expect(increases).toHaveLength(2);
  expect(increases[0][0]).toEqual(increases[1][0]);
  const continues = backend.command.mock.calls.filter(([c]) => c.type === 'budget.continue');
  if (stage === 'continue') {
    expect(continues).toHaveLength(2);
    expect(continues[0][0]).toEqual(continues[1][0]);
  } else expect(continues).toHaveLength(0);
});

test('a late definite increase rejection cannot unlock or replace another target', async () => {
  let reject: (reason: Error) => unknown = () => {};
  const waiting = new Promise((_, rejectPromise) => {
    reject = rejectPromise;
  });
  const otherScope = { bot: 'mock-other', runId: 'mock-other-run', chatRevision: 0 };
  const other = {
    ...view,
    owner: otherScope,
    scope: { budgetId: 'synthetic-other-budget', revision: 1 },
    policy: { ...view.policy, toolLimit: 88 },
  };
  backend.command.mockImplementation(async (command: import('@daban/protocol').RuntimeCommand) => {
    if (command.type === 'budget.read') return command.query.scope.bot === scope.bot ? view : other;
    if (command.type === 'budget.increase') return waiting;
    throw new Error('SYNTHETIC_UNEXPECTED_CONTINUE');
  });
  const rendered = render(<Usage scope={scope} />);
  await userEvent.click(await screen.findByRole('button', { name: '增加额度并继续' }));
  await userEvent.click(screen.getAllByRole('button', { name: '增加额度并继续' }).at(-1)!);
  rendered.rerender(<Usage scope={otherScope} />);
  await act(async () => {
    reject(new Error('BUDGET_REVISION_CONFLICT'));
  });
  await userEvent.click(await screen.findByRole('button', { name: '增加额度并继续' }));
  expect(screen.getByRole('spinbutton', { name: '工具调用上限' })).toHaveValue(88);
  expect(screen.getByRole('spinbutton', { name: '工具调用上限' })).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(backend.command.mock.calls.filter(([c]) => c.type === 'budget.increase')).toHaveLength(1);
  expect(backend.command.mock.calls.some(([c]) => c.type === 'budget.continue')).toBe(false);
});

test('a late explicit budget reload cannot replace a newly selected Bot budget', async () => {
  let release: (result: BudgetView) => unknown = () => {};
  const delayed = new Promise<BudgetView>((resolve) => {
    release = resolve;
  });
  const otherScope = { bot: 'mock-other', runId: 'mock-other-run', chatRevision: 0 };
  const other = {
    ...view,
    owner: otherScope,
    scope: { budgetId: 'synthetic-other-budget', revision: 1 },
    policy: { ...view.policy, toolLimit: 88 },
  };
  let reads = 0;
  backend.command.mockImplementation(async (command: import('@daban/protocol').RuntimeCommand) => {
    if (command.type === 'budget.read')
      return command.query.scope.bot !== scope.bot ? other : ++reads === 1 ? view : delayed;
    throw new Error('BUDGET_REVISION_CONFLICT');
  });
  const rendered = render(<Usage scope={scope} />);
  await userEvent.click(await screen.findByRole('button', { name: '增加额度并继续' }));
  await userEvent.click(screen.getAllByRole('button', { name: '增加额度并继续' }).at(-1)!);
  await userEvent.click(await screen.findByRole('button', { name: '重新读取预算' }));
  rendered.rerender(<Usage scope={otherScope} />);
  await act(async () => {
    release({ ...view, policy: { ...view.policy, toolLimit: 99 } });
  });
  await userEvent.click(await screen.findByRole('button', { name: '增加额度并继续' }));
  expect(screen.getByRole('spinbutton', { name: '工具调用上限' })).toHaveValue(88);
  expect(screen.queryByRole('button', { name: '重新读取预算' })).not.toBeInTheDocument();
  expect(backend.command.mock.calls.some(([c]) => c.type === 'budget.continue')).toBe(false);
});
