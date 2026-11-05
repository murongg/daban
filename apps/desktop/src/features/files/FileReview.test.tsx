import {
  disconnected,
  type RemoteState,
  type ReviewPage,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { FileReview } from './FileReview';

const remote = vi.hoisted(() => ({ state: undefined as RemoteState | undefined }));
vi.mock('../../app/Remote', () => ({ useRemote: () => remote }));

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const present = {
  area: 'task' as const,
  path: 'mock.txt',
  state: 'present' as const,
  bytes: 4,
  text: true,
};
function page(revision = 1): ReviewPage {
  return {
    scope,
    revision,
    state: 'complete',
    writers: 'unknown',
    effects: 'partial',
    reasons: ['unbounded-writer'],
    before: [
      {
        area: 'task',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
        capture: 'complete',
        reasons: [],
        omitted: 0,
      },
    ],
    after: [
      {
        area: 'task',
        startedAt: '2026-01-01T00:01:00Z',
        endedAt: '2026-01-01T00:01:01Z',
        capture: 'partial',
        reasons: ['excluded'],
        omitted: 1,
      },
    ],
    counts: { created: 0, modified: 1, deleted: 0, unchanged: 0, unknown: 0 },
    items: [
      {
        before: { ...present, sha256: 'a'.repeat(64) },
        after: { ...present, sha256: 'b'.repeat(64) },
        kind: 'modified',
      },
    ],
  };
}
function bridge(read: (command: RuntimeCommand) => unknown | Promise<unknown>, available = true) {
  const snapshot: RuntimeSnapshot = { ...disconnected('ready'), fileReview: { available } };
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
afterEach(() => Reflect.deleteProperty(window, 'daban'));
afterEach(() => {
  remote.state = undefined;
});

it('a workspace change closes the old evidence view and fences its late reply even for equal task IDs', async () => {
  const identity = { id: 'a'.repeat(64), publicKey: 'SYNTHETIC KEY', name: 'SYNTHETIC HOST' };
  remote.state = {
    selected: identity.id,
    identity,
    hosting: false,
    server: 'https://relay.example.test',
    pending: [],
    hosts: [
      {
        identity,
        workspace: 'mock-first',
        server: 'https://relay.example.test',
        platform: 'synthetic',
        state: 'connected',
        transport: 'direct',
      },
    ],
  };
  let finish: (value: ReviewPage) => unknown = () => {};
  const earlier = new Promise<ReviewPage>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  bridge(() => (++calls === 1 ? earlier : page(2)));
  const view = render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '文件审阅' }));
  remote.state = {
    ...remote.state,
    hosts: [{ ...remote.state.hosts[0], workspace: 'mock-second' }],
  };
  view.rerender(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  expect(screen.queryByRole('dialog', { name: '文件审阅' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '文件审阅' }));
  expect(await screen.findByText('证据版本 #2')).toBeVisible();
  await act(async () => {
    finish(page());
    await earlier;
  });
  expect(screen.queryByText('证据版本 #1')).not.toBeInTheDocument();
});

it('does not describe a partial baseline as successfully recorded', async () => {
  bridge(() => ({
    ...page(),
    state: 'recording',
    after: undefined,
    before: [{ ...page().before![0], capture: 'partial', reasons: ['entry-limit'], omitted: 1 }],
    items: [],
    counts: { created: 0, modified: 0, deleted: 0, unchanged: 0, unknown: 0 },
  }));
  render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  await userEvent.setup().click(await screen.findByRole('button', { name: '文件审阅' }));
  expect(await screen.findByText('基线不完整或不可用')).toBeVisible();
});

it('reads immutable evidence and current state separately, preserving literal diff and line endings', async () => {
  const invoke = bridge((command) => {
    if (command.type === 'files.review.diff')
      return {
        ...command.query,
        state: 'text',
        lines: [
          { kind: 'remove', text: '<script>mock</script>\r\n' },
          { kind: 'add', text: '<script>mock</script>\n' },
        ],
      };
    if (command.type === 'files.review.current') return { ...command.query, state: 'changed' };
    return page();
  });
  render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '文件审阅' }));
  expect(await screen.findByText('证据版本 #1')).toBeVisible();
  expect(screen.getByText('变化表示两次观察不同，不能据此归因于单个 Bot。')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '查看差异 mock.txt' }));
  expect(await screen.findByText('CRLF')).toBeVisible();
  expect(screen.getByText('LF', { exact: true })).toBeVisible();
  expect(document.querySelector('.file-review script')).toBeNull();
  await user.click(screen.getByRole('button', { name: '检查当前状态 mock.txt' }));
  expect(await screen.findByText('当前文件已改变')).toBeVisible();
  expect(invoke).toHaveBeenCalledWith({
    type: 'files.review.current',
    query: { scope, revision: 1, area: 'task', path: 'mock.txt' },
  });
  expect(screen.getByText('CRLF')).toBeVisible();
});

it('discards reads after close and keeps unsupported services quiet', async () => {
  const unavailable = bridge(() => page(), false);
  const first = render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  expect(await screen.findByRole('button', { name: '文件审阅' })).toBeDisabled();
  expect(unavailable.mock.calls.map(([command]) => command.type)).toEqual(['status']);
  first.unmount();
  let finish: (value: unknown) => unknown = () => {};
  let count = 0;
  const invoke = bridge(() =>
    ++count === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : {
          ...page(2),
          state: 'expired',
          items: [],
          counts: { created: 0, modified: 0, deleted: 0, unchanged: 0, unknown: 0 },
        },
  );
  render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name: '文件审阅' });
  await user.click(trigger);
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  expect(await screen.findByText('文件证据已过期。工作文件不受影响。')).toBeVisible();
  await act(async () => finish(page()));
  expect(screen.queryByText('证据版本 #1')).not.toBeInTheDocument();
  expect(
    invoke.mock.calls.some(([command]) => ['task.stop', 'task.start'].includes(command.type)),
  ).toBe(false);
});

it('rejects a different revision on the next page and refreshes as one report', async () => {
  const invoke = bridge((command) =>
    command.type === 'files.review.read' && command.query.cursor
      ? page(2)
      : { ...page(), next: 'mock_cursor' },
  );
  render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '文件审阅' }));
  await user.click(await screen.findByRole('button', { name: '读取下一页文件' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('文件证据版本已不可用，请刷新。');
  expect(screen.getByText('证据版本 #1')).toBeVisible();
  expect(invoke).toHaveBeenCalledWith({
    type: 'files.review.read',
    query: { scope, cursor: 'mock_cursor' },
  });
});

it('joins a sorted same-revision page regardless of JSON count key order', async () => {
  bridge((command) => {
    const first = {
      ...page(),
      counts: { created: 0, modified: 2, deleted: 0, unchanged: 0, unknown: 0 },
      next: 'mock_cursor',
    };
    if (command.type !== 'files.review.read' || !command.query.cursor) return first;
    return {
      ...page(),
      counts: { unknown: 0, unchanged: 0, deleted: 0, modified: 2, created: 0 },
      items: [
        {
          before: { ...present, path: 'mockz.txt', sha256: 'a'.repeat(64) },
          after: { ...present, path: 'mockz.txt', sha256: 'b'.repeat(64) },
          kind: 'modified',
        },
      ],
    };
  });
  render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '文件审阅' }));
  await user.click(await screen.findByRole('button', { name: '读取下一页文件' }));
  expect(await screen.findByRole('heading', { name: 'mockz.txt' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'mock.txt' })).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('refreshes all evidence together and ignores a late prior revision', async () => {
  let finish: (value: unknown) => unknown = () => {};
  let reads = 0;
  bridge(() =>
    ++reads === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : page(2),
  );
  render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '文件审阅' }));
  await user.click(screen.getByRole('button', { name: '刷新证据' }));
  expect(await screen.findByText('证据版本 #2')).toBeVisible();
  await act(async () => finish(page(1)));
  expect(screen.queryByText('证据版本 #1')).not.toBeInTheDocument();
});

it('shows partial coverage and binary reasons without claiming no changes', async () => {
  bridge((command) =>
    command.type === 'files.review.diff'
      ? { ...command.query, state: 'unavailable', reason: 'binary' }
      : {
          ...page(),
          items: [
            {
              before: { ...present, text: false, sha256: 'a'.repeat(64) },
              after: { ...present, text: false, sha256: 'b'.repeat(64) },
              kind: 'modified',
            },
          ],
          counts: { created: 0, modified: 1, deleted: 0, unchanged: 0, unknown: 0 },
        },
  );
  render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '文件审阅' }));
  await user.click(await screen.findByRole('button', { name: '查看差异 mock.txt' }));
  expect(await screen.findByText('二进制文件没有文本差异')).toBeVisible();
  expect(screen.queryByText('所选范围内未观察到变化。')).not.toBeInTheDocument();
});

it('keeps a concrete evidence failure visible in an unavailable report', async () => {
  bridge(() => ({
    ...page(),
    state: 'unavailable',
    reasons: ['corrupt'],
    items: [],
    counts: { created: 0, modified: 0, deleted: 0, unchanged: 0, unknown: 0 },
  }));
  render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '文件审阅' }));
  expect(await screen.findByText('证据损坏或校验失败')).toBeVisible();
});

it('retires an open report when the task scope changes and ignores its late response', async () => {
  const nextScope = { ...scope, runId: 'mock-next-run' };
  let finish: (value: unknown) => unknown = () => {};
  const invoke = bridge((command) =>
    command.type === 'files.review.read' && command.query.scope.runId === scope.runId
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { ...page(2), scope: nextScope },
  );
  const rendered = render(
    <RuntimeProvider>
      <FileReview scope={scope} />
    </RuntimeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '文件审阅' }));
  rendered.rerender(
    <RuntimeProvider>
      <FileReview scope={nextScope} />
    </RuntimeProvider>,
  );
  expect(screen.queryByRole('dialog', { name: '文件审阅' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '文件审阅' }));
  expect(await screen.findByText('证据版本 #2')).toBeVisible();
  await act(async () => finish(page()));
  expect(screen.queryByText('证据版本 #1')).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith({ type: 'files.review.read', query: { scope: nextScope } });
});
