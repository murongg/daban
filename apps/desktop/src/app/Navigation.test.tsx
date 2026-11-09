import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { demoState } from '../test/fixtures';
import { appAction, workspaceTab } from '../test/navigation.fixture';
import { App } from './App';
import { serialize, storageKey } from './storage';

beforeEach(() => {
  const state = demoState();
  state.panel = null;
  localStorage.setItem(storageKey, serialize(state));
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
