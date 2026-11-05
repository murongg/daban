import {
  type ContextCapture,
  contextCategories,
  disconnected,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { ContextInspector } from './ContextInspector';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const capture = (revision = 1): ContextCapture => ({
  revision,
  at: '2026-01-01T00:00:00.000Z',
  reason: 'settled',
  coverage: 'partial',
  turnId: 'mock-turn',
  estimator: 'daban-text-v1',
  configuredWindow: 16384,
  configuredOutput: 1024,
  sources: contextCategories.map((category) => ({
    category,
    evidence: 'unknown',
    membership: category === 'toolResults' ? 'saved-only' : 'unknown',
    hostTokens: null,
    savedCharacters: category === 'toolResults' ? 4 : 0,
    refs: category === 'toolResults' ? [{ scope, seq: 1 }] : [],
    omittedRefs: 0,
  })),
  pressure: { seq: 0, at: '2026-01-01T00:00:00.000Z', pressureTokens: 80, projectedTokens: 100 },
  breakdown: {
    seq: 9,
    at: '2026-01-01T00:00:01.000Z',
    systemTokens: 2,
    toolsTokens: 3,
    messageTokens: 4,
  },
  gaps: ['sdk-envelope'],
});
function bridge(read: (command: RuntimeCommand) => unknown | Promise<unknown>, supported = true) {
  const snapshot: RuntimeSnapshot = {
    ...disconnected('ready'),
    ...(supported ? { contextInspector: 1 } : {}),
  };
  const invoke = vi.fn(
    async (command: RuntimeCommand): Promise<RuntimeReply> => ({
      ok: true,
      value: command.type === 'status' ? snapshot : await read(command),
    }),
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { runtime: { invoke, subscribe: () => () => {} } },
  });
  return invoke;
}
afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
});

it('binds history revisions and replaces an in-flight read when refreshing without accepting its late result', async () => {
  let finish: (value: unknown) => unknown = () => {};
  const invoke = bridge((command) =>
    command.type === 'context.inspect' && command.query.revision === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { scope, state: 'captured', health: 'ok', selected: capture(2), revisions: [1, 2] },
  );
  render(
    <RuntimeProvider>
      <ContextInspector scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '上下文检查器' }));
  await user.click(await screen.findByRole('button', { name: /选择捕获/ }));
  await user.click(await screen.findByRole('option', { name: '历史捕获 #1（captured）' }));
  expect(invoke).toHaveBeenCalledWith({ type: 'context.inspect', query: { scope, revision: 1 } });
  const refresh = screen.getByRole('button', { name: '刷新捕获' });
  expect(refresh).toBeEnabled();
  await user.click(refresh);
  expect(await screen.findByText('最近供应商输入样本')).toBeVisible();
  await act(async () =>
    finish({ scope, state: 'captured', health: 'ok', selected: capture(1), revisions: [1, 2] }),
  );
  expect(screen.queryByText('历史捕获 #1（captured）', { selector: 'p' })).not.toBeInTheDocument();
});

it('shows independent partial estimates, ten source categories and capture-bound visible pages', async () => {
  const invoke = bridge((command) =>
    command.type === 'context.source'
      ? {
          ...scope,
          seq: 1,
          offset: command.query.offset ?? 0,
          total: 4,
          text: command.query.offset ? '😀' : '合成',
          ...(command.query.offset ? {} : { nextOffset: 2 }),
        }
      : { scope, state: 'captured', health: 'ok', selected: capture(), revisions: [1] },
  );
  render(
    <RuntimeProvider>
      <ContextInspector scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '上下文检查器' }));
  expect(await screen.findByText('最近供应商输入样本')).toBeVisible();
  expect(screen.getByText('80')).toBeVisible();
  expect(screen.getByText('100')).toBeVisible();
  expect(screen.getByText('系统')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '来源' }));
  expect(screen.getByRole('heading', { name: '职责' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '图片' })).toBeVisible();
  expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
  await user.click(screen.getByRole('button', { name: '读取原文 #1' }));
  expect(await screen.findByText('合成', { exact: true })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '读取下一页' }));
  expect(await screen.findByText('合成😀', { exact: true })).toBeVisible();
  expect(invoke).toHaveBeenCalledWith({
    type: 'context.source',
    query: { scope, revision: 1, ref: { scope, seq: 1 }, offset: 2 },
  });
  expect(document.body.textContent).not.toMatch(/0%|剩余容量|实际完整输入|账单/);
});

it('keeps unsupported services quiet and discards a response after closing and reopening', async () => {
  const unavailable = bridge(() => {
    throw Error('unexpected query');
  }, false);
  const first = render(
    <RuntimeProvider>
      <ContextInspector scope={scope} />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('button', { name: '上下文检查器' })).toBeDisabled();
  expect(unavailable.mock.calls.map(([command]) => command.type)).toEqual(['status']);
  first.unmount();
  let finish: (value: unknown) => unknown = () => {};
  let count = 0;
  bridge(() =>
    ++count === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { scope, state: 'unavailable', reason: 'not-captured' },
  );
  render(
    <RuntimeProvider>
      <ContextInspector scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '上下文检查器' }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: '上下文检查器' }));
  expect(await screen.findByText('尚未捕获上下文。')).toBeVisible();
  await act(async () =>
    finish({ scope, state: 'captured', health: 'ok', selected: capture(), revisions: [1] }),
  );
  expect(screen.queryByText('最近供应商输入样本')).not.toBeInTheDocument();
});
