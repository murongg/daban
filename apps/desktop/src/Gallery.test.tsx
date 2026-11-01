import { disconnected, type RuntimeBridge, type RuntimeCommand } from '@daban/protocol';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import * as fixture from './fixtures';
import { Gallery } from './Gallery';
import { initialState, reduce } from './state';
import { restore, serialize, storageKey } from './storage';

beforeEach(() => localStorage.clear());
afterEach(() => Reflect.deleteProperty(window, 'daban'));

it('starts empty and restores an empty workspace without losing its settings or task draft', () => {
  const state = initialState();
  expect(state.bots).toEqual([]);
  expect(state.messages).toEqual({});
  expect(state.files).toEqual([]);
  expect(state.routines).toEqual([]);
  expect(state.approvals).toEqual([]);
  state.theme = 'dark';
  state.view = 'settings';
  expect(restore(serialize(state))).toEqual(state);
});

it('removes unchanged legacy sample records once while preserving edited and user content', () => {
  const state = reduce(fixture.demoState(), {
    type: 'create',
    id: 'mock-retained',
    name: '合成自建 Bot',
    role: '',
    color: 'mint',
  });
  delete state.sampleRevision;
  state.messages['mock-retained'] = [
    ...structuredClone(fixture.messages.research),
    { id: 'mock-real-message', role: 'user', text: 'SYNTHETIC-KEEP' },
  ];
  state.files = [
    ...structuredClone(fixture.files),
    { ...fixture.files[0], id: 'mock-kept-file', content: 'SYNTHETIC-EDIT' },
  ];
  state.routines = structuredClone(fixture.routines);
  state.approvals = structuredClone(fixture.approvals);
  state.routines[0].enabled = !state.routines[0].enabled;
  state.approvals[0].status = 'approved';
  const recovered = restore(serialize(state));
  expect(recovered.bots).toEqual(state.bots);
  expect(recovered.messages['mock-retained']).toEqual([
    { id: 'mock-real-message', role: 'user', text: 'SYNTHETIC-KEEP' },
  ]);
  expect(recovered.files.map((file) => file.id)).toEqual(['mock-kept-file']);
  expect(recovered.routines).toEqual([]);
  expect(recovered.approvals).toEqual([]);
  expect(recovered.sampleRevision).toBe(2);
});

it.each([undefined, 1] as const)(
  'cleans both shipped brand variants after sample migration revision %s without deleting edits',
  (revision) => {
    const state = fixture.demoState();
    state.sampleRevision = revision;
    const original = {
      id: 'outline',
      name: '产品介绍.md',
      kind: 'Markdown',
      size: '1.2 KB',
      modified: '今天 09:46',
      content:
        '# 产品介绍\n\n示例草稿\n\ndaban 是你的 AI 工作伙伴。把任务交给不同的 Bot，在同一个地方查看对话、电脑和文件。\n\n每位 Bot 有自己的工作空间。需要时，你可以接管电脑，完成后再交还。\n\n当前项目为客户端界面演示，模型和电脑运行环境尚未接入。',
    };
    const renamed = { ...original, content: original.content.replace('daban 是', 'Daban 是') };
    const edited = { ...original, content: 'SYNTHETIC AUTHOR EDIT' };
    state.files = [original, renamed, edited];
    const recovered = restore(serialize(state));
    expect(recovered.files).toEqual([edited]);
    expect(recovered.sampleRevision).toBe(2);
    expect(restore(serialize(recovered))).toEqual(recovered);
  },
);

it('keeps shipped migration matching independent of mutable preview data', () => {
  const state = fixture.demoState();
  delete state.sampleRevision;
  const original = fixture.files.find((file) => file.id === 'notes')!;
  const content = original.content;
  try {
    original.content = 'SYNTHETIC FUTURE PREVIEW COPY';
    expect(restore(serialize(state)).files.some((file) => file.id === 'notes')).toBe(false);
  } finally {
    original.content = content;
  }
});

it('opens an empty workspace, searches presets, edits a preset and creates a fresh Bot without a desktop', async () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: '从第一位搭档开始' })).toBeVisible();
  expect(
    within(screen.getByRole('navigation', { name: 'Bot 列表' })).queryAllByRole('button'),
  ).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '逛逛 Bot 广场' }));
  expect(screen.getByRole('heading', { name: 'Bot 广场' })).toBeVisible();
  await userEvent.type(screen.getByRole('searchbox', { name: '搜索预设 Bot' }), '研究');
  expect(screen.getByRole('button', { name: '查看 研究员' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '查看 写作搭档' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '查看 研究员' }));
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: '使用这个 Bot' }),
  );
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('textbox', { name: '名称' })).toHaveValue('研究员');
  expect(within(dialog).getByRole('textbox', { name: '职责' })).not.toHaveValue('');
  await userEvent.clear(within(dialog).getByRole('textbox', { name: '名称' }));
  await userEvent.type(within(dialog).getByRole('textbox', { name: '名称' }), '合成研究搭子');
  await userEvent.click(within(dialog).getByRole('button', { name: '创建 Bot' }));
  expect(screen.getByRole('heading', { name: '合成研究搭子' })).toBeVisible();
  const saved = restore(localStorage.getItem(storageKey));
  expect(saved.bots).toHaveLength(1);
  expect(saved.bots[0].id).not.toBe('research');
  expect(saved.bots[0].id).toMatch(/^[a-f0-9-]{36}$/);
  expect(saved.messages[saved.bots[0].id]).toEqual([]);
  expect(screen.queryByRole('complementary', { name: 'Bot 工作区' })).not.toBeInTheDocument();
});

it('does not register default Bots on startup and preserves a preset form after registration fails', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 38;
  const invoke = vi.fn(async (command: RuntimeCommand) =>
    command.type === 'bot.register'
      ? { ok: false as const, error: 'BOT_PROFILE_CONFLICT' }
      : { ok: true as const, value: snapshot },
  );
  const bridge = { invoke, subscribe: () => () => {} } as RuntimeBridge;
  Object.defineProperty(window, 'daban', { configurable: true, value: { runtime: bridge } });
  render(<App />);
  await act(async () => {});
  expect(invoke.mock.calls.some(([command]) => command.type === 'bot.register')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Bot 广场' }));
  await userEvent.click(screen.getByRole('button', { name: '查看 写作搭档' }));
  await userEvent.click(screen.getByRole('button', { name: '使用这个 Bot' }));
  await userEvent.click(screen.getByRole('button', { name: '创建 Bot' }));
  expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('写作搭档');
  expect(screen.getByRole('alert')).toBeVisible();
  expect(restore(localStorage.getItem(storageKey)).bots).toEqual([]);
});

it('opens existing active profiles from an empty client without selecting archived profiles', () => {
  const profile = {
    id: 'mock-existing',
    name: '合成已存 Bot',
    instructions: '',
    memory: '',
    color: 'mint' as const,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const archived = reduce(initialState(), {
    type: 'profiles',
    profiles: [{ ...profile, archived: true }],
  });
  expect(archived.selected).toBe('');
  const active = reduce(archived, { type: 'profiles', profiles: [{ ...profile, revision: 2 }] });
  expect(active.selected).toBe(profile.id);
});

it('supports keyboard detail dismissal and focuses the preset creation form', async () => {
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: 'Bot 广场' }));
  const trigger = screen.getByRole('button', { name: '查看 通用助手' });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('dialog', { name: '通用助手' })).toBeVisible();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await userEvent.click(screen.getByRole('button', { name: '使用这个 Bot' }));
  expect(screen.getByRole('textbox', { name: '名称' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
});

it('keeps dialog keyboard focus when the surrounding runtime refreshes', async () => {
  const view = render(<Gallery onUsePreset={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: '查看 通用助手' }));
  const useButton = screen.getByRole('button', { name: '使用这个 Bot' });
  useButton.focus();
  view.rerender(<Gallery onUsePreset={() => {}} />);
  expect(useButton).toHaveFocus();
});
