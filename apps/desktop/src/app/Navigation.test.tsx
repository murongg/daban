import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { demoState } from '../test/fixtures';
import { appAction, workspaceTab } from '../test/navigation.fixture';
import { App } from './App';
import { serialize, storageKey } from './storage';

beforeEach(() => {
  const state = demoState();
  state.panel = null;
  localStorage.setItem(storageKey, serialize(state));
});

it('switches the whole area to the right of the navigation rail', async () => {
  render(<App />);
  const rail = within(screen.getByRole('navigation', { name: '主导航' }));
  const chats = rail.getByRole('button', { name: '对话' });
  const tasks = rail.getByRole('button', { name: '任务' });
  const inbox = rail.getByRole('button', { name: '收件箱 · 2 项待处理' });
  const gallery = rail.getByRole('button', { name: 'Bot 广场' });
  const settings = rail.getByRole('button', { name: '设置' });
  const titlebar = within(screen.getByRole('banner'));

  expect(rail.getByRole('button', { name: '收起会话列表' })).toBeVisible();
  expect(titlebar.getByRole('heading', { name: '研究员', level: 1 })).toBeVisible();
  expect(titlebar.queryByRole('button', { name: '新建 Bot' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '添加 Bot' })).toBeVisible();
  expect(chats).toHaveTextContent(/^$/);
  expect(inbox).toHaveTextContent(/^2$/);
  chats.focus();
  await userEvent.tab();
  expect(tasks).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(chats).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(chats).toHaveAttribute('aria-current', 'page');
  expect(titlebar.getByRole('heading', { name: '新对话' })).toHaveAccessibleDescription(
    '普通对话 · 可使用工具',
  );
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'synthetic-nav-draft');
  for (const [button, heading] of [
    [tasks, '任务'],
    [inbox, '收件箱'],
    [gallery, 'Bot 广场'],
    [settings, '设置'],
  ] as const) {
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-current', 'page');
    expect(chats).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('searchbox', { name: '搜索 Bot 和对话' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: '调整侧栏宽度' })).not.toBeInTheDocument();
    expect(titlebar.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
  expect(within(screen.getByRole('main')).getByRole('tablist', { name: '设置分类' })).toBeVisible();
  await userEvent.click(chats);
  expect(screen.getByRole('searchbox', { name: '搜索 Bot 和对话' })).toBeVisible();
  expect(screen.getByRole('separator', { name: '调整侧栏宽度' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('synthetic-nav-draft');
});

it('collapses the conversation list and reopens it from the search shortcut', async () => {
  render(<App />);
  const rail = within(screen.getByRole('navigation', { name: '主导航' }));
  const collapse = rail.getByRole('button', { name: '收起会话列表' });
  await userEvent.click(collapse);
  expect(rail.getByRole('button', { name: '展开会话列表' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect(screen.getByRole('button', { name: '对话' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('searchbox', { name: '搜索 Bot 和对话' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '研究员', level: 1 })).toBeVisible();
  await userEvent.keyboard('{Control>}k{/Control}');
  const search = screen.getByRole('searchbox', { name: '搜索 Bot 和对话' });
  await waitFor(() => expect(search).toHaveFocus());
  expect(collapse).toHaveAttribute('aria-expanded', 'true');
});

it('keeps workspace destinations in one tab strip and low-frequency actions in a menu', async () => {
  render(<App />);
  const header = screen.getByRole('heading', { name: '研究员' }).closest('header')!;
  expect(within(header).getByRole('button', { name: '工作区' })).toBeVisible();
  expect(within(header).queryByRole('button', { name: '文件面板' })).not.toBeInTheDocument();
  await workspaceTab(userEvent, '资料');
  expect(screen.getByRole('tab', { name: '资料' })).toHaveAttribute('aria-selected', 'true');
  await appAction(userEvent, '编辑 Bot 资料');
  expect(screen.getByRole('dialog', { name: '编辑 Bot 资料' })).toBeVisible();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(within(header).getByRole('button', { name: '更多操作' })).toHaveFocus();
});

it('tracks the rendered sidebar width when positioning the conversation title', () => {
  let notifyResize: (() => unknown) | undefined;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: () => unknown) {}
      observe(element: Element) {
        if (element.id === 'sidebar') notifyResize = this.callback;
      }
      unobserve() {}
      disconnect() {}
    },
  );
  try {
    render(<App />);
    const sidebar = screen.getByRole('complementary', { name: '侧栏' });
    const width = vi.spyOn(sidebar, 'offsetWidth', 'get');
    const titlebar = screen.getByRole('banner');
    for (const size of [298, 350]) {
      width.mockReturnValue(size);
      act(() => {
        notifyResize?.();
      });
      expect(titlebar.style.getPropertyValue('--titlebar-sidebar-width')).toBe(`${size}px`);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

it('retains a preference draft while expanding and closing its workspace panel', async () => {
  render(<App />);
  await workspaceTab(userEvent, '记忆');
  const input = screen.getByRole('textbox', { name: '工作偏好' });
  await userEvent.clear(input);
  await userEvent.type(input, 'SYNTHETIC-PREFERENCE-DRAFT');
  await userEvent.click(screen.getByRole('button', { name: '展开面板' }));
  expect(screen.getByRole('complementary', { name: 'Bot 工作区' })).toHaveClass('expanded');
  expect(input).toHaveValue('SYNTHETIC-PREFERENCE-DRAFT');
  await userEvent.click(screen.getByRole('button', { name: '关闭工作区面板' }));
  expect(screen.getByRole('button', { name: '工作区' })).toHaveFocus();
  await workspaceTab(userEvent, '记忆');
  expect(screen.getByRole('textbox', { name: '工作偏好' })).toHaveValue(
    'SYNTHETIC-PREFERENCE-DRAFT',
  );
});
