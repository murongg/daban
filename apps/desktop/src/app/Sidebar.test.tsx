import { beforeEach as seedBeforeEach } from 'vitest';
import { demoState as seedDemoState } from '../test/fixtures';
import { serialize as seedSerialize, storageKey as seedStorageKey } from './storage';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { expect, it, vi } from 'vitest';
import { mockViewport } from '../test/viewport';
import { App } from './App';
import { Sidebar } from './Sidebar';
import { restore, storageKey } from './storage';

it.each([
  ['win32', 'MacIntel', 'Ctrl K'],
  ['darwin', 'Win32', '⌘ K'],
  [undefined, 'Win32', 'Ctrl K'],
  [undefined, 'MacIntel', '⌘ K'],
  [undefined, 'Linux x86_64', 'Ctrl K'],
])('shows the search modifier for desktop %s and browser %s', (platform, browser, shortcut) => {
  const original = Object.getOwnPropertyDescriptor(window, 'daban');
  const browserPlatform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(browser);
  if (platform) Object.defineProperty(window, 'daban', { configurable: true, value: { platform } });
  else Reflect.deleteProperty(window, 'daban');
  try {
    render(
      <Sidebar
        state={seedDemoState()}
        dispatch={vi.fn()}
        query=""
        setQuery={vi.fn()}
        searchRef={createRef<HTMLInputElement>()}
        onCreate={vi.fn()}
        open
        close={vi.fn()}
      />,
    );
    expect(screen.getByText(shortcut, { selector: 'kbd' })).toBeVisible();
  } finally {
    browserPlatform.mockRestore();
    if (original) Object.defineProperty(window, 'daban', original);
    else Reflect.deleteProperty(window, 'daban');
  }
});

it('windows a large Bot collection without mounting every row', () => {
  const restoreViewport = mockViewport();
  try {
    const state = seedDemoState();
    state.bots = Array.from({ length: 1000 }, (_, index) => ({
      ...state.bots[0]!,
      id: `mock-bot-${index}`,
      name: `SYNTHETIC BOT ${index}`,
      role: 'SYNTHETIC ROLE',
    }));
    render(
      <Sidebar
        state={state}
        dispatch={vi.fn()}
        query=""
        setQuery={vi.fn()}
        searchRef={createRef<HTMLInputElement>()}
        onCreate={vi.fn()}
        open
        close={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole('button', { name: /^SYNTHETIC BOT/ }).length).toBeLessThan(80);
  } finally {
    restoreViewport();
  }
});

it('does not scan retained message bodies until a sidebar search is requested', () => {
  const state = seedDemoState();
  const read = vi.fn(() => 'SYNTHETIC SEARCH BODY');
  Object.defineProperty(state.messages.research[0]!, 'text', { get: read });
  const props = {
    state,
    dispatch: vi.fn(),
    setQuery: vi.fn(),
    searchRef: createRef<HTMLInputElement>(),
    onCreate: vi.fn(),
    open: true,
    close: vi.fn(),
  };
  const view = render(<Sidebar {...props} query="" />);
  expect(read).not.toHaveBeenCalled();
  view.rerender(<Sidebar {...props} query="synthetic search body" />);
  expect(read).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '研究员' })).toBeVisible();
});

it('pins a Bot through row actions without changing the selected conversation or its draft', async () => {
  render(<App />);
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'MOCK-SIDEBAR-DRAFT');
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '整理 写作搭档' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '置顶' }));
  expect(within(nav).getByRole('group', { name: '置顶' })).toBeVisible();
  expect(within(nav).getAllByRole('button', { name: '写作搭档' })).toHaveLength(1);
  expect(screen.getByRole('heading', { name: '研究员' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('MOCK-SIDEBAR-DRAFT');
});

it('creates a section, preserves pin membership, searches collapsed rows and removes only the section', async () => {
  render(<App />);
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(screen.getByRole('button', { name: '新建分组' }));
  const dialog = screen.getByRole('dialog', { name: '新建分组' });
  await userEvent.type(within(dialog).getByRole('textbox', { name: '分组名称' }), '合成项目');
  await userEvent.click(within(dialog).getByRole('button', { name: '创建分组' }));
  await userEvent.click(within(nav).getByRole('button', { name: '整理 写作搭档' }));
  expect(
    screen.getByRole('menuitemradio', { name: '移出自定义分组', checked: true }),
  ).toBeVisible();
  expect(screen.getByRole('menuitem', { name: '置顶' })).not.toHaveAttribute('aria-checked');
  await userEvent.click(
    screen.getByRole('menuitemradio', { name: '移到 合成项目', checked: false }),
  );
  const section = within(nav).getByRole('group', { name: '合成项目' });
  expect(within(section).getByRole('button', { name: '写作搭档' })).toBeVisible();
  await userEvent.click(within(section).getByRole('button', { name: '整理 写作搭档' }));
  expect(screen.getByRole('menuitemradio', { name: '移到 合成项目', checked: true })).toBeVisible();
  expect(
    screen.getByRole('menuitemradio', { name: '移出自定义分组', checked: false }),
  ).toBeVisible();
  await userEvent.keyboard('{Escape}');
  await userEvent.click(within(section).getByRole('button', { name: '收起 合成项目' }));
  expect(within(section).queryByRole('button', { name: '写作搭档' })).not.toBeInTheDocument();
  const search = screen.getByRole('searchbox', { name: '搜索 Bot 和对话' });
  await userEvent.type(search, '写作');
  expect(within(section).getByRole('button', { name: '写作搭档' })).toBeVisible();
  await userEvent.clear(search);
  expect(within(section).queryByRole('button', { name: '写作搭档' })).not.toBeInTheDocument();
  await userEvent.click(within(section).getByRole('button', { name: '整理分组 合成项目' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '移除分组' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: '移除分组' })).getByRole('button', {
      name: '确认移除',
    }),
  );
  expect(within(nav).queryByRole('group', { name: '合成项目' })).not.toBeInTheDocument();
  expect(within(nav).getByRole('button', { name: '写作搭档' })).toBeVisible();
  expect(restore(localStorage.getItem(storageKey)).bots.some((bot) => bot.id === 'writer')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: '新建分组' })).toHaveFocus();
});

it('supports keyboard dismissal and keeps a manual unread mark until that conversation is selected', async () => {
  render(<App />);
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  const trigger = within(nav).getByRole('button', { name: '整理 写作搭档' });
  await userEvent.click(trigger);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: 'Bot 工作区' })).toBeVisible();
  expect(trigger).toHaveFocus();
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole('menuitem', { name: '标为未读' }));
  expect(screen.getByRole('status', { name: '写作搭档有未读消息' })).toBeVisible();
  await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
  expect(screen.queryByRole('status', { name: '写作搭档有未读消息' })).not.toBeInTheDocument();
});

it('keeps section-editor input and its underlying conversation while global shortcuts are pressed', async () => {
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: '新建分组' }));
  const dialog = screen.getByRole('dialog', { name: '新建分组' });
  const name = within(dialog).getByRole('textbox', { name: '分组名称' });
  await userEvent.type(name, 'MOCK-SECTION-DRAFT');
  await userEvent.keyboard('{Control>},{/Control}');
  expect(name).toHaveValue('MOCK-SECTION-DRAFT');
  expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.getByRole('heading', { name: '研究员', level: 1 })).toBeVisible();
});

it('dismisses row actions when a global shortcut opens another view', async () => {
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: '整理 写作搭档' }));
  await userEvent.keyboard('{Control>},{/Control}');
  expect(screen.getByRole('dialog', { name: '设置' })).toBeVisible();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});
