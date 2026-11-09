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

it('previews color and expression independently and saves them for the new Bot', async () => {
  const persist = vi.fn(async () => ({}));
  const dispatch = vi.fn();
  render(
    <Create
      state={demoState()}
      dispatch={dispatch}
      close={vi.fn()}
      notify={vi.fn()}
      persist={persist}
    />,
  );
  const expressions = screen.getByRole('group', { name: '表情' });
  expect(within(expressions).getAllByRole('button')).toHaveLength(12);
  await userEvent.click(within(expressions).getByRole('button', { name: '爱心眼' }));
  expect(screen.getByRole('img', { name: '头像预览：淡紫，爱心眼' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '蓝色' }));
  await userEvent.click(screen.getByRole('button', { name: '眨眼' }));
  expect(screen.getByRole('img', { name: '头像预览：蓝色，眨眼' })).toBeVisible();
  expect(screen.getByRole('button', { name: '蓝色' })).toHaveAttribute('aria-pressed', 'true');

  await userEvent.type(screen.getByRole('textbox', { name: '名称' }), 'Synthetic Bot');
  await userEvent.click(screen.getByRole('button', { name: '创建 Bot' }));

  expect(persist).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Synthetic Bot', color: 'blue' }),
  );
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'avatar-expression', expression: 'wink' }),
  );
});
