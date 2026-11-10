import type { CuaDriverLike, WindowElement, WindowInfo } from '@trycua/cua-driver';
import { nativeImage } from 'electron';
import type { LocalCapture, WindowDriver } from './local-computer';

const windowId = (window: WindowInfo) => `${window.windowId}:${window.pid}`;
const windowName = (window: WindowInfo) =>
  Array.from(`${window.appName} · ${window.title || window.windowId}`, (character) =>
    character.charCodeAt(0) < 32 ? ' ' : character,
  )
    .join('')
    .trim()
    .slice(0, 256);

type Bounds = LocalCapture['bounds'];
const geometry = ({ x, y, width, height }: Bounds) => [x, y, width, height].join(':');
const context = (window: WindowInfo) => `${windowId(window)}:${geometry(window.bounds)}`;

type CuaPlatform = 'darwin' | 'win32';
type CuaElement = Pick<WindowElement, 'actions' | 'depth' | 'enabled' | 'frame' | 'role'> & {
  element_token?: string;
  in_web_content?: boolean;
  subrole?: string;
};
type WindowSnapshot = {
  pid?: number;
  window_id?: number;
  window_bounds?: Bounds;
  screenshot_frame_valid?: boolean;
  elements?: CuaElement[];
};

function elementAt(
  elements: CuaElement[],
  frame: LocalCapture,
  x: number,
  y: number,
  action: 'click' | 'text',
  platform: CuaPlatform,
) {
  const left = frame.bounds.x + (x / frame.width) * frame.bounds.width;
  const top = frame.bounds.y + (y / frame.height) * frame.bounds.height;
  const clickActions =
    platform === 'win32' ? ['invoke', 'toggle', 'select', 'expand'] : ['AXPress'];
  return elements
    .filter((element) => {
      const box = element.frame;
      return (
        element.element_token &&
        element.enabled !== false &&
        box &&
        left >= box.x &&
        left < box.x + box.w &&
        top >= box.y &&
        top < box.y + box.h &&
        (action === 'click'
          ? element.actions?.some((name) => clickActions.includes(name))
          : !element.in_web_content &&
            element.subrole !== 'AXSecureTextField' &&
            ['AXTextField', 'AXTextArea', 'AXComboBox'].includes(element.role))
      );
    })
    .sort((a, b) => b.depth - a.depth)[0]?.element_token;
}

export function cuaWindows(platform: CuaPlatform) {
  let driver: Promise<CuaDriverLike> | undefined;
  function native() {
    if (driver) return driver;
    // Daban ships a pinned, local SDK and owns the update and privacy settings.
    process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false';
    process.env.CUA_DRIVER_RS_UPDATE_CHECK = 'false';
    driver = import('@trycua/cua-driver')
      .then(({ CuaDriver }) => CuaDriver.create({ embedded: true, claudeCodeCompatibility: false }))
      .catch(() => {
        driver = undefined;
        throw new Error('LOCAL_DRIVER_UNAVAILABLE');
      });
    return driver;
  }
  async function available(pid?: number, signal?: AbortSignal) {
    const sdk = await native();
    const result = await sdk.listWindows({ pid, onScreenOnly: true }, signal && { signal });
    return result.windows.filter(
      (window) =>
        window.pid &&
        window.pid !== process.pid &&
        window.windowId > 0n &&
        window.windowId <= 0xffffffffn &&
        window.isOnScreen !== false &&
        !window.minimized &&
        (window.layer === undefined || window.layer === 0) &&
        window.bounds.width >= 32 &&
        window.bounds.height >= 32,
    );
  }
  return {
    async windows() {
      return (await available()).map((window) => ({
        id: windowId(window),
        name: windowName(window),
      }));
    },
    async forWindow(id: string): Promise<WindowDriver> {
      const pid = Number(id.split(':')[1]);
      async function current(signal?: AbortSignal) {
        const target = (await available(pid, signal)).find((window) => windowId(window) === id);
        if (!target) throw new Error('LOCAL_WINDOW_UNAVAILABLE');
        return target;
      }
      const initial = await current();
      const target = { kind: 'window', pid, window_id: Number(initial.windowId) };
      let active: AbortController | undefined;
      let observation: { frame: LocalCapture; elements: CuaElement[] } | undefined;
      async function run<T>(operation: (sdk: CuaDriverLike, signal: AbortSignal) => Promise<T>) {
        const abort = new AbortController();
        active = abort;
        try {
          return await operation(await native(), abort.signal);
        } finally {
          active = undefined;
        }
      }
      return {
        name: windowName(initial),
        async context() {
          return context(await current());
        },
        interrupt() {
          active?.abort();
          observation = undefined;
        },
        capture() {
          observation = undefined;
          return run(async (sdk, signal) => {
            const window = await current(signal);
            // The generic result retains AX subroles, which distinguish password fields.
            const result = await sdk.callTool(
              'get_window_state',
              JSON.stringify({
                pid,
                window_id: target.window_id,
                include_accessibility_tree: true,
                tree_format: 'elements',
                include_screenshot: true,
                max_image_dimension: 1280,
              }),
              { signal },
            );
            if (result.isError || !result.structuredJson || result.images.length !== 1)
              throw new Error('LOCAL_SCREEN_UNAVAILABLE');
            const state = JSON.parse(result.structuredJson) as WindowSnapshot;
            if (
              state.pid !== pid ||
              state.window_id !== target.window_id ||
              (state.window_bounds && geometry(state.window_bounds) !== geometry(window.bounds)) ||
              context(await current(signal)) !== context(window)
            )
              throw new Error('LOCAL_SCREEN_CHANGED');
            if (state.screenshot_frame_valid === false) throw new Error('LOCAL_SCREEN_UNAVAILABLE');
            const image = nativeImage.createFromBuffer(
              Buffer.from(result.images[0].dataBase64, 'base64'),
            );
            if (image.isEmpty()) throw new Error('LOCAL_SCREEN_UNAVAILABLE');
            signal.throwIfAborted();
            const frame = {
              image: `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`,
              ...image.getSize(),
              context: context(window),
              bounds: window.bounds,
            };
            observation = { frame, elements: state.elements ?? [] };
            return frame;
          });
        },
        input(action, frame, check) {
          return run(async (sdk, signal) => {
            // The pinned Windows SDK does not expose UI Automation's password property in snapshots.
            const textAllowed = platform === 'darwin' && action.type === 'text';
            if (!textAllowed && !(action.type === 'click' && !action.button))
              throw new Error('LOCAL_WINDOW_ACTION_UNSUPPORTED');
            const { x, y } = action;
            if (
              x === undefined ||
              y === undefined ||
              x < 0 ||
              y < 0 ||
              x >= frame.width ||
              y >= frame.height
            )
              throw new Error('LOCAL_INVALID_COORDINATE');
            const observed = observation;
            if (observed?.frame !== frame || context(await current(signal)) !== frame.context)
              throw new Error('LOCAL_SCREEN_CHANGED');
            signal.throwIfAborted();
            const token = elementAt(observed.elements, frame, x, y, action.type, platform);
            if (!token) throw new Error('LOCAL_WINDOW_ACTION_UNSUPPORTED');
            check();
            // A coordinate-based action can move the system pointer. Use the element token from this frame.
            const result = await sdk.callTool(
              action.type === 'text' ? 'type_text' : 'click',
              JSON.stringify({
                target,
                element_token: token,
                delivery_mode: 'background',
                ...(action.type === 'text' ? { text: action.text } : {}),
              }),
              { signal },
            );
            if (result.isError || result.action?.error)
              throw new Error('LOCAL_WINDOW_ACTION_UNSUPPORTED');
          });
        },
      };
    },
    async close() {
      if (!driver) return;
      const sdk = await driver.catch(() => undefined);
      driver = undefined;
      if (!sdk) return;
      try {
        await sdk.shutdown();
      } finally {
        if ('uniffiDestroy' in sdk && typeof sdk.uniffiDestroy === 'function') sdk.uniffiDestroy();
      }
    },
  };
}
