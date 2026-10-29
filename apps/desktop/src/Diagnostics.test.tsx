import {
  type DiagnosticReport,
  diagnosticIds,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Diagnostics } from './Diagnostics';
import { RuntimeProvider } from './Runtime';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function report(): DiagnosticReport {
  return {
    scope: 'host',
    checkedAt: '2026-01-01T00:00:00.000Z',
    checks: [...diagnosticIds.host, ...diagnosticIds.runtime].map((id) => ({ id, state: 'ready' })),
  };
}
function bridge(inspect: () => Promise<DiagnosticReport>) {
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'status') return { ok: true, value: disconnected() };
    return { ok: true, value: await inspect() };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge },
  });
  return invoke;
}
it('offers an explicit read-only check while offline and explains a specific failed layer without starting anything', async () => {
  const value = report();
  value.checks = value.checks.map((row) => ({
    ...row,
    state: row.id === 'configuration' ? 'ready' : row.id === 'vm' ? 'unavailable' : 'unchecked',
  }));
  const invoke = bridge(async () => value);
  render(
    <RuntimeProvider>
      <Diagnostics />
    </RuntimeProvider>,
  );
  const button = screen.getByRole('button', { name: '检查运行环境' });
  expect(button).toBeEnabled();
  expect(invoke.mock.calls.some(([command]) => command.type === 'runtime.inspect')).toBe(false);
  await userEvent.click(button);
  expect(await screen.findByText('Linux 虚拟机')).toBeVisible();
  expect(screen.getByText('无法确认虚拟机已运行。可先重试连接，再重新检查。')).toBeVisible();
  expect(invoke.mock.calls.map(([command]) => command.type)).toEqual(['status', 'runtime.inspect']);
});
it('keeps model configuration and installed dependencies distinct from a successful live provider/desktop check', async () => {
  bridge(async () => report());
  render(
    <RuntimeProvider>
      <Diagnostics />
    </RuntimeProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: '检查运行环境' }));
  expect(await screen.findByText('本次状态检查已完成')).toBeVisible();
  await userEvent.click(screen.getByText('查看全部检查项（17）'));
  expect(screen.getByText('模型配置')).toBeVisible();
  expect(screen.getByText('已保存')).toBeVisible();
  expect(
    screen.getByText(
      '模型项仅核对已保存的配置；API 连通性请使用上方“检查连接”。桌面项仅检查命令依赖，完整桌面需连接后验证。',
    ),
  ).toBeVisible();
});
it('does not let a report arriving after unmount replace a later inspection', async () => {
  let release: (value: DiagnosticReport) => unknown = () => undefined;
  let calls = 0;
  bridge(async () =>
    ++calls === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : report(),
  );
  const first = render(
    <RuntimeProvider>
      <Diagnostics />
    </RuntimeProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: '检查运行环境' }));
  expect(screen.getByRole('button', { name: '正在检查…' })).toBeDisabled();
  first.unmount();
  render(
    <RuntimeProvider>
      <Diagnostics />
    </RuntimeProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: '检查运行环境' }));
  await screen.findByText('本次状态检查已完成');
  const late = report();
  late.checks[1].state = 'unavailable';
  await act(async () => {
    release(late);
  });
  expect(
    screen.queryByText('无法确认虚拟机已运行。可先重试连接，再重新检查。'),
  ).not.toBeInTheDocument();
});
