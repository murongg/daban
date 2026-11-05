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
import { setLocale } from '../../i18n/locale';
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
    evidence:
      category === 'request'
        ? 'estimated'
        : category === 'preferences'
          ? 'not-injected'
          : 'unknown',
    membership:
      category === 'request'
        ? 'host-injected'
        : category === 'toolResults'
          ? 'saved-only'
          : 'unknown',
    hostTokens: category === 'request' ? 10 : category === 'preferences' ? 0 : null,
    savedCharacters: category === 'toolResults' ? 4 : 0,
    refs: category === 'toolResults' ? [{ scope, seq: 7 }] : [],
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
afterEach(async () => {
  Reflect.deleteProperty(window, 'daban');
  await setLocale('zh-CN');
});

it('binds history revisions and replaces an in-flight read when refreshing without accepting its late result', async () => {
  let finish: (value: unknown) => unknown = () => {};
  const invoke = bridge((command) =>
    command.type === 'context.inspect' && command.query.revision === 99
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { scope, state: 'captured', health: 'ok', selected: capture(101), revisions: [99, 101] },
  );
  render(
    <RuntimeProvider>
      <ContextInspector scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '上下文检查器' }));
  await user.click(await screen.findByRole('button', { name: /选择记录/ }));
  await user.click(await screen.findByRole('option', { name: '历史记录 1' }));
  expect(invoke).toHaveBeenCalledWith({ type: 'context.inspect', query: { scope, revision: 99 } });
  const refresh = screen.getByRole('button', { name: '刷新记录' });
  expect(refresh).toBeEnabled();
  await user.click(refresh);
  expect(await screen.findByRole('heading', { name: '材料来源' })).toBeVisible();
  await act(async () =>
    finish({ scope, state: 'captured', health: 'ok', selected: capture(99), revisions: [99, 101] }),
  );
  expect(screen.getByRole('button', { name: /选择记录/ })).toHaveTextContent('最近保存的记录');
});

it('leads with materials and readable originals while keeping independent estimates behind details', async () => {
  const invoke = bridge((command) =>
    command.type === 'context.source'
      ? {
          ...scope,
          seq: 7,
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
  expect(await screen.findByRole('heading', { name: '材料来源' })).toBeVisible();
  expect(screen.getByText('仅显示已保存的部分记录。')).toBeVisible();
  expect(screen.getByText('80')).not.toBeVisible();
  expect(screen.getByText('100')).not.toBeVisible();
  expect(screen.getByRole('heading', { name: '职责' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '图片' })).toBeVisible();
  expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
  expect(screen.getAllByText('本轮已提供')[0]).toBeVisible();
  expect(screen.getAllByText('本轮未提供')[0]).toBeVisible();
  expect(screen.getByText('仅已保存')).toBeVisible();
  expect(screen.getByText('通过链接查看已保存原文；没有链接的材料当前不可查看。')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '工具调用与结果：查看原文 1' }));
  expect(await screen.findByText('合成', { exact: true })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '读取下一页' }));
  expect(await screen.findByText('合成😀', { exact: true })).toBeVisible();
  expect(invoke).toHaveBeenCalledWith({
    type: 'context.source',
    query: { scope, revision: 1, ref: { scope, seq: 7 }, offset: 2 },
  });
  const beforeDetails = invoke.mock.calls.length;
  await user.click(screen.getByText('详细信息', { selector: 'summary' }));
  expect(screen.getByText('80')).toBeVisible();
  expect(screen.getByText('100')).toBeVisible();
  expect(screen.getByText('系统')).toBeVisible();
  expect(invoke).toHaveBeenCalledTimes(beforeDetails);
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
  expect(await screen.findByText('还没有保存上下文记录。')).toBeVisible();
  await act(async () =>
    finish({ scope, state: 'captured', health: 'ok', selected: capture(), revisions: [1] }),
  );
  expect(screen.queryByRole('heading', { name: '材料来源' })).not.toBeInTheDocument();
});

it.each([
  ['summary', '已记录摘要压缩。'],
  ['prune', '已记录内容裁剪。'],
  [undefined, '未记录压缩情况，无法判断是否发生。'],
] as const)(
  'reports observed compaction without treating missing evidence as no compaction: %s',
  async (kind, message) => {
    const selected = {
      ...capture(),
      ...(kind ? { boundary: { kind, endSeq: 9, shadowedSeqs: [8, 1], omittedSeqs: 0 } } : {}),
    };
    bridge(() => ({ scope, state: 'captured', health: 'ok', selected, revisions: [1] }));
    render(
      <RuntimeProvider>
        <ContextInspector scope={scope} />
      </RuntimeProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: '上下文检查器' }));
    expect(await screen.findByText(message)).toBeVisible();
  },
);

it.each([
  ['CONTEXT_CAPTURE_EXPIRED', '这条记录已过期，请刷新记录列表。'],
  ['CONTEXT_SOURCE_UNAVAILABLE', '此来源已不可用，无法查看原文。'],
  ['REMOTE_UNAUTHORIZED', '访问权限已失效，请重新连接后再试。'],
  ['SYNTHETIC_FAILURE', '读取失败，请重试。'],
] as const)(
  'keeps source failures visible outside collapsed technical details: %s',
  async (code, message) => {
    bridge((command) => {
      if (command.type === 'context.source') throw Error(code);
      return {
        scope,
        state: 'captured',
        health: 'capture-failed',
        selected: capture(),
        revisions: [1],
      };
    });
    render(
      <RuntimeProvider>
        <ContextInspector scope={scope} />
      </RuntimeProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: '上下文检查器' }));
    await userEvent.click(
      await screen.findByRole('button', { name: '工具调用与结果：查看原文 1' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: '重试读取' })).toBeVisible();
    expect(screen.getByText('记录未完整保存，当前显示此前保存的内容。')).toBeVisible();
    expect(
      screen.getByText('详细信息', { selector: 'summary' }).closest('details'),
    ).not.toHaveAttribute('open');
  },
);

it('uses English copy and restores focus after opening technical details', async () => {
  await act(async () => setLocale('en'));
  bridge(() => ({ scope, state: 'captured', health: 'ok', selected: capture(), revisions: [1] }));
  render(
    <RuntimeProvider>
      <ContextInspector scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name: 'Context inspector' });
  await user.click(trigger);
  expect(await screen.findByRole('heading', { name: 'Source materials' })).toBeVisible();
  const summary = screen.getByText('Details', { selector: 'summary' });
  await user.click(summary);
  expect(summary.closest('details')).toHaveAttribute('open');
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
});
