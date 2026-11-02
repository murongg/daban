import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type FormEvent, useCallback, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { FilePicker } from '../../features/files/FilePicker';
import { IconButton } from './Button';
import { DateField } from './DateField';
import { Dialog } from './Dialog';
import { NumberField } from './NumberField';
import { Select } from './Select';
import { TimeField } from './TimeField';

function NumberFixture() {
  const [value, setValue] = useState('2');
  return <NumberField label="合成数量" value={value} onValueChange={setValue} min={1} max={3} />;
}
function DecimalFixture({ submit }: { submit: (event: FormEvent<HTMLFormElement>) => unknown }) {
  const [value, setValue] = useState('2');
  return (
    <form onSubmit={submit}>
      <NumberField
        label="合成数量"
        value={value}
        onValueChange={setValue}
        min={1}
        max={3}
        required
      />
      <button type="submit">合成提交</button>
    </form>
  );
}

const options = [
  { value: 'a', label: '合成甲' },
  { value: 'b', label: '合成乙', disabled: true },
  { value: 'c', label: '合成丙' },
];

function SuspendedDialogFixture() {
  const [open, setOpen] = useState(false);
  const [child, setChild] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const closeChild = useCallback(() => setChild(false), []);
  return (
    <>
      <div id="root">
        <button type="button" onClick={() => setOpen(true)}>
          打开合成设置
        </button>
      </div>
      {open && (
        <Dialog
          title="合成设置"
          onClose={close}
          active={!child}
          className="settings-dialog-fixture"
        >
          <input aria-label="合成私有输入" />
          <div hidden>
            <button type="button">隐藏分类的按钮</button>
          </div>
          <button type="button" onClick={() => setChild(true)}>
            打开合成子弹窗
          </button>
        </Dialog>
      )}
      {child && (
        <Dialog title="合成子弹窗" onClose={closeChild}>
          <button type="button">合成子操作</button>
        </Dialog>
      )}
    </>
  );
}

it('suspends a settings dialog without losing input, then restores its focus boundary', async () => {
  render(<SuspendedDialogFixture />);
  const opener = screen.getByRole('button', { name: '打开合成设置' });
  await userEvent.click(opener);
  const parent = screen.getByRole('dialog', { name: '合成设置' });
  expect(parent).toHaveClass('settings-dialog-fixture');
  const input = screen.getByRole('textbox', { name: '合成私有输入' });
  await userEvent.type(input, 'SYNTHETIC-PRIVATE-DRAFT');
  await userEvent.click(screen.getByRole('button', { name: '打开合成子弹窗' }));
  expect(screen.queryByRole('dialog', { name: '合成设置' })).not.toBeInTheDocument();
  expect(input).toBeInTheDocument();
  expect(input).not.toBeVisible();
  expect(document.getElementById('root')).toHaveProperty('inert', true);
  expect(screen.getByRole('dialog', { name: '合成子弹窗' })).toContainElement(
    document.activeElement as HTMLElement,
  );
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '合成子弹窗' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: '合成设置' })).toBeVisible();
  expect(input).toHaveValue('SYNTHETIC-PRIVATE-DRAFT');
  expect(document.getElementById('root')).toHaveProperty('inert', true);
  expect(parent).toContainElement(document.activeElement as HTMLElement);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.getElementById('root')).toHaveProperty('inert', false);
  expect(opener).toHaveFocus();
});

it('routes Escape only to the topmost active dialog while local layer signals settle', async () => {
  const parent = vi.fn();
  const child = vi.fn();
  render(
    <>
      <Dialog title="合成底层" onClose={parent}>
        <button type="button">底层操作</button>
      </Dialog>
      <Dialog title="合成顶层" onClose={child}>
        <button type="button">顶层操作</button>
      </Dialog>
    </>,
  );
  await userEvent.keyboard('{Escape}');
  expect(parent).not.toHaveBeenCalled();
  expect(child).toHaveBeenCalledTimes(1);
});

function ReplacementFixture({ backgroundFocus }: { backgroundFocus: () => unknown }) {
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  return (
    <>
      <div id="root">
        <button type="button" onFocus={backgroundFocus} onClick={() => setFirst(true)}>
          合成入口
        </button>
      </div>
      {first && (
        <Dialog title="合成详情" onClose={() => setFirst(false)}>
          <button
            type="button"
            onClick={() => {
              setFirst(false);
              setSecond(true);
            }}
          >
            继续合成创建
          </button>
        </Dialog>
      )}
      {second && (
        <Dialog title="合成创建" onClose={() => setSecond(false)}>
          <input aria-label="合成创建名称" data-autofocus="true" />
        </Dialog>
      )}
    </>
  );
}

it('keeps the original opener when one dialog is replaced by another without focusing the background', async () => {
  const backgroundFocus = vi.fn();
  render(<ReplacementFixture backgroundFocus={backgroundFocus} />);
  const opener = screen.getByRole('button', { name: '合成入口' });
  await userEvent.click(opener);
  await userEvent.click(screen.getByRole('button', { name: '继续合成创建' }));
  expect(screen.getByRole('textbox', { name: '合成创建名称' })).toHaveFocus();
  expect(backgroundFocus).toHaveBeenCalledTimes(1);
  expect(document.getElementById('root')).toHaveProperty('inert', true);
  await userEvent.keyboard('{Escape}');
  expect(opener).toHaveFocus();
  expect(backgroundFocus).toHaveBeenCalledTimes(2);
  expect(document.getElementById('root')).toHaveProperty('inert', false);
});
it('draws a selectable list, skips disabled options and restores trigger focus on Escape', async () => {
  const change = vi.fn();
  render(<Select label="合成选择" value="a" options={options} onValueChange={change} />);
  const trigger = screen.getByRole('button', { name: /合成选择$/ });
  expect(trigger.tagName).toBe('BUTTON');
  await userEvent.click(trigger);
  expect(screen.getByRole('listbox')).toBeVisible();
  expect(screen.getByRole('option', { name: '合成乙' })).toHaveAttribute('aria-disabled', 'true');
  await userEvent.keyboard('{End}{Enter}');
  expect(change).toHaveBeenCalledWith('c');
  await userEvent.click(trigger);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});

it('keeps icon-decorated selection labels searchable and keyboard-selectable', async () => {
  const change = vi.fn();
  const decorated = [
    {
      value: 'alpha',
      label: 'Alpha model',
      icon: <span aria-hidden="true" data-model-icon="alpha" />,
    },
    {
      value: 'beta',
      label: 'Beta model',
      icon: <span aria-hidden="true" data-model-icon="beta" />,
    },
  ];
  render(<Select label="合成图标选择" value="alpha" options={decorated} onValueChange={change} />);
  const trigger = screen.getByRole('button', { name: /合成图标选择$/ });
  expect(trigger.querySelector('[data-model-icon="alpha"]')).toBeInTheDocument();
  await userEvent.click(trigger);
  expect(screen.getByRole('option', { name: 'Beta model' })).toBeVisible();
  await userEvent.keyboard('b{Enter}');
  expect(change).toHaveBeenCalledWith('beta');
});

it('closes only the topmost popup, then allows the enclosing dialog to close', async () => {
  const close = vi.fn();
  render(
    <Dialog title="合成对话框" onClose={close}>
      <Select label="合成选择" value="a" options={options} onValueChange={vi.fn()} />
    </Dialog>,
  );
  const trigger = screen.getByRole('button', { name: /合成选择$/ });
  await userEvent.click(trigger);
  await userEvent.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  await waitFor(() => expect(trigger).toHaveFocus());
  await userEvent.keyboard('{Escape}');
  expect(close).toHaveBeenCalledTimes(1);
});

it('removes an open list when its controller becomes disabled without committing a value', async () => {
  const change = vi.fn();
  const view = render(
    <Select label="合成选择" value="a" options={options} onValueChange={change} />,
  );
  await userEvent.click(screen.getByRole('button', { name: /合成选择$/ }));
  view.rerender(
    <Select label="合成选择" value="a" options={options} onValueChange={change} disabled />,
  );
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /合成选择$/ })).toBeDisabled();
  expect(change).not.toHaveBeenCalled();
});

it('keeps the native file control hidden while the app trigger reports the selected filename', async () => {
  const change = vi.fn();
  render(<FilePicker aria-label="合成文件" accept=".json" onChange={change} />);
  const input = screen.getByLabelText('合成文件');
  expect(input).not.toBeVisible();
  expect(screen.getByRole('button', { name: '选择文件：合成文件' })).toBeVisible();
  await userEvent.upload(input, new File(['{}'], 'mock-bot.json', { type: 'application/json' }));
  expect(screen.getByDisplayValue('mock-bot.json')).toBeVisible();
  expect(change).toHaveBeenCalledTimes(1);
});

it('uses an app calendar and retains ISO date values', async () => {
  const change = vi.fn();
  render(<DateField label="合成日期" value="2026-02-10" onValueChange={change} />);
  await userEvent.click(screen.getByRole('button', { name: /^选择合成日期/ }));
  expect(screen.getByRole('grid')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /2026年2月12日/ }));
  expect(change).toHaveBeenCalledWith('2026-02-12');
});

it('uses custom time segments and keeps the minute wire format unchanged', async () => {
  const change = vi.fn();
  render(<TimeField label="合成时间" value="09:30" onValueChange={change} />);
  await userEvent.click(screen.getByRole('spinbutton', { name: /小时/ }));
  await userEvent.keyboard('{ArrowUp}');
  expect(change).toHaveBeenCalledWith('10:30');
});

it('steps numeric values within bounds and keeps the typed string callback', async () => {
  render(<NumberFixture />);
  await userEvent.click(screen.getByRole('button', { name: '增加合成数量' }));
  expect(screen.getByRole('textbox', { name: '合成数量' })).toHaveValue('3');
  expect(screen.getByRole('button', { name: '增加合成数量' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '减少合成数量' }));
  expect(screen.getByRole('textbox', { name: '合成数量' })).toHaveValue('2');
});

it('reports numeric edits before blur so closing the editor cannot discard its draft', async () => {
  const change = vi.fn();
  render(<NumberField label="合成数量" value="2" onValueChange={change} min={1} max={1000} />);
  const input = screen.getByRole('textbox', { name: '合成数量' });
  await userEvent.clear(input);
  await userEvent.type(input, '12');
  expect(change).toHaveBeenLastCalledWith('12');
});

it('retains an explicit empty inheritance option instead of selecting a different value', async () => {
  const change = vi.fn();
  render(
    <Select
      label="合成模型"
      value=""
      options={[{ value: '', label: '跟随工作区' }, ...options]}
      onValueChange={change}
    />,
  );
  expect(screen.getByRole('button', { name: /合成模型$/ })).toHaveTextContent('跟随工作区');
  expect(change).not.toHaveBeenCalled();
});

it('does not clamp an out-of-range typed number into an unintended valid request', async () => {
  const change = vi.fn();
  render(<NumberField label="合成数量" value="2" onValueChange={change} min={1} max={3} />);
  const input = screen.getByRole('textbox', { name: '合成数量' });
  await userEvent.clear(input);
  await userEvent.type(input, '12');
  await userEvent.tab();
  expect(change).toHaveBeenLastCalledWith('12');
});

it('keeps required date and time fields from submitting an empty schedule', async () => {
  const submit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <DateField label="合成日期" value="" onValueChange={vi.fn()} required />
      <TimeField label="合成时间" value="" onValueChange={vi.fn()} required />
      <button type="submit">合成提交</button>
    </form>,
  );
  await userEvent.click(screen.getByRole('button', { name: '合成提交' }));
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByText('请选择有效日期。')).toBeVisible();
});

it('renders an app-owned tooltip instead of a browser title bubble', async () => {
  render(
    <IconButton label="合成提示">
      <span aria-hidden="true">+</span>
    </IconButton>,
  );
  const button = screen.getByRole('button', { name: '合成提示' });
  expect(button).not.toHaveAttribute('title');
  await userEvent.click(button);
  await userEvent.unhover(button);
  await userEvent.hover(button);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('合成提示');
});

it('keeps the dialog Tab loop on visible controls instead of hidden form projections', async () => {
  render(
    <Dialog title="合成焦点" onClose={vi.fn()}>
      <Select label="合成选择" value="a" options={options} onValueChange={vi.fn()} />
    </Dialog>,
  );
  const trigger = screen.getByRole('button', { name: /合成选择$/ });
  trigger.focus();
  await userEvent.tab();
  expect(screen.getByRole('button', { name: '关闭对话框' })).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(trigger).toHaveFocus();
});

it('keeps a fractional edit visible and reports the integer error without changing its meaning', async () => {
  const submit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
  render(<DecimalFixture submit={submit} />);
  const input = screen.getByRole('textbox', { name: '合成数量' });
  await userEvent.clear(input);
  await userEvent.type(input, '2.5');
  await userEvent.tab();
  expect(input).toHaveValue('2.5');
  await userEvent.click(screen.getByRole('button', { name: '合成提交' }));
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByText('请输入范围内的有效整数。')).toBeVisible();
});

it('closes an open calendar when the owning form becomes sealed', async () => {
  const change = vi.fn();
  const view = render(<DateField label="合成日期" value="2026-02-10" onValueChange={change} />);
  await userEvent.click(screen.getByRole('button', { name: /^选择合成日期/ }));
  expect(screen.getByRole('grid')).toBeVisible();
  view.rerender(<DateField label="合成日期" value="2026-02-10" onValueChange={change} disabled />);
  expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
});
