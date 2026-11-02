import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
const originalMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const animations: { target: HTMLElement; frames: Keyframe[]; animation: Animation }[] = [];
let reduced = false;
beforeEach(() => {
  animations.length = 0;
  reduced = false;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: reduced }),
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: function (this: HTMLElement, frames: Keyframe[]) {
      const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
      animations.push({ target: this, frames, animation });
      return animation;
    },
  });
});
afterEach(() => {
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  if (originalMedia) Object.defineProperty(window, 'matchMedia', originalMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
  vi.useRealTimers();
});
function Fixture({ closed }: { closed: () => unknown }) {
  const [open, setOpen] = useState(true);
  const [child, setChild] = useState(false);
  return (
    <>
      {open && (
        <Dialog
          title="合成动画设置"
          motion
          active={!child}
          onClose={() => {
            closed();
            setOpen(false);
          }}
        >
          <input aria-label="合成草稿" defaultValue="synthetic-motion-draft" />
          <button type="button" onClick={() => setChild(true)}>
            打开合成子窗口
          </button>
        </Dialog>
      )}
      {child && (
        <Dialog title="合成子窗口" onClose={() => setChild(false)}>
          Synthetic child.
        </Dialog>
      )}
    </>
  );
}
it('keeps the modal and draft until exit completes and dismisses only once', async () => {
  const closed = vi.fn();
  render(<Fixture closed={closed} />);
  expect(animations).toHaveLength(2);
  await userEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  expect(screen.getByRole('dialog', { name: '合成动画设置' })).toBeVisible();
  expect(closed).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: '合成草稿' })).toHaveValue('synthetic-motion-draft');
  await userEvent.keyboard('{Escape}');
  expect(animations).toHaveLength(4);
  const finish = animations.at(-1)!.animation.onfinish!;
  await act(async () =>
    finish.call(animations.at(-1)!.animation, new Event('finish') as AnimationPlaybackEvent),
  );
  expect(closed).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('cancels a stale exit when another dialog takes ownership and preserves the parent input', async () => {
  const closed = vi.fn();
  render(<Fixture closed={closed} />);
  await userEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  const animation = animations.at(-1)!.animation;
  const finish = animation.onfinish!;
  await userEvent.click(screen.getByRole('button', { name: '打开合成子窗口' }));
  await act(async () => finish.call(animation, new Event('finish') as AnimationPlaybackEvent));
  expect(closed).not.toHaveBeenCalled();
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('textbox', { name: '合成草稿' })).toHaveValue('synthetic-motion-draft');
});
it('skips spatial animation for reduced motion and cannot get stuck if finish events never arrive', async () => {
  const closed = vi.fn();
  reduced = true;
  const first = render(<Fixture closed={closed} />);
  expect(animations).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  expect(closed).toHaveBeenCalledTimes(1);
  first.unmount();
  reduced = false;
  vi.useFakeTimers();
  render(<Fixture closed={closed} />);
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  await act(async () => vi.runOnlyPendingTimers());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(closed).toHaveBeenCalledTimes(2);
});

it('keeps opening and closing functional if the browser rejects an animation', () => {
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: () => {
      throw new Error('SYNTHETIC_ANIMATION_UNAVAILABLE');
    },
  });
  const closed = vi.fn();
  render(<Fixture closed={closed} />);
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  expect(closed).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('holds the invisible exit state until the owner actually unmounts instead of flashing the original styles', async () => {
  const closed = vi.fn();
  const view = render(
    <Dialog title="合成交接" motion onClose={closed}>
      Synthetic content.
    </Dialog>,
  );
  await userEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  const exiting = animations.slice(-2);
  const finish = exiting.at(-1)!.animation.onfinish!;
  await act(async () =>
    finish.call(exiting.at(-1)!.animation, new Event('finish') as AnimationPlaybackEvent),
  );
  expect(closed).toHaveBeenCalledTimes(1);
  for (const { animation } of exiting) expect(animation.cancel).not.toHaveBeenCalled();
  await userEvent.keyboard('{Escape}');
  expect(closed).toHaveBeenCalledTimes(1);
  view.unmount();
  for (const { animation } of exiting) expect(animation.cancel).toHaveBeenCalledTimes(1);
});
