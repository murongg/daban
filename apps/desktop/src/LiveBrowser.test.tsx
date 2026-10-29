import {
  type BrowserState,
  type BrowserView,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';
import { LiveBrowser } from './LiveBrowser';
import { RuntimeProvider } from './Runtime';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const state: BrowserState = {
  bot: 'a',
  available: true,
  instance: 'mock-screen',
  revision: 1,
  active: 'mock-tab-a',
  tabs: [{ id: 'mock-tab-a', url: 'about:blank', title: '', generation: 0 }],
};
const image = (bot = 'a'): BrowserView => ({
  bot,
  epoch: 3,
  binding: { instance: 'mock-screen', tab: `mock-tab-${bot}`, generation: 0 },
  image: `data:image/jpeg;base64,${btoa(`synthetic-${bot}`)}`,
  width: 960,
  height: 640,
});
function setup(view: (bot: string) => Promise<BrowserView>) {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 16;
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true as const,
    value:
      command.type === 'status'
        ? snapshot
        : command.type === 'browser.view'
          ? await view(command.bot)
          : { ok: true },
  }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      runtime: { invoke, subscribe: () => () => {} } as unknown as RuntimeBridge,
      platform: 'darwin',
    },
  });
  return invoke;
}
const props = {
  bot: 'a' as const,
  name: '合成 A',
  state,
  owner: 'human' as const,
  epoch: 3,
  disabled: false,
  notify: () => {},
};
it('waits for the matching image to load before accepting exact browser coordinates', async () => {
  const invoke = setup(async (bot) => image(bot));
  render(
    <RuntimeProvider>
      <LiveBrowser {...props} />
    </RuntimeProvider>,
  );
  const picture = await screen.findByRole('img', { name: '合成 A的浏览器' });
  picture.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 480,
    bottom: 320,
    width: 480,
    height: 320,
    toJSON: () => ({}),
  });
  fireEvent.pointerDown(picture, { clientX: 240, clientY: 160, button: 0 });
  expect(invoke.mock.calls.some(([c]) => c.type === 'browser.input')).toBe(false);
  fireEvent.load(picture);
  const click = new MouseEvent('pointerdown', {
    bubbles: true,
    clientX: 240,
    clientY: 160,
    button: 0,
  });
  Object.defineProperty(click, 'pointerId', { value: 1 });
  fireEvent(picture, click);
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([c]) =>
          c.type === 'browser.input' &&
          c.bot === 'a' &&
          c.epoch === 3 &&
          c.binding.tab === 'mock-tab-a' &&
          c.binding.generation === 0 &&
          c.input.type === 'pointer' &&
          c.input.x === 480 &&
          c.input.y === 320,
      ),
    ).toBe(true),
  );
});
it('ignores a delayed frame from the previous Bot and routes keyboard input through the displayed Bot binding', async () => {
  let finish!: (frame: BrowserView) => unknown;
  const delayed = new Promise<BrowserView>((resolve) => {
    finish = resolve;
  });
  const invoke = setup(async (bot) => (bot === 'a' ? delayed : image('b')));
  const app = render(
    <RuntimeProvider>
      <LiveBrowser {...props} />
    </RuntimeProvider>,
  );
  const b = {
    ...state,
    bot: 'b',
    active: 'mock-tab-b',
    tabs: [{ ...state.tabs[0], id: 'mock-tab-b' }],
  };
  app.rerender(
    <RuntimeProvider>
      <LiveBrowser {...props} bot="b" name="合成 B" state={b} />
    </RuntimeProvider>,
  );
  const picture = await screen.findByRole('img', { name: '合成 B的浏览器' });
  finish(image('a'));
  await waitFor(() => expect(picture).toHaveAttribute('src', image('b').image));
  fireEvent.load(picture);
  fireEvent.keyDown(screen.getByRole('application'), { key: 'x' });
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([c]) =>
          c.type === 'browser.input' &&
          c.bot === 'b' &&
          c.binding.tab === 'mock-tab-b' &&
          c.input.type === 'text' &&
          c.input.text === 'x',
      ),
    ).toBe(true),
  );
  expect(invoke.mock.calls.some(([c]) => c.type === 'browser.input' && c.bot === 'a')).toBe(false);
  expect(screen.queryByRole('img', { name: '合成 A的浏览器' })).toBeNull();
});

it('keeps expanded remote-screen Escape routing distinct from ordinary modal dismissal', async () => {
  const invoke = setup(async (bot) => image(bot)),
    close = vi.fn();
  render(
    <RuntimeProvider>
      <Dialog title="合成展开浏览器" onClose={close}>
        <LiveBrowser {...props} />
      </Dialog>
    </RuntimeProvider>,
  );
  const picture = await screen.findByRole('img', { name: '合成 A的浏览器' });
  fireEvent.load(picture);
  const surface = screen.getByRole('application');
  surface.focus();
  fireEvent.keyDown(surface, { key: 'Escape', altKey: true });
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([c]) => c.type === 'browser.input' && c.input.type === 'key' && c.input.key === 'Escape',
      ),
    ).toBe(true),
  );
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(surface, { key: 'Escape' });
  const field = screen.getByRole('textbox', { name: '发送文字到浏览器' });
  expect(field).toHaveFocus();
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(close).toHaveBeenCalledTimes(1);
});
