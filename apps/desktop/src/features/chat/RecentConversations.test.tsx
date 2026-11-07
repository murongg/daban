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
