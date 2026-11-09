import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserMount } from '../../../shared/browser';
import { EmbeddedBrowser } from './EmbeddedBrowser';

afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const props = {
  bot: 'mock-bot',
  name: '合成浏览器',
  state: {
    bot: 'mock-bot',
    available: true,
    instance: 'mock-instance',
    revision: 1,
    active: 'mock-tab',
    tabs: [{ id: 'mock-tab', title: '', url: 'https://example.test', generation: 0 }],
  },
  owner: 'human' as const,
  epoch: 3,
  disabled: false,
  notify: vi.fn(),
};

it('mounts a real webpage with its exact lease and hides it when a dialog covers the app or control changes', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const invoke = vi.fn(async (_request: BrowserMount) => ({ ok: true, value: { attached: true } }));
  Object.defineProperty(window, 'daban', { configurable: true, value: { browser: { invoke } } });
  const bounds = {
    x: 20,
    y: 100,
    left: 20,
    top: 100,
    right: 620,
    bottom: 500,
    width: 600,
    height: 400,
    toJSON: () => ({}),
  };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
  const { rerender, unmount } = render(<EmbeddedBrowser {...props} />);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'show',
        bot: 'mock-bot',
        epoch: 3,
        binding: { instance: 'mock-instance', tab: 'mock-tab', generation: 0 },
        bounds: { x: 20, y: 100, width: 600, height: 400 },
      }),
    ),
  );
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  const plan = document.createElement('details');
  plan.getBoundingClientRect = () => ({ ...bounds, x: 700, left: 700, right: 850, width: 150 });
  plan.open = true;
  try {
    await act(async () => {
      document.body.append(plan);
    });
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'show' }));
    plan.getBoundingClientRect = () => bounds;
    fireEvent.resize(window);
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'hide' })),
    );
  } finally {
    plan.remove();
  }
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'show' })),
  );
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.append(dialog);
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'hide' })),
  );
  dialog.remove();
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'show' })),
  );
  const wrapper = screen.getByRole('region', { name: '合成浏览器的浏览器画面' }).parentElement!;
  wrapper.getBoundingClientRect = () => ({ ...bounds, bottom: 300, height: 200 });
  wrapper.style.overflowX = 'hidden';
  wrapper.style.overflowY = 'hidden';
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'hide' })),
  );
  wrapper.style.overflowX = 'visible';
  wrapper.style.overflowY = 'visible';
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'show' })),
  );
  rerender(<EmbeddedBrowser {...props} owner="agent" epoch={4} />);
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'hide' })),
  );
  fireEvent.resize(window);
  expect(
    invoke.mock.calls.filter(([request]) => (request as { action: string }).action === 'show')
      .length,
  ).toBe(4);
  unmount();
});
