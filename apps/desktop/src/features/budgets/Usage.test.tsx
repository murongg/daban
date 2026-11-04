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
