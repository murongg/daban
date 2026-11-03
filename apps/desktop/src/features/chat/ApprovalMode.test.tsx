import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ApprovalMode } from './ApprovalMode';

it('selects among three explained policies and dismisses with Escape', async () => {
  const change = vi.fn();
  render(<ApprovalMode value="auto" onChange={change} />);
  const trigger = screen.getByRole('button', { name: /审批模式/ });
  expect(trigger).toHaveTextContent('帮我批准');
  await userEvent.click(trigger);
  expect(screen.getAllByRole('option')).toHaveLength(3);
  await userEvent.click(screen.getByRole('option', { name: /^完全访问权限/ }));
  expect(change).toHaveBeenCalledWith('full');
  await userEvent.click(trigger);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});
