import { defaultBudgetPolicy } from '@daban/protocol';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { Budgets } from './Budgets';

const backend = vi.hoisted(() => ({
  command: vi.fn(),
  snapshot: { model: { revision: 1, connections: [] } },
}));
vi.mock('../../app/Runtime', () => ({
  useRuntime: () => backend,
  runtimeError: () => 'SYNTHETIC ERROR',
}));
test('settings disclose unsupported hard fee bounds and saving defaults starts no inference', async () => {
  const settings = {
    scope: 'synthetic-settings',
    revision: 0,
    policy: defaultBudgetPolicy,
    prices: [],
    strict: {
      requests: true,
      tokens: false,
      money: false,
      reason: 'TOKEN_AND_FEE_BOUNDS_UNVERIFIED',
    },
  };
  backend.command.mockResolvedValue(settings);
  render(<Budgets />);
  expect(await screen.findByText('默认预算')).toBeVisible();
  expect(
    screen.getByText('当前仅支持已验证路线的请求数硬限制；token 与费用上界未验证。'),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '保存默认预算' }));
  expect(backend.command.mock.calls.map(([c]) => c.type)).toEqual([
    'budget.settings',
    'budget.configure',
  ]);
});

test('an unconfirmed defaults write survives remount and retries its exact scoped request', async () => {
  const settings = {
    scope: 'synthetic-pending-settings',
    revision: 0,
    policy: defaultBudgetPolicy,
    prices: [],
    strict: { requests: true, tokens: false, money: false },
  };
  let committed = false;
  const writes: unknown[] = [];
  backend.command.mockReset().mockImplementation(async (command) => {
    if (command.type === 'budget.settings') return { ...settings, revision: committed ? 1 : 0 };
    writes.push(structuredClone(command.request));
    if (!committed) {
      committed = true;
      throw new Error('SYNTHETIC_LOST_ACK');
    }
    return { ...settings, revision: 1 };
  });
  const first = render(<Budgets />);
  await userEvent.click(await screen.findByRole('button', { name: '保存默认预算' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  first.unmount();
  render(<Budgets />);
  await userEvent.click(await screen.findByRole('button', { name: '核对并重试' }));
  expect(await screen.findByText('默认预算已保存。已有任务保持原额度。')).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});
