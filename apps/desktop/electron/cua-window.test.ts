import { beforeEach, expect, it, vi } from 'vitest';
import { cuaWindows } from './cua-window';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  listWindows: vi.fn(),
  callTool: vi.fn(),
  shutdown: vi.fn(),
  uniffiDestroy: vi.fn(),
}));
const pointer = vi.hoisted(() => ({ show: vi.fn(async () => {}), hide: vi.fn() }));
const pixels = vi.hoisted(() => ({ capture: vi.fn(), close: vi.fn() }));
vi.mock('./window-capture', () => ({ windowCapture: () => pixels }));
vi.mock('@trycua/cua-driver', () => ({ CuaDriver: { create: sdk.create } }));
vi.mock('./window-pointer', () => ({ windowPointer: () => pointer }));
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      toJPEG: () => Buffer.from('SYNTHETIC JPEG'),
    }),
  },
}));

const bounds = { x: 20, y: 30, width: 400, height: 300 };
const window = { pid: 22, windowId: 11n, appName: 'Synthetic editor', title: 'Example', bounds };
const snapshot = {
  pid: 22,
  window_id: 11,
  window_bounds: bounds,
  elements: [
    {
      role: 'AXButton',
      frame: { x: 110, y: 75, w: 40, h: 40 },
      actions: ['AXPress'],
      element_token: 'synthetic-snapshot:1',
      depth: 2,
    },
  ],
};

function captured(state: object) {
  return {
    isError: false,
    structuredJson: JSON.stringify(state),
    images: [{ mimeType: 'image/png', dataBase64: 'AA==' }],
  };
}

beforeEach(() => {
  pixels.capture.mockResolvedValue({
    image: 'data:image/jpeg;base64,U1lOVEhFVElD',
    width: 800,
    height: 600,
  });
  sdk.create.mockReturnValue(sdk);
  sdk.listWindows.mockResolvedValue({ windows: [window] });
  sdk.callTool.mockImplementation(async (name: string) =>
    name === 'get_window_state' ? captured(snapshot) : { isError: false },
  );
});

it('captures and acts through the embedded SDK with the exact approved window and background delivery', async () => {
  const driver = cuaWindows('darwin');
  expect(await driver.windows()).toEqual([{ id: '11:22', name: 'Synthetic editor · Example' }]);
  const target = await driver.forWindow('11:22');
  const frame = await target.capture();
  expect(sdk.create).toHaveBeenCalledWith({ embedded: true, claudeCodeCompatibility: false });
  expect(sdk.callTool.mock.calls[0]?.[0]).toBe('get_window_state');
  expect(JSON.parse(sdk.callTool.mock.calls[0]![1])).toMatchObject({
    pid: 22,
    window_id: 11,
    include_screenshot: true,
  });
  expect(frame).toMatchObject({ width: 800, height: 600, bounds });
  await target.input({ type: 'click', x: 200, y: 100 }, frame, () => {});
  expect(sdk.callTool.mock.calls[1]?.[0]).toBe('click');
  expect(JSON.parse(sdk.callTool.mock.calls[1]![1])).toEqual({
    target: { kind: 'window', pid: 22, window_id: 11 },
    delivery_mode: 'background',
    element_token: 'synthetic-snapshot:1',
  });
  expect(pointer.show).toHaveBeenCalledWith(11, { x: 120, y: 80 }, frame.context);
  await driver.close();
  expect(pointer.hide).toHaveBeenCalledOnce();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
  expect(sdk.uniffiDestroy).toHaveBeenCalledOnce();
});

it('refuses a mismatched screenshot or background delivery failure without falling back', async () => {
  const target = await cuaWindows('darwin').forWindow('11:22');
  sdk.callTool.mockResolvedValueOnce(captured({ ...snapshot, window_id: 12 }));
  await expect(target.capture()).rejects.toThrow('LOCAL_SCREEN_CHANGED');
  const frame = await target.capture();
  sdk.callTool.mockResolvedValueOnce({ isError: true, errorCode: 'background_unavailable' });
  await expect(target.input({ type: 'click', x: 200, y: 100 }, frame, () => {})).rejects.toThrow(
    'LOCAL_WINDOW_ACTION_UNSUPPORTED',
  );
  expect(sdk.callTool.mock.calls.filter(([name]) => name !== 'get_window_state')).toHaveLength(1);
  expect(pointer.show).not.toHaveBeenCalled();
});

it('targets editable controls and refuses password fields before sending input', async () => {
  const target = await cuaWindows('darwin').forWindow('11:22');
  const field = { ...snapshot.elements[0], role: 'AXTextField', actions: [] };
  sdk.callTool.mockResolvedValueOnce(
    captured({
      ...snapshot,
      elements: [{ ...field, subrole: 'AXSecureTextField' }],
    }),
  );
  const secure = await target.capture();
  const text = { type: 'text' as const, x: 200, y: 100, text: 'SYNTHETIC' };
  await expect(target.input(text, secure, () => {})).rejects.toThrow(
    'LOCAL_WINDOW_ACTION_UNSUPPORTED',
  );
  expect(sdk.callTool).toHaveBeenCalledTimes(1);

  sdk.callTool.mockResolvedValueOnce(captured({ ...snapshot, elements: [field] }));
  const editable = await target.capture();
  await target.input(text, editable, () => {});
  expect(sdk.callTool.mock.calls[2]?.[0]).toBe('type_text');
  expect(JSON.parse(sdk.callTool.mock.calls[2]![1])).toMatchObject({
    delivery_mode: 'background',
    element_token: 'synthetic-snapshot:1',
    text: 'SYNTHETIC',
  });
  expect(pointer.show).not.toHaveBeenCalled();
});

it('uses the approved Windows UI Automation element for a background click', async () => {
  const driver = cuaWindows('win32');
  sdk.callTool.mockResolvedValueOnce(
    captured({
      ...snapshot,
      elements: [{ ...snapshot.elements[0], role: 'Button', actions: ['invoke'] }],
    }),
  );
  const target = await driver.forWindow('11:22');
  const frame = await target.capture();
  await target.input({ type: 'click', x: 200, y: 100 }, frame, () => {});
  expect(sdk.callTool.mock.calls[1]?.[0]).toBe('click');
  expect(JSON.parse(sdk.callTool.mock.calls[1]![1])).toEqual({
    target: { kind: 'window', pid: 22, window_id: 11 },
    delivery_mode: 'background',
    element_token: 'synthetic-snapshot:1',
  });
  expect(pointer.show).toHaveBeenCalledWith(11, { x: 120, y: 80 }, frame.context);
});

it('keeps Windows capture live through background actions and obtains UIA tokens after its new frame', async () => {
  const target = await cuaWindows('win32').forWindow('11:22');
  const initial = {
    ...snapshot,
    elements: [{ ...snapshot.elements[0], role: 'Button', actions: ['invoke'] }],
  };
  sdk.callTool.mockResolvedValueOnce(captured(initial));
  const frame = await target.capture();
  await target.input({ type: 'click', x: 200, y: 100 }, frame, () => {});
  sdk.callTool.mockResolvedValueOnce(
    captured({
      ...initial,
      elements: [{ ...initial.elements[0], element_token: 'synthetic-fresh:1' }],
    }),
  );
  const refreshed = await target.capture();
  await target.input({ type: 'click', x: 200, y: 100 }, refreshed, () => {});
  expect(pixels.capture).toHaveBeenNthCalledWith(2, 11, expect.any(AbortSignal));
  expect(sdk.callTool.mock.calls.filter(([name]) => name === 'get_window_state')).toHaveLength(2);
  expect(JSON.parse(sdk.callTool.mock.calls[0]![1]).include_screenshot).toBe(false);
  expect(JSON.parse(sdk.callTool.mock.calls.at(-1)![1]).element_token).toBe('synthetic-fresh:1');
  expect(sdk.callTool.mock.calls.filter(([name]) => name === 'click')).toHaveLength(2);
});

it('sends Windows Unicode to the authorized primary desktop and checks ownership after SDK initialization', async () => {
  const driver = cuaWindows('win32');
  const check = vi.fn();
  await driver.typeText('合成 Windows 123，🙂。', check);
  expect(check).toHaveBeenCalledOnce();
  expect(JSON.parse(sdk.callTool.mock.calls[0]![1])).toEqual({
    target: { kind: 'desktop', display_id: 'primary' },
    text: '合成 Windows 123，🙂。',
    delivery_mode: 'foreground',
  });
  expect(sdk.callTool.mock.calls[0]![0]).toBe('type_text');
});

it('refuses stale ownership before desktop text and never replays uncertain Unicode input', async () => {
  const driver = cuaWindows('win32');
  await expect(
    driver.typeText('合成', () => {
      throw Error('LOCAL_PAUSED');
    }),
  ).rejects.toThrow('LOCAL_PAUSED');
  expect(sdk.callTool).not.toHaveBeenCalled();
  sdk.callTool.mockResolvedValueOnce({ isError: true });
  await expect(driver.typeText('合成', () => {})).rejects.toThrow('LOCAL_INPUT_FAILED');
  expect(sdk.callTool).toHaveBeenCalledOnce();
});

it('does not publish a refreshed Windows frame after interruption', async () => {
  const target = await cuaWindows('win32').forWindow('11:22');
  sdk.callTool.mockResolvedValueOnce(
    captured({ ...snapshot, elements: [{ ...snapshot.elements[0], actions: ['invoke'] }] }),
  );
  const frame = await target.capture();
  await target.input({ type: 'click', x: 200, y: 100 }, frame, () => {});
  let finish!: (value: { image: string; width: number; height: number }) => unknown;
  pixels.capture.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = target.capture();
  const result = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(pixels.capture).toHaveBeenCalledTimes(2));
  target.interrupt?.();
  finish({ image: 'data:image/jpeg;base64,U1lOVEhFVElD', width: 800, height: 600 });
  await result;
  expect(pixels.close).toHaveBeenCalledOnce();
  await expect(target.input({ type: 'click', x: 200, y: 100 }, frame, () => {})).rejects.toThrow(
    'LOCAL_SCREEN_CHANGED',
  );
});

it('clears the pointer on interruption and suppresses an in-flight click result', async () => {
  const target = await cuaWindows('darwin').forWindow('11:22');
  const frame = await target.capture();
  let finish!: (result: { isError: boolean }) => unknown;
  const pending = new Promise<{ isError: boolean }>((resolve) => {
    finish = resolve;
  });
  sdk.callTool.mockReturnValueOnce(pending);
  const click = target.input({ type: 'click', x: 200, y: 100 }, frame, () => {});
  await vi.waitFor(() => expect(sdk.callTool).toHaveBeenCalledTimes(2));
  expect(pointer.show).not.toHaveBeenCalled();
  target.interrupt?.();
  expect(pointer.hide).toHaveBeenCalledOnce();
  finish({ isError: false });
  await click;
  expect(pointer.show).not.toHaveBeenCalled();
});

it('refuses Windows background text when the snapshot cannot identify secure inputs', async () => {
  const target = await cuaWindows('win32').forWindow('11:22');
  sdk.callTool.mockResolvedValueOnce(
    captured({
      ...snapshot,
      elements: [{ ...snapshot.elements[0], role: 'Edit', actions: ['set_value'] }],
    }),
  );
  const frame = await target.capture();
  await expect(
    target.input({ type: 'text', x: 200, y: 100, text: 'SYNTHETIC' }, frame, () => {}),
  ).rejects.toThrow('LOCAL_WINDOW_ACTION_UNSUPPORTED');
  expect(sdk.callTool).toHaveBeenCalledTimes(1);
});
