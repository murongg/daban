import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { Tooltip } from './Tooltip';

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

it('disables every dialog dismissal route while its owner is waiting', async () => {
  const close = vi.fn();
  const content = <button type="button">Synthetic waiting action</button>;
  const view = render(
    <Dialog title="Synthetic waiting dialog" onClose={close} closeDisabled>
      {content}
    </Dialog>,
  );
  const closeButton = screen.getByRole('button', { name: '关闭对话框' });
  expect(closeButton).toBeDisabled();
  await userEvent.click(closeButton);
  await userEvent.keyboard('{Escape}');
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
  expect(close).not.toHaveBeenCalled();
  view.rerender(
    <Dialog title="Synthetic waiting dialog" onClose={close}>
      {content}
    </Dialog>,
  );
  expect(closeButton).toBeEnabled();
  await userEvent.click(closeButton);
  await userEvent.keyboard('{Escape}');
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
  expect(close).toHaveBeenCalledTimes(3);
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

it('shows a secondary selection description without changing the option label', async () => {
  const change = vi.fn();
  render(
    <Select
      label="Synthetic model"
      value="alpha"
      options={[
        { value: 'alpha', label: 'Synthetic Alpha', description: 'Synthetic connection A' },
        { value: 'beta', label: 'Synthetic Beta', description: 'Synthetic connection B' },
      ]}
      onValueChange={change}
    />,
  );
  const trigger = screen.getByRole('button', { name: /Synthetic model$/ });
  expect(within(trigger).getByText('Synthetic connection A')).toBeVisible();
  await userEvent.click(trigger);
  const beta = screen.getByRole('option', { name: 'Synthetic Beta' });
  expect(within(beta).getByText('Synthetic connection B')).toBeVisible();
  expect(beta).toHaveAccessibleDescription('Synthetic connection B');
  await userEvent.keyboard('{End}{Enter}');
  expect(change).toHaveBeenCalledWith('beta');
});

it('retains the existing accessible option details when no secondary description is supplied', async () => {
  render(
    <Select
      label="Synthetic mode"
      value="ask"
      options={[
        {
          value: 'ask',
          label: 'Synthetic Ask',
          detail: <span>Synthetic important detail</span>,
        },
      ]}
      onValueChange={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: /Synthetic mode$/ }));
  expect(
    screen.getByRole('option', { name: /Synthetic Ask\s*Synthetic important detail/ }),
  ).toBeVisible();
});

it('opens a prefixed select from its visible label without changing option names or keyboard selection', async () => {
  const change = vi.fn();
  render(
    <Select
      label="Synthetic recipient"
      prefix="Send to"
      value="alpha"
      options={[
        { value: 'alpha', label: 'Synthetic Alpha' },
        { value: 'beta', label: 'Synthetic Beta' },
      ]}
      onValueChange={change}
    />,
  );
  const trigger = screen.getByRole('button', { name: /Synthetic recipient$/ });
  await userEvent.click(within(trigger).getByText('Send to'));
  expect(screen.getByRole('option', { name: 'Synthetic Alpha' })).toBeVisible();
  expect(screen.getByRole('option', { name: 'Synthetic Beta' })).toBeVisible();
  await userEvent.keyboard('s{ArrowDown}{Enter}');
  expect(change).toHaveBeenCalledWith('beta');
  await waitFor(() => expect(trigger).toHaveFocus());
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

it('keeps a tooltip open while the pointer transfers to its content, then dismisses after leaving both', async () => {
  const user = userEvent.setup();
  render(
    <Tooltip label="Synthetic hover detail">
      <button type="button">Synthetic trigger</button>
    </Tooltip>,
  );
  await user.hover(screen.getByRole('button', { name: 'Synthetic trigger' }));
  const tooltip = await screen.findByRole('tooltip');
  await user.hover(tooltip);
  expect(screen.getByRole('tooltip')).toBeVisible();
  await user.unhover(tooltip);
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
});

it('preserves a keyboard tooltip through pointer exit and leaves remote Escape ownership intact', async () => {
  const remoteKey = vi.fn();
  render(
    <Tooltip label="Synthetic keyboard detail">
      <button type="button" data-remote-keyboard="true" onKeyDown={remoteKey}>
        Synthetic keyboard trigger
      </button>
    </Tooltip>,
  );
  const trigger = screen.getByRole('button', { name: 'Synthetic keyboard trigger' });
  // jsdom does not track the browser's keyboard modality for :focus-visible.
  const matches = trigger.matches.bind(trigger);
  vi.spyOn(trigger, 'matches').mockImplementation(
    (selector) => selector === ':focus-visible' || matches(selector),
  );
  await userEvent.tab();
  expect(trigger).toHaveFocus();
  expect(screen.getByRole('tooltip')).toBeVisible();
  await userEvent.hover(trigger);
  await userEvent.unhover(trigger);
  expect(screen.getByRole('tooltip')).toBeVisible();
  const escapeKey = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  fireEvent(trigger, escapeKey);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  expect(remoteKey).toHaveBeenCalledTimes(1);
  expect(escapeKey.defaultPrevented).toBe(false);
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

it('wraps dialog focus around a closed native disclosure without entering its hidden descendants', async () => {
  render(
    <Dialog title="Synthetic disclosure" onClose={vi.fn()}>
      <details>
        <summary>Synthetic disclosure toggle</summary>
        <button type="button">Synthetic closed action</button>
      </details>
    </Dialog>,
  );
  const close = screen.getByRole('button', { name: '关闭对话框' });
  const summary = screen.getByText('Synthetic disclosure toggle');
  summary.focus();
  await userEvent.tab();
  expect(close).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(summary).toHaveFocus();
  await userEvent.click(summary);
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Synthetic closed action' })).toHaveFocus();
});

it('excludes CSS-hidden controls from dialog focus endpoints and autofocus', async () => {
  render(
    <Dialog title="Synthetic visibility" onClose={vi.fn()}>
      <div style={{ display: 'none' }}>
        <input aria-label="Synthetic hidden autofocus" data-autofocus />
      </div>
      <button type="button">Synthetic visible action</button>
      <div style={{ display: 'none' }}>
        <button type="button">Synthetic display hidden</button>
      </div>
      <button type="button" style={{ visibility: 'hidden' }}>
        Synthetic visibility hidden
      </button>
    </Dialog>,
  );
  const close = screen.getByRole('button', { name: '关闭对话框' });
  expect(close).toHaveFocus();
  const visible = screen.getByRole('button', { name: 'Synthetic visible action' });
  visible.focus();
  await userEvent.tab();
  expect(close).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(visible).toHaveFocus();
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
