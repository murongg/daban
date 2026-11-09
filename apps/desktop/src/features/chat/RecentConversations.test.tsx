import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { demoState } from '../../test/fixtures';
import { RecentConversations } from './RecentConversations';

it('exposes a new-chat button beside the recent-conversations title, including an empty list', async () => {
  const state = demoState();
  state.selected = '';
  state.messages = {};
  const onNewChat = vi.fn();
  render(
    <RecentConversations
      state={state}
      dispatch={vi.fn()}
      query=""
      close={vi.fn()}
      onNewChat={onNewChat}
    />,
  );
  const section = screen.getByRole('region', { name: '最近对话' });
  await userEvent.click(within(section).getByRole('button', { name: '新增对话' }));
  expect(onNewChat).toHaveBeenCalledTimes(1);
});

it('shows five recent conversations, with keyboard access to the rest', async () => {
  const state = demoState();
  state.messages = {
    [state.selected]: Array.from({ length: 7 }, (_, revision) => ({
      id: `mock-message-${revision}`,
      role: 'user',
      text: `合成对话 ${revision}`,
      chatRevision: revision,
    })),
  };
  const user = userEvent.setup();
  render(<RecentConversations state={state} dispatch={vi.fn()} query="" close={vi.fn()} />);

  const list = within(screen.getByRole('navigation', { name: '最近对话列表' }));
  const titles = () => list.getAllByRole('button', { name: /^合成对话/ });
  expect(titles()).toHaveLength(5);
  expect(list.queryByRole('button', { name: /^合成对话 1/ })).not.toBeInTheDocument();

  const toggle = list.getByRole('button', { name: '展开显示', expanded: false });
  await user.click(toggle);
  expect(titles()).toHaveLength(7);
  expect(list.getByRole('button', { name: '收起', expanded: true })).toHaveFocus();
  await user.tab();
  expect(list.getByRole('button', { name: /^合成对话 1/ })).toHaveFocus();
  await user.tab({ shift: true });
  await user.keyboard('{Enter}');

  expect(titles()).toHaveLength(5);
  expect(toggle).toHaveFocus();
});

it('searches all recent conversations without folding matching rows', () => {
  const state = demoState();
  state.messages = {
    [state.selected]: Array.from({ length: 7 }, (_, revision) => ({
      id: `mock-message-${revision}`,
      role: 'user',
      text: `合成结果 ${revision}`,
      chatRevision: revision,
    })),
  };
  render(
    <RecentConversations state={state} dispatch={vi.fn()} query=" 合成结果 " close={vi.fn()} />,
  );

  const list = within(screen.getByRole('navigation', { name: '最近对话列表' }));
  expect(list.getAllByRole('button', { name: /^合成结果/ })).toHaveLength(7);
  expect(list.queryByRole('button', { name: '展开显示' })).not.toBeInTheDocument();
});
