import { beforeEach as seedBeforeEach } from 'vitest';
import { serialize as seedSerialize, storageKey as seedStorageKey } from '../../app/storage';
import { setLocale } from '../../i18n/locale';
import { demoState as seedDemoState } from '../../test/fixtures';
import { selectControl, selectOption } from '../../test/select.fixture.ts';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
  type Schedule,
  type ScheduleInput,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { parseCommand } from '../../../electron/ipc';
import { App } from '../../app/App';
import { workspaceTab } from '../../test/navigation.fixture';
import { mockViewport } from '../../test/viewport';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function record(input: ScheduleInput): Schedule {
  return {
    ...input,
    enabled: input.enabled ?? true,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    nextRunAt: '2026-01-02T01:00:00Z',
    history: [],
  };
}
function connect(
  create?: (input: ScheduleInput) => Promise<Schedule>,
  items: Schedule[] = [],
  extra?: (command: RuntimeCommand) => Promise<RuntimeReply | undefined>,
  automation = false,
  files = false,
) {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 6;
  snapshot.model.configured = true;
  snapshot.schedules = {
    available: true,
    items,
    ...(automation ? { automation: { changes: true, files } } : {}),
  };
  const listeners = new Set<(state: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    const override = await extra?.(command);
    if (override) return override;
    if (command.type === 'schedule.preview') return { ok: true, value: ['2026-01-02T01:00:00Z'] };
    if (command.type === 'schedule.create') {
      const value = create ? await create(command.input) : record(command.input);
      snapshot = { ...snapshot, schedules: { available: true, items: [value] } };
      for (const listener of listeners) listener(snapshot);
      return { ok: true, value };
    }
    if (command.type === 'schedule.update') {
      const value = {
        ...snapshot.schedules!.items.find((item) => item.id === command.id)!,
        ...command.patch,
        revision: command.revision + 1,
      };
      snapshot = {
        ...snapshot,
        schedules: {
          available: true,
          items: snapshot.schedules!.items.map((item) => (item.id === value.id ? value : item)),
        },
      };
      for (const listener of listeners) listener(snapshot);
      return { ok: true, value };
    }
    return { ok: true, value: command.type === 'status' ? snapshot : {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (state: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return invoke;
}

it('requires a named confirmation before deleting a schedule and cancels without sending a command', async () => {
  const item = record({
    id: 'mock-delete-cancel',
    bot: 'a',
    title: '合成取消删除日程',
    prompt: 'MOCK SCHEDULE PROMPT',
    rule: { kind: 'every', everySeconds: 3600 },
  });
  const invoke = connect(undefined, [item]);
  render(<App />);
  await workspaceTab(userEvent, '定时');
  await userEvent.click(screen.getByRole('button', { name: '删除定时任务 合成取消删除日程' }));
  const dialog = screen.getByRole('dialog', { name: '删除定时任务' });
  expect(within(dialog).getByText(/合成取消删除日程/)).toBeVisible();
  expect(invoke.mock.calls.some(([command]) => command.type === 'schedule.remove')).toBe(false);
  await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog', { name: '删除定时任务' })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command.type === 'schedule.remove')).toBe(false);
});

it('deletes the captured schedule revision once and keeps confirmation controls disabled while waiting', async () => {
  const item = record({
    id: 'mock-delete-revision',
    bot: 'a',
    title: '合成版本删除日程',
    prompt: 'MOCK SCHEDULE PROMPT',
    rule: { kind: 'every', everySeconds: 3600 },
  });
  let finish!: (reply: RuntimeReply) => unknown;
  const invoke = connect(undefined, [item], async (command) =>
    command.type === 'schedule.remove'
      ? new Promise<RuntimeReply>((resolve) => (finish = resolve))
      : undefined,
  );
  render(<App />);
  await workspaceTab(userEvent, '定时');
  await userEvent.click(screen.getByRole('button', { name: '删除定时任务 合成版本删除日程' }));
  const dialog = screen.getByRole('dialog', { name: '删除定时任务' });
  // A later catalog update must not silently extend consent to a revision never reviewed.
  item.revision = 2;
  await userEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
  expect(invoke.mock.calls.filter(([command]) => command.type === 'schedule.remove')).toEqual([
    [{ type: 'schedule.remove', id: item.id, revision: 1 }],
  ]);
  expect(within(dialog).getByRole('button', { name: '确认删除' })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: '关闭对话框' })).toBeDisabled();
  await userEvent.keyboard('{Escape}');
  expect(dialog).toBeInTheDocument();
  await act(async () => finish({ ok: true, value: {} }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '删除定时任务' })).not.toBeInTheDocument(),
  );
});

it('keeps a failed deletion visible for review without replacing its captured revision', async () => {
  const item = record({
    id: 'mock-delete-conflict',
    bot: 'a',
    title: '合成冲突删除日程',
    prompt: 'MOCK SCHEDULE PROMPT',
    rule: { kind: 'every', everySeconds: 3600 },
  });
  const invoke = connect(undefined, [item], async (command) =>
    command.type === 'schedule.remove' ? { ok: false, error: 'SCHEDULE_CONFLICT' } : undefined,
  );
  render(<App />);
  await workspaceTab(userEvent, '定时');
  await userEvent.click(screen.getByRole('button', { name: '删除定时任务 合成冲突删除日程' }));
  const dialog = screen.getByRole('dialog', { name: '删除定时任务' });
  await userEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(/定时任务已更新/);
  expect(within(dialog).getByRole('button', { name: '确认删除' })).toBeEnabled();
  expect(invoke.mock.calls.filter(([command]) => command.type === 'schedule.remove')).toEqual([
    [{ type: 'schedule.remove', id: item.id, revision: 1 }],
  ]);
});

it('locks a schedule for Bot edits while retaining human management and exact backend revision', async () => {
  const item = record({
    id: 'mock-lock',
    bot: 'a',
    title: '合成锁定日程',
    prompt: '合成说明',
    rule: { kind: 'every', everySeconds: 3600 },
  });
  const invoke = connect(undefined, [item]);
  render(<App />);
  await workspaceTab(userEvent, '定时');
  await userEvent.click(screen.getByRole('button', { name: '锁定定时任务 合成锁定日程' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'schedule.update',
    id: item.id,
    revision: 1,
    patch: { locked: true },
  });
  expect(await screen.findByRole('button', { name: '解锁定时任务 合成锁定日程' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('button', { name: '编辑定时任务 合成锁定日程' })).toBeEnabled();
});

it('saves a real per-Bot schedule and preserves another Bot form while acknowledgement is delayed', async () => {
  let resolve!: (value: Schedule) => unknown;
  let submitted!: ScheduleInput;
  connect((input) => {
    submitted = input;
    return new Promise<Schedule>((done) => (resolve = done));
  });
  render(<App />);
  await workspaceTab(userEvent, '定时');
  expect(screen.queryByText('已启用 · 演示')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '新建定时任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务名称' }), '合成研究日程');
  await userEvent.type(screen.getByRole('textbox', { name: '需要 Bot 做什么' }), '只处理合成输入');
  await userEvent.click(screen.getByRole('button', { name: '保存定时任务' }));
  expect(submitted).toMatchObject({
    bot: 'a',
    title: '合成研究日程',
    prompt: '只处理合成输入',
    rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
  });
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
  await userEvent.click(screen.getByRole('button', { name: '新建定时任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务名称' }), '合成写作草稿');
  await act(async () => resolve(record(submitted)));
  expect(screen.getByRole('textbox', { name: '任务名称' })).toHaveValue('合成写作草稿');
  await userEvent.click(within(nav).getByRole('button', { name: '研究员' }));
  expect(await screen.findByText('合成研究日程')).toBeVisible();
  expect(screen.getByRole('button', { name: '立即运行 合成研究日程' })).toBeVisible();
  expect(screen.queryByRole('textbox', { name: '任务名称' })).not.toBeInTheDocument();
});

it('keeps the form usable while a timezone is incomplete', async () => {
  connect();
  render(<App />);
  await workspaceTab(userEvent, '定时');
  await userEvent.click(screen.getByRole('button', { name: '新建定时任务' }));
  await screen.findByText('接下来');
  const zone = screen.getByRole('textbox', { name: '时区' });
  await userEvent.clear(zone);
  await userEvent.type(zone, 'Invalid/Zone');
  expect(screen.getByRole('textbox', { name: '时区' })).toHaveValue('Invalid/Zone');
});

it('lets users correct a definitely rejected schedule without losing the draft or retrying invalid input', async () => {
  const backend = vi.fn(async (input: ScheduleInput) => record(input));
  const invoke = connect(backend, [], async (command) => {
    if (command.type === 'schedule.preview' || command.type === 'schedule.create') {
      try {
        parseCommand(command);
      } catch {
        return { ok: false, error: 'INVALID_COMMAND' };
      }
    }
    return undefined;
  });
  render(<App />);
  await workspaceTab(userEvent, '定时');
  await userEvent.click(screen.getByRole('button', { name: '新建定时任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务名称' }), '合成校验日程');
  await userEvent.type(screen.getByRole('textbox', { name: '需要 Bot 做什么' }), '只处理合成输入');
  await userEvent.clear(screen.getByRole('textbox', { name: '时区' }));
  await userEvent.type(screen.getByRole('textbox', { name: '时区' }), 'Invalid/Mock');
  await userEvent.click(screen.getByRole('button', { name: '保存定时任务' }));
  expect(backend).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: '时区' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: '任务名称' })).toHaveValue('合成校验日程');
  expect(screen.getByRole('textbox', { name: '需要 Bot 做什么' })).toHaveValue('只处理合成输入');
  expect(screen.queryByRole('button', { name: '核对并重试保存' })).not.toBeInTheDocument();
  expect(screen.getAllByText(/名称、任务说明或时间设置无效/)).toHaveLength(1);
  await userEvent.clear(screen.getByRole('textbox', { name: '时区' }));
  await userEvent.type(screen.getByRole('textbox', { name: '时区' }), 'Asia/Shanghai');
  await userEvent.click(screen.getByRole('button', { name: '保存定时任务' }));
  expect(backend).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('合成校验日程')).toBeVisible();
  const attempts = invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'schedule.create');
  expect(attempts).toHaveLength(2);
  expect(attempts[1].input.id).not.toBe(attempts[0].input.id);
  expect(attempts[1].input.rule).toEqual({
    kind: 'daily',
    time: '09:00',
    timeZone: 'Asia/Shanghai',
  });
});

it('reads the current backend revision on edit conflict and preserves the local draft for rebase', async () => {
  const original = record({
    id: 'mock-edit',
    bot: 'a',
    title: '合成旧任务',
    prompt: '合成说明',
    rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
  });
  const current = { ...original, title: '合成后台新任务', revision: 3 };
  let updates = 0;
  const invoke = connect(undefined, [original], async (command) => {
    if (command.type === 'schedule.update') {
      if (++updates === 1) throw new Error('SCHEDULE_CONFLICT');
      return { ok: true, value: { ...current, ...command.patch, revision: 4 } };
    }
    if (String(command.type) === 'schedule.get') return { ok: true, value: current };
    return undefined;
  });
  render(<App />);
  await workspaceTab(userEvent, '定时');
  await userEvent.click(screen.getByRole('button', { name: '编辑定时任务 合成旧任务' }));
  await userEvent.clear(screen.getByRole('textbox', { name: '任务名称' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务名称' }), '合成本地草稿');
  await userEvent.click(screen.getByRole('button', { name: '保存定时任务' }));
  expect(await screen.findByText(/后台当前版本：合成后台新任务/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: '任务名称' })).toHaveValue('合成本地草稿');
  await userEvent.click(screen.getByRole('button', { name: '保留草稿，按此版本重试' }));
  await userEvent.click(screen.getByRole('button', { name: '保存定时任务' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'schedule.update',
      revision: 3,
      patch: expect.objectContaining({ title: '合成本地草稿' }),
    }),
  );
});

it('keeps an ambiguous create payload and ID intact for an exact retry', async () => {
  let calls = 0;
  const invoke = connect(async (input) => {
    if (++calls === 1) throw new Error('RUNTIME_UNAVAILABLE');
    return record(input);
  });
  render(<App />);
  await workspaceTab(userEvent, '定时');
  await userEvent.click(screen.getByRole('button', { name: '新建定时任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务名称' }), '合成重试日程');
  await userEvent.type(screen.getByRole('textbox', { name: '需要 Bot 做什么' }), '只处理合成输入');
  await userEvent.click(screen.getByRole('button', { name: '保存定时任务' }));
  expect(await screen.findByRole('button', { name: '核对并重试保存' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: '任务名称' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '核对并重试保存' }));
  const creates = invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'schedule.create');
  expect(creates).toHaveLength(2);
  expect(creates[0]).toEqual(creates[1]);
  expect(await screen.findByText('合成重试日程')).toBeVisible();
});

it('keeps schedule rule values and instructions stable while editing in English', async () => {
  let submitted!: ScheduleInput;
  connect(async (input) => {
    submitted = input;
    return record(input);
  });
  await setLocale('en');
  render(<App />);
  await workspaceTab(userEvent, 'Schedules');
  await userEvent.click(screen.getByRole('button', { name: 'New scheduled task' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Task name' }), 'SYNTHETIC-WEEKDAY');
  await userEvent.type(
    screen.getByRole('textbox', { name: 'What should this Bot do?' }),
    'SYNTHETIC literal 设置',
  );
  await selectOption(userEvent, selectControl('Repeat'), '工作日');
  await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
  expect(submitted).toMatchObject({
    title: 'SYNTHETIC-WEEKDAY',
    prompt: 'SYNTHETIC literal 设置',
    rule: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:00', timeZone: 'Asia/Shanghai' },
  });
  expect(parseCommand({ type: 'schedule.create', input: submitted })).toMatchObject({
    type: 'schedule.create',
    input: submitted,
  });
});

it('retains an existing weekly rule when opening its editor in English', async () => {
  const rule = {
    kind: 'weekly' as const,
    weekdays: [2, 4],
    time: '14:30',
    timeZone: 'Asia/Shanghai',
  };
  const original = record({
    id: 'mock-weekly-locale',
    bot: 'a',
    title: 'SYNTHETIC WEEKLY',
    prompt: 'SYNTHETIC PROMPT',
    rule,
  });
  const invoke = connect(undefined, [original]);
  await setLocale('en');
  render(<App />);
  await workspaceTab(userEvent, 'Schedules');
  await userEvent.click(
    screen.getByRole('button', { name: 'Edit scheduled task SYNTHETIC WEEKLY' }),
  );
  expect(selectControl('Repeat')).toHaveAttribute('data-value', '每周');
  await userEvent.type(screen.getByRole('textbox', { name: 'Task name' }), ' UPDATED');
  await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'schedule.update',
      id: original.id,
      patch: expect.objectContaining({ title: 'SYNTHETIC WEEKLY UPDATED', rule }),
    }),
  );
});

it('bounds a large schedule list while keeping the native management controls', async () => {
  const restore = mockViewport();
  try {
    connect(
      undefined,
      Array.from({ length: 1000 }, (_, index) =>
        record({
          id: `mock-schedule-${index}`,
          bot: 'a',
          title: `SYNTHETIC SCHEDULE ${index}`,
          prompt: 'MOCK SCHEDULE PROMPT',
          rule: { kind: 'every', everySeconds: 3600 },
        }),
      ),
    );
    render(<App />);
    await workspaceTab(userEvent, '定时');
    await screen.findByText('SYNTHETIC SCHEDULE 0');
    expect(screen.queryAllByText(/^SYNTHETIC SCHEDULE/).length).toBeLessThan(80);
  } finally {
    restore();
  }
});

it('configures result monitoring separately and disables file triggers without project reads', async () => {
  const item = record({
    id: 'mock-monitored',
    bot: 'a',
    title: '合成监测',
    prompt: 'SYNTHETIC',
    rule: { kind: 'every', everySeconds: 3600 },
  });
  const invoke = connect(
    undefined,
    [item],
    async (command) =>
      command.type === 'schedule.monitor'
        ? { ok: true, value: { ...item, enabled: false, revision: 2 } }
        : undefined,
    true,
  );
  render(<App />);
  await workspaceTab(userEvent, '定时');
  expect(screen.getByRole('button', { name: '新建文件监测' })).toBeDisabled();
  await userEvent.click(screen.getByText('监测设置'));
  await userEvent.click(screen.getByRole('checkbox', { name: '仅结果变化时通知' }));
  await userEvent.type(screen.getByRole('textbox', { name: '结果信号文件' }), 'mock.txt');
  await userEvent.click(screen.getByRole('button', { name: '保存监测策略' }));
  expect(invoke.mock.calls.filter(([command]) => command.type === 'schedule.monitor')).toEqual([
    [
      {
        type: 'schedule.monitor',
        id: item.id,
        revision: 1,
        policy: { kind: 'changes', signalPath: 'mock.txt' },
      },
    ],
  ]);
  expect(
    invoke.mock.calls.some(
      ([command]) => command.type === 'schedule.run' || command.type === 'task.start',
    ),
  ).toBe(false);
});

it('keeps an orphaned unknown receipt queryable without starting or recreating its deleted rule', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 45;
  snapshot.schedules = { available: true, items: [], automation: { changes: true, files: false } };
  snapshot.notices = {
    available: true,
    items: [
      {
        kind: 'automation',
        id: 'mock-notice',
        bot: 'a',
        schedule: 'mock-deleted',
        firing: 'mock-firing',
        createdAt: '2026-01-01T00:00:00Z',
        phase: 'interrupted',
        reason: 'fault',
        code: 'SCHEDULE_OUTCOME_UNKNOWN',
      },
    ],
  };
  const invoke = connect(undefined, [], async (command) =>
    command.type === 'status'
      ? { ok: true, value: snapshot }
      : command.type === 'schedule.receipt'
        ? {
            ok: true,
            value: {
              id: 'mock-firing',
              requestId: 'mock-original',
              occurrenceAt: '2026-01-01T00:00:00Z',
              createdAt: '2026-01-01T00:00:00Z',
              state: 'interrupted',
            },
          }
        : undefined,
  );
  render(<App />);
  await workspaceTab(userEvent, '定时');
  expect(screen.getByRole('heading', { name: '执行结果待核实' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '查询原执行回执' }));
  await waitFor(() =>
    expect(invoke.mock.calls.filter(([command]) => command.type === 'schedule.receipt')).toEqual([
      [{ type: 'schedule.receipt', id: 'mock-deleted', firing: 'mock-firing' }],
    ]),
  );
  expect(
    invoke.mock.calls.some(
      ([command]) =>
        command.type === 'schedule.run' ||
        command.type === 'schedule.create' ||
        command.type === 'task.start',
    ),
  ).toBe(false);
});
