import {
  type DeliveryPage,
  disconnected,
  managedProtocol,
  type RuntimeCommand,
  type WorkItem,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { useRuntime } from '../../app/Runtime';
import { Delivery } from './Delivery';

const live = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof useRuntime> }));
vi.mock('../../app/Runtime', async (original) => ({
  ...(await original<typeof import('../../app/Runtime')>()),
  useRuntime: () => live.current,
}));
const item: WorkItem = {
  id: 'mock-work',
  revision: 1,
  title: 'Synthetic task',
  description: '',
  progress: '',
  status: 'todo',
  assignee: 'mock-bot',
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: { kind: 'human' },
  updatedBy: { kind: 'human' },
};
function fixture() {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = managedProtocol;
  snapshot.delivery = true;
  snapshot.profiles = [
    {
      id: 'mock-bot',
      name: 'Synthetic Bot',
      instructions: '',
      memory: '',
      color: 'mint',
      revision: 1,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    },
  ];
  let page: DeliveryPage = {
    workId: item.id,
    checklist: { workId: item.id, revision: 0, items: [] },
    attempts: [],
  };
  let lost = false;
  const call = vi.fn(async (command: RuntimeCommand): Promise<unknown> => {
    if (command.type === 'delivery.get') return structuredClone(page);
    if (command.type === 'work.read') return item;
    if (
      command.type === 'delivery.checklist.write' ||
      command.type === 'delivery.checklist.receipt'
    ) {
      if (command.type === 'delivery.checklist.write') {
        page = {
          ...page,
          checklist: { workId: item.id, revision: 1, items: command.request.items },
        };
        if (lost) throw new Error('MOCK_LOST_REPLY');
      }
      return { state: 'complete', request: command.request, checklist: page.checklist };
    }
    throw new Error('MOCK_UNEXPECTED_COMMAND');
  });
  live.current = {
    ...live.current,
    enabled: true,
    snapshot,
    command: async <T,>(command: RuntimeCommand) => (await call(command)) as T,
  };
  return {
    call,
    loseReply: () => {
      lost = true;
    },
    page: () => page,
  };
}
beforeEach(() => {
  localStorage.clear();
});

test('editing and saving a checklist never starts a model and the draft survives leaving the panel', async () => {
  const f = fixture();
  const view = render(<Delivery item={item} observe={() => {}} />);
  await waitFor(() =>
    expect(f.call).toHaveBeenCalledWith({ type: 'delivery.get', query: { workId: item.id } }),
  );
  await userEvent.click(screen.getByRole('button', { name: '添加验收项' }));
  await userEvent.type(screen.getByRole('textbox', { name: '验收项 1' }), 'Synthetic criterion');
  view.unmount();
  render(<Delivery item={item} observe={() => {}} />);
  expect(screen.getByRole('textbox', { name: '验收项 1' })).toHaveValue('Synthetic criterion');
  await userEvent.click(screen.getByRole('button', { name: '保存验收清单' }));
  await waitFor(() => expect(f.page().checklist.revision).toBe(1));
  expect(
    f.call.mock.calls.filter(([command]) => command.type === 'delivery.checklist.write'),
  ).toHaveLength(1);
  expect(
    f.call.mock.calls.some(
      ([command]) => command.type === 'delivery.start' || command.type === 'task.start',
    ),
  ).toBe(false);
});

test('a lost save reply seals the original request across remount and queries its receipt without resending', async () => {
  const f = fixture();
  f.loseReply();
  const view = render(<Delivery item={item} observe={() => {}} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '添加验收项' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: '添加验收项' }));
  await userEvent.type(screen.getByRole('textbox', { name: '验收项 1' }), 'Synthetic criterion');
  await userEvent.click(screen.getByRole('button', { name: '保存验收清单' }));
  await screen.findByRole('button', { name: '查询原请求回执' });
  view.unmount();
  render(<Delivery item={item} observe={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: '查询原请求回执' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '查询原请求回执' })).toBeNull());
  const writes = f.call.mock.calls.filter(
    ([command]) => command.type === 'delivery.checklist.write',
  );
  const receipts = f.call.mock.calls.filter(
    ([command]) => command.type === 'delivery.checklist.receipt',
  );
  expect(writes).toHaveLength(1);
  expect(receipts).toHaveLength(1);
  expect('request' in writes[0][0] && 'request' in receipts[0][0] && writes[0][0].request).toEqual(
    'request' in receipts[0][0] && receipts[0][0].request,
  );
});

test('late card responses cannot replace a different card after closing its panel', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => unknown;
  f.call.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<Delivery key={item.id} item={item} observe={() => {}} />);
  view.rerender(
    <Delivery key="mock-other" item={{ ...item, id: 'mock-other' }} observe={() => {}} />,
  );
  await act(async () =>
    resolve({
      workId: item.id,
      checklist: {
        workId: item.id,
        revision: 1,
        items: [
          { id: 'mock-secret', text: 'Synthetic stale criterion', kind: 'text', required: true },
        ],
      },
      attempts: [],
    }),
  );
  expect(
    within(screen.getByRole('region', { name: '执行与交付' })).queryByText(
      'Synthetic stale criterion',
    ),
  ).toBeNull();
});

function attempt() {
  return {
    attemptId: 'mock-attempt',
    workId: item.id,
    requestId: 'mock-request',
    sequence: 1,
    revision: 1,
    workRevision: 1,
    ownershipRevision: 1,
    bot: 'mock-bot',
    title: item.title,
    description: '',
    checklist: { workId: item.id, revision: 0, items: [] },
    phase: 'ready' as const,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    runId: 'mock-run',
    error: '',
    results: [],
    outputs: [],
    evidence: [],
    groups: [],
  };
}

test('empty-checklist acceptance needs explicit confirmation again after a delivery version changes', async () => {
  const f = fixture();
  f.page().attempts.push(attempt());
  render(<Delivery item={item} observe={() => {}} />);
  const accept = await screen.findByRole('button', { name: '接受交付' });
  expect(accept).toBeDisabled();
  await userEvent.click(
    screen.getByRole('checkbox', { name: '我已核对本次结果和产物版本，确认以下决定。' }),
  );
  expect(accept).toBeEnabled();
  f.page().attempts[0].revision++;
  await userEvent.click(screen.getByRole('button', { name: '查询执行结果' }));
  await screen.findByText('交付版本 2', { exact: false });
  expect(accept).toBeDisabled();
});

test('pending approvals reuse the existing request renderer for only this attempt run', async () => {
  const f = fixture();
  f.page().attempts.push({ ...attempt(), phase: 'running' });
  live.current.snapshot.interactions = [
    {
      id: 'mock-owned-approval',
      sessionId: 'mock-session',
      bot: 'mock-bot',
      runId: 'mock-run',
      status: 'pending',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    },
    {
      id: 'mock-other-approval',
      sessionId: 'mock-other-session',
      bot: 'mock-other',
      runId: 'mock-other-run',
      status: 'pending',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    },
  ];
  const renderRequests = vi.fn(() => <p>Synthetic owned approval controls</p>);
  render(<Delivery item={item} observe={() => {}} {...{ renderRequests }} />);
  await screen.findByText('Synthetic owned approval controls');
  expect(renderRequests).toHaveBeenLastCalledWith(['mock-run']);
});

test('accepted history displays the recorded checks without asking to review a historical revision again', async () => {
  const f = fixture();
  const criteria = [
    {
      id: 'mock-text',
      text: 'Synthetic accepted criterion',
      kind: 'text' as const,
      required: true,
    },
  ];
  const checklist = { workId: item.id, revision: 1, items: criteria };
  f.page().checklist = checklist;
  f.page().attempts.push({
    ...attempt(),
    checklist,
    phase: 'accepted-by-user',
    decision: {
      action: 'accept',
      checked: ['mock-text'],
      reason: '',
      at: item.updatedAt,
      criteria,
      evidence: [],
    },
  });
  render(<Delivery item={item} observe={() => {}} />);
  const checkbox = await screen.findByRole('checkbox', { name: 'Synthetic accepted criterion' });
  expect(checkbox).toBeChecked();
  expect(checkbox).toBeDisabled();
  expect(screen.queryByRole('button', { name: '重新核对当前交付版本' })).toBeNull();
});

test('incomplete checklist edits retain blank rows and other edits when the panel reopens', async () => {
  const f = fixture();
  f.page().checklist = {
    workId: item.id,
    revision: 1,
    items: [
      { id: 'mock-first', text: 'Synthetic first', kind: 'text', required: true },
      { id: 'mock-second', text: 'Synthetic second', kind: 'text', required: true },
    ],
  };
  const view = render(<Delivery item={item} observe={() => {}} />);
  await userEvent.clear(await screen.findByRole('textbox', { name: '验收项 1' }));
  await userEvent.type(screen.getByRole('textbox', { name: '验收项 2' }), ' edited');
  view.unmount();
  render(<Delivery item={item} observe={() => {}} />);
  expect(await screen.findByRole('textbox', { name: '验收项 1' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: '验收项 2' })).toHaveValue('Synthetic second edited');
  expect(screen.getByRole('button', { name: '保存验收清单' })).toBeDisabled();
});
