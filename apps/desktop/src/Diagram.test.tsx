import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';

const mocks = vi.hoisted(() => ({ draw: vi.fn() }));
vi.mock('./diagrams', () => ({ renderDiagram: mocks.draw }));
const image = (label: string) => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 70"><text>MOCK</text></svg>',
  width: 200,
  height: 70,
  label,
});
const create = Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
  revoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
afterEach(() => {
  if (create) Object.defineProperty(URL, 'createObjectURL', create);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (revoke) Object.defineProperty(URL, 'revokeObjectURL', revoke);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});
function urls() {
  const make = vi.fn(() => 'blob:mock-diagram'),
    remove = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: make });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: remove });
  return { make, remove };
}
it('keeps a live diagram as code, then draws the settled source and preserves exact source copying', async () => {
  urls();
  mocks.draw.mockResolvedValue(image('合成流程'));
  const source = 'flowchart TD\n  A[合成输入] --> B[合成结果]',
    text = '```mermaid\n' + source + '\n```';
  const copyText = vi.fn(async () => undefined),
    props = { text, copyText, notify: vi.fn(), openLink: vi.fn() };
  const view = render(<Markdown {...props} streaming />);
  expect(mocks.draw).not.toHaveBeenCalled();
  expect(view.container.querySelector('.markdown-code code')?.textContent).toBe(source + '\n');
  view.rerender(<Markdown {...props} streaming={false} />);
  expect(await screen.findByRole('img', { name: '合成流程' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '复制源码' }));
  expect(copyText).toHaveBeenCalledWith(source);
  expect(screen.getByText('查看源码')).toBeInTheDocument();
});
it('ignores an old async diagram and releases only its own image URL on unmount', async () => {
  const { make, remove } = urls();
  let release = (_value: ReturnType<typeof image>) => {};
  mocks.draw
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(image('合成新图'));
  const props = { notify: vi.fn(), openLink: vi.fn() };
  const view = render(<Markdown {...props} text={'```mermaid\nflowchart LR\nA-->B\n```'} />);
  await waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(1));
  view.rerender(<Markdown {...props} text={'```mermaid\nflowchart LR\nB-->C\n```'} />);
  expect(await screen.findByRole('img', { name: '合成新图' })).toBeInTheDocument();
  release(image('合成旧图'));
  await waitFor(() => expect(make).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('img', { name: '合成旧图' })).not.toBeInTheDocument();
  view.unmount();
  expect(remove).toHaveBeenCalledWith('blob:mock-diagram');
});
it('retains readable copyable source when drawing fails', async () => {
  urls();
  mocks.draw.mockResolvedValue(undefined);
  const source = 'flowchart SYNTHETIC INVALID',
    copyText = vi.fn();
  render(
    <Markdown
      text={'```mermaid\n' + source + '\n```'}
      copyText={copyText}
      notify={vi.fn()}
      openLink={vi.fn()}
    />,
  );
  expect(await screen.findByText('图表未能绘制，已保留源码。')).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '复制源码' }));
  expect(copyText).toHaveBeenCalledWith(source);
});
