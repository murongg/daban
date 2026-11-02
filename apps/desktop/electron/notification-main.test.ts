import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { NoticeActivation, NoticeMessage } from '../shared/notifications';

const mock = vi.hoisted(() => ({
  ready: undefined as (() => unknown) | undefined,
  events: new Map<string, (...args: unknown[]) => unknown>(),
  windows: [] as {
    emit: (name: string) => unknown;
    show: () => unknown;
    focus: () => unknown;
    destroyed: boolean;
    webContents: { send: (...args: unknown[]) => unknown };
  }[],
  options: undefined as
    | { open: (value: NoticeActivation) => unknown; changed: (message: NoticeMessage) => unknown }
    | undefined,
  activate: vi.fn(async () => {}),
  observe: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  focus: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  serviceArgs: [] as unknown[][],
  packaged: false,
  permissions: undefined as
    | ((a: unknown, b: unknown, callback: (value: boolean) => unknown) => unknown)
    | undefined,
}));
vi.mock('electron', () => ({
  app: {
    setName: vi.fn(),
    getPath: () => '/mock',
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    isReady: () => true,
    get isPackaged() {
      return mock.packaged;
    },
    on: (name: string, callback: (...args: unknown[]) => unknown) =>
      mock.events.set(name, callback),
    whenReady: () =>
      new Promise((resolve) => {
        mock.ready = () => resolve(undefined);
      }),
    exit: vi.fn(),
  },
  BrowserWindow: class extends EventEmitter {
    destroyed = false;
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn() };
    constructor() {
      super();
      mock.windows.push(this);
    }
    setMenuBarVisibility() {}
    loadFile = vi.fn(async () => {});
    show = vi.fn();
    focus = vi.fn();
    isMinimized = () => false;
    restore = vi.fn();
    isDestroyed = () => this.destroyed;
    isFocused = () => false;
    static getAllWindows() {
      return mock.windows.filter((window) => !window.destroyed);
    }
  },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  powerMonitor: { on: vi.fn() },
  Menu: { buildFromTemplate: vi.fn((value) => value), setApplicationMenu: vi.fn() },
  Notification: { handleActivation: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  session: {
    defaultSession: {
      setPermissionRequestHandler: (
        callback: (a: unknown, b: unknown, reply: (value: boolean) => unknown) => unknown,
      ) => {
        mock.permissions = callback;
      },
    },
  },
}));
vi.mock('./native', () => ({
  desktopDriver: vi.fn(() => ({
    supported: false,
    platform: 'unsupported',
    permissions: () => ({ screen: false, accessibility: false }),
  })),
}));
vi.mock('./local-server', () => ({ localServer: vi.fn(async () => async () => {}) }));
vi.mock('./service', () => ({
  runtimeService: (...args: unknown[]) => {
    mock.serviceArgs.push(args);
    return {
      connect: mock.connect,
      close: vi.fn(async () => {}),
      releaseInputs: vi.fn(async () => {}),
    };
  },
}));
vi.mock('./notifications', () => ({
  Notifications: class {
    constructor(
      _file: string,
      options: {
        open: (value: NoticeActivation) => unknown;
        changed: (message: NoticeMessage) => unknown;
      },
    ) {
      mock.options = options;
    }
    activate = mock.activate;
    observe = mock.observe;
    close = mock.close;
    focus = mock.focus;
    invoke = vi.fn();
  },
}));
vi.mock('./notification-ipc', () => ({ noticeIpc: () => () => {} }));
vi.mock('./locale-ipc', () => ({ localeIpc: () => () => {} }));

it.each([false, true])(
  'captures notifications and always selects the host agent transport (packaged=%s)',
  async (packaged) => {
    vi.resetModules();
    mock.packaged = packaged;
    mock.events.clear();
    mock.windows.length = 0;
    mock.serviceArgs.length = 0;
    mock.connect.mockClear();
    const previous = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/mock/Resources',
    });
    vi.stubGlobal('__dirname', '/mock');
    try {
      await import('./main');
      mock.events.get('ready')?.({}, { identifier: 'mock-cold-id' });
      mock.ready?.();
      await vi.waitFor(() => expect(mock.connect).toHaveBeenCalled());
      expect(mock.serviceArgs[0][4]).toEqual({
        entry: packaged
          ? join('/mock/Resources/agent', 'main.js')
          : expect.stringMatching(/\/resources\/agent\/main\.js$/),
        executable: packaged
          ? join('/mock/Resources/agent', 'node/bin/node')
          : expect.stringMatching(/\/resources\/agent\/node\/bin\/node$/),
      });
      mock.windows[0].emit('ready-to-show');
      expect(mock.activate).toHaveBeenCalledWith('mock-cold-id');
      const activation: NoticeActivation = {
        id: 'mock-native-id',
        scope: 'a'.repeat(64),
        target: { kind: 'settings' },
      };
      mock.options!.open(activation);
      expect(mock.windows).toHaveLength(1);
      expect(mock.windows[0].focus).toHaveBeenCalled();
      const permission = vi.fn();
      mock.permissions?.({}, 'notifications', permission);
      expect(permission).toHaveBeenCalledWith(false);
      mock.options!.changed({ type: 'navigate', activation });
      expect(mock.windows[0].webContents.send).toHaveBeenCalledWith('daban:notification-message', {
        type: 'navigate',
        activation,
      });
      mock.windows[0].destroyed = true;
      mock.windows[0].emit('closed');
      mock.options!.open(activation);
      expect(mock.windows).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      if (previous) Object.defineProperty(process, 'resourcesPath', previous);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  },
);
