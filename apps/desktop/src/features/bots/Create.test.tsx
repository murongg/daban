import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { demoState } from '../../test/fixtures';
import { Create } from './Create';

vi.mock('../../app/Runtime', () => ({
  runtimeError: (error: Error) => error.message,
  useRuntime: () => ({
    enabled: true,
    snapshot: {
      phase: 'ready',
      protocolVersion: 27,
      model: { model: 'deepseek-flash', connections: [] },
    },
  }),
}));

it('navigates creation tabs with one tab stop and labelled panels while retaining the draft', async () => {
  render(
    <Create
      state={demoState()}
      dispatch={vi.fn()}
      close={vi.fn()}
      notify={vi.fn()}
      onImport={vi.fn()}
    />,
  );
  const tabs = screen.getByRole('tablist', { name: '创建类型' });
  const bot = within(tabs).getByRole('tab', { name: '新建 Bot' });
  const group = within(tabs).getByRole('tab', { name: '创建群聊' });
  expect(bot).toHaveAttribute('tabindex', '0');
  expect(group).toHaveAttribute('tabindex', '-1');
  await userEvent.type(screen.getByRole('textbox', { name: '名称' }), 'Synthetic draft');
  bot.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(group).toHaveFocus();
  expect(group).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: '创建群聊' })).toHaveAttribute(
    'id',
    group.getAttribute('aria-controls'),
  );
  expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('Synthetic draft');
  await userEvent.keyboard('{Home}');
  expect(bot).toHaveFocus();
  expect(screen.getByRole('tabpanel', { name: '新建 Bot' })).toHaveAttribute(
    'aria-labelledby',
    bot.id,
  );
  await userEvent.keyboard('{ArrowLeft}');
  expect(group).toHaveFocus();
  await userEvent.keyboard('{Home}{End}');
  expect(group).toHaveFocus();
});

it('keeps importing as an action outside the creation tablist', async () => {
  const onImport = vi.fn();
  render(
    <Create
      state={demoState()}
      dispatch={vi.fn()}
      close={vi.fn()}
      notify={vi.fn()}
      onImport={onImport}
    />,
  );
  expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(2);
  const action = screen.getByRole('button', { name: '从文件导入' });
  expect(screen.getByRole('tablist')).not.toContainElement(action);
  await userEvent.click(action);
  expect(onImport).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('tab', { name: '新建 Bot' })).toHaveAttribute('aria-selected', 'true');
});
