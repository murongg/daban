import {
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
  type Schedule,
  type ScheduleInput,
} from '@daban/protocol';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { parseCommand } from '../electron/ipc';
import { App } from './App';

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
) {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 6;
  snapshot.model.configured = true;
  snapshot.schedules = { available: true, items };
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
  await userEvent.click(screen.getByRole('tab', { name: '定时' }));
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
  await userEvent.click(screen.getByRole('tab', { name: '定时' }));
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
  await userEvent.click(screen.getByRole('tab', { name: '定时' }));
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
  await userEvent.click(screen.getByRole('tab', { name: '定时' }));
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
  await userEvent.click(screen.getByRole('tab', { name: '定时' }));
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
  await userEvent.click(screen.getByRole('tab', { name: '定时' }));
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
