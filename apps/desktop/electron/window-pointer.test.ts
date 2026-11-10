import type { BrowserWindowConstructorOptions, Point } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { windowPointer } from './window-pointer';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  screenToDipPoint: vi.fn((point: Point) => ({
    x: Math.round(point.x / 2),
    y: Math.round(point.y / 2),
  })),
  getDisplayNearestPoint: vi.fn(() => ({ bounds: { x: -800, y: 0, width: 800, height: 600 } })),
}));
const context = '123:22:-800:0:800:600';
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) {
      Object.assign(this, mocks.create(options));
    }
  },
  screen: {
    screenToDipPoint: mocks.screenToDipPoint,
    getDisplayNearestPoint: mocks.getDisplayNearestPoint,
  },
}));

function surface() {
  const order: string[] = [];
  const window = {
    setIgnoreMouseEvents: vi.fn(),
    loadURL: vi.fn(async (_url: string) => {}),
    showInactive: vi.fn(() => order.push('show')),
    moveAbove: vi.fn((_id: string) => order.push('pin')),
    setOpacity: vi.fn((opacity: number) => order.push(opacity ? 'reveal' : 'fade')),
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(() => order.push('destroy')),
    getBounds: vi.fn(),
  };
  mocks.create.mockImplementation((options: BrowserWindowConstructorOptions) => {
    window.getBounds.mockReturnValue(options);
    return window;
  });
  return { window, order };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('maps Windows physical coordinates to the display and pins the click-through overlay before revealing it', async () => {
  const { window, order } = surface();
  await windowPointer('win32').show(123, { x: -801.2, y: 320.1 }, context);

  expect(mocks.screenToDipPoint).toHaveBeenCalledWith({ x: -801, y: 320 });
  expect(mocks.getDisplayNearestPoint).toHaveBeenCalledWith({ x: -400, y: 160 });
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      x: -424,
      y: 136,
      show: false,
      opacity: 0,
      focusable: false,
      transparent: true,
      resizable: false,
    }),
  );
  expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
  expect(window.moveAbove).toHaveBeenCalledWith('window:123:0');
  expect(order).toEqual(['show', 'pin', 'reveal']);

  await vi.runAllTimersAsync();
  expect(order).toEqual(['show', 'pin', 'reveal', 'fade', 'destroy']);
});

it('keeps the pointer tip at the click when its window is clamped to a display edge', async () => {
  const { window } = surface();
  await windowPointer('darwin').show(123, { x: -796, y: 30 }, context);
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ x: -800, y: 6 }));
  const url = window.loadURL.mock.calls[0]?.[0] ?? '';
  expect(decodeURIComponent(url)).toContain('translate(4 24)');
});

it('does not reveal a pointer that was cleared while its document was loading', async () => {
  const { window, order } = surface();
  let finish!: (value: undefined) => unknown;
  const loaded = new Promise<undefined>((resolve) => {
    finish = resolve;
  });
  window.loadURL.mockReturnValueOnce(loaded);
  const pointer = windowPointer('darwin');
  const shown = pointer.show(123, { x: -100, y: 160 }, context);
  pointer.hide();
  finish(undefined);
  await shown;

  expect(order).toEqual(['fade', 'destroy']);
  expect(vi.getTimerCount()).toBe(0);
});

it('destroys the overlay without revealing it if the target window disappeared', async () => {
  const { window, order } = surface();
  window.moveAbove.mockImplementationOnce(() => {
    throw new Error('Synthetic window disappeared');
  });
  await expect(windowPointer('darwin').show(123, { x: -100, y: 160 }, context)).rejects.toThrow(
    'Synthetic window disappeared',
  );
  expect(order).toEqual(['show', 'fade', 'destroy']);
});

it('glides from the last click after its overlay has faded and delays the next ripple until arrival', async () => {
  const { window, order } = surface();
  const pointer = windowPointer('darwin');
  await pointer.show(123, { x: -650, y: 110 }, context);
  await vi.runAllTimersAsync();
  expect(order.at(-1)).toBe('destroy');

  await pointer.show(123, { x: -310, y: 230 }, context);
  expect(mocks.create).toHaveBeenLastCalledWith(
    expect.objectContaining({ x: -674, y: 86, width: 404, height: 184 }),
  );
  const html = decodeURIComponent(window.loadURL.mock.lastCall?.[0] ?? '');
  expect(html).toContain('translate(-340px, -120px)');
  expect(html).toContain('translate(364 144)');
  expect(html).toMatch(/animation: ripple 520ms [1-9]\d*ms/);
  expect(window.moveAbove).toHaveBeenLastCalledWith('window:123:0');
});

it('starts at the destination after an interruption or a change in the window geometry', async () => {
  const { window } = surface();
  const pointer = windowPointer('darwin');
  await pointer.show(123, { x: -650, y: 110 }, context);
  pointer.hide();
  await pointer.show(123, { x: -310, y: 230 }, context);
  expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ width: 64, height: 64 }));
  expect(decodeURIComponent(window.loadURL.mock.lastCall?.[0] ?? '')).toContain('glide 0ms');

  await pointer.show(123, { x: -400, y: 300 }, '123:22:-700:0:700:600');
  expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ width: 64, height: 64 }));
});

it('uses a local pulse when consecutive clicks land on different displays', async () => {
  const { window } = surface();
  const pointer = windowPointer('darwin');
  await pointer.show(123, { x: -30, y: 110 }, context);
  mocks.getDisplayNearestPoint.mockReturnValueOnce({
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
  });
  await pointer.show(123, { x: 40, y: 110 }, context);
  expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ width: 64, height: 64 }));
  expect(decodeURIComponent(window.loadURL.mock.lastCall?.[0] ?? '')).toContain('glide 0ms');
});
