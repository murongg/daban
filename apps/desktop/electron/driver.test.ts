import { desktopCapturer, shell } from 'electron';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  screenPermission: vi.fn(() => 'granted'),
  accessibility: vi.fn(() => true),
  dip: vi.fn((point: { x: number; y: number }) => ({ x: point.x * 1.25, y: point.y * 1.25 })),
}));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' },
  screen: {
    dipToScreenPoint: mocks.dip,
    screenToDipPoint: (p: { x: number; y: number }) => ({ x: p.x / 1.25, y: p.y / 1.25 }),
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 } }),
  },
  desktopCapturer: {
    getSources: vi.fn(async () => [
      {
        display_id: '1',
        thumbnail: {
          isEmpty: () => false,
          resize: () => ({
            getSize: () => ({ width: 1280, height: 720 }),
            toJPEG: () => Buffer.from('SYNTHETIC JPEG'),
          }),
        },
      },
    ]),
  },
  shell: { openExternal: vi.fn(async () => {}) },
  systemPreferences: {
    getMediaAccessStatus: mocks.screenPermission,
    isTrustedAccessibilityClient: mocks.accessibility,
  },
}));

import { desktopDriver } from './native';

function automation() {
  return {
    getActiveWindow: () => 1,
    getWindowRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    setKeyboardDelay: vi.fn(),
    setMouseDelay: vi.fn(),
    moveMouse: vi.fn(),
    dragMouse: vi.fn(),
    mouseClick: vi.fn(),
    mouseToggle: vi.fn(),
    keyTap: vi.fn(),
    keyToggle: vi.fn(),
    typeString: vi.fn(),
    scrollMouse: vi.fn(),
  };
}
const frame = {
  image: 'data:image/jpeg;base64,AA==',
  width: 800,
  height: 600,
  context: '1',
  bounds: { x: 0, y: 0, width: 1536, height: 864 },
};
it('maps screenshot coordinates through Windows DPI conversion before native input', async () => {
  const api = automation();
  const driver = desktopDriver(
    () => undefined,
    'win32',
    () => api,
  );
  expect(driver.permissions()).toEqual({ screen: true, accessibility: true });
  expect(driver.forWindow).toBeTypeOf('function');
  await driver.input({ type: 'click', x: 400, y: 300 }, frame, () => {});
  expect(api.moveMouse).toHaveBeenCalledWith(960, 540);
  expect(api.mouseClick).toHaveBeenCalledWith('left');
});
it('types bounded Unicode chunks without overwriting the clipboard and checks stop between chunks', async () => {
  const api = automation(),
    checks = vi.fn();
  const driver = desktopDriver(
    () => undefined,
    'darwin',
    () => api,
  );
  const text = '合成🙂'.repeat(50);
  await driver.input({ type: 'text', text }, frame, checks);
  expect(api.typeString.mock.calls.map((call) => call[0]).join('')).toBe(text);
  expect(api.typeString.mock.calls.every((call) => Array.from(String(call[0])).length <= 64)).toBe(
    true,
  );
  expect(checks.mock.calls.length).toBeGreaterThan(2);
});

it('checks the foreground window on the primary display in DIP coordinates on scaled Windows desktops', async () => {
  const api = automation();
  api.getWindowRect = () => ({ x: 1800, y: 100, width: 100, height: 100 });
  const driver = desktopDriver(
    () => undefined,
    'win32',
    () => api,
  );
  expect((await driver.capture()).context).toBe('1');
  api.getWindowRect = () => ({ x: 1800, y: 100, width: 600, height: 100 });
  await expect(driver.capture()).rejects.toThrow('LOCAL_OTHER_DISPLAY');
});

it('stops a long text input when the foreground window changes between Unicode chunks', async () => {
  const api = automation();
  let active = 1;
  api.getActiveWindow = () => active;
  api.typeString.mockImplementation(() => {
    active = 2;
  });
  const driver = desktopDriver(
    () => undefined,
    'darwin',
    () => api,
  );
  await expect(
    driver.input({ type: 'text', text: 'S'.repeat(200) }, frame, () => {}),
  ).rejects.toThrow('LOCAL_SCREEN_CHANGED');
  expect(api.typeString).toHaveBeenCalledTimes(1);
});

it('registers screen permission with a minimal thumbnail only after explicit human setup', async () => {
  mocks.screenPermission.mockReturnValue('denied');
  try {
    const driver = desktopDriver(
      () => undefined,
      'darwin',
      () => automation(),
    );
    await driver.requestPermissions?.();
    expect(desktopCapturer.getSources).toHaveBeenLastCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    });
    expect(mocks.accessibility).toHaveBeenCalledWith(true);
    expect(shell.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  } finally {
    mocks.screenPermission.mockReturnValue('granted');
  }
});

it('handles missing accessibility permission before requesting screen capture', async () => {
  mocks.screenPermission.mockReturnValue('denied');
  mocks.accessibility.mockReturnValue(false);
  vi.mocked(desktopCapturer.getSources).mockClear();
  try {
    const driver = desktopDriver(
      () => undefined,
      'darwin',
      () => automation(),
    );
    await driver.requestPermissions?.();
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenLastCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
  } finally {
    mocks.accessibility.mockReturnValue(true);
    mocks.screenPermission.mockReturnValue('granted');
  }
});
