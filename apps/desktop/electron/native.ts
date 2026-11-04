import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  app,
  type BrowserWindow,
  desktopCapturer,
  screen,
  shell,
  systemPreferences,
} from 'electron';
import type { LocalCapture, LocalDriver } from './local-computer';

interface Automation {
  getActiveWindow(): number;
  getWindowRect(handle: number): { x: number; y: number; width: number; height: number };
  setKeyboardDelay(delay: number): unknown;
  setMouseDelay(delay: number): unknown;
  moveMouse(x: number, y: number): unknown;
  dragMouse(x: number, y: number): unknown;
  mouseClick(button: string): unknown;
  mouseToggle(state: string, button: string): unknown;
  keyTap(key: string, modifiers?: string[]): unknown;
  keyToggle(key: string, state: string): unknown;
  typeString(text: string): unknown;
  scrollMouse(x: number, y: number): unknown;
}
const modifiers: Record<string, string> = {
  cmd: 'command',
  command: 'command',
  meta: 'command',
  super: 'command',
  controlormeta: 'command',
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};
const keys: Record<string, string> = {
  return: 'enter',
  esc: 'escape',
  spacebar: 'space',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};
const yieldInput = () => new Promise((resolve) => setImmediate(resolve));
export function desktopDriver(
  window: () => BrowserWindow | undefined,
  platform: NodeJS.Platform = process.platform,
  load?: () => unknown,
): LocalDriver {
  let loaded: Automation | undefined;
  const wayland =
    platform === 'linux' &&
    (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
  const x11 = platform === 'linux' && !!process.env.DISPLAY && !wayland;
  const pressed = new Set<string>();
  const native = () => {
    if (loaded) return loaded;
    const require = createRequire(path.join(app.getAppPath(), 'package.json'));
    const value: unknown = load
      ? load()
      : require(
          platform === 'darwin'
            ? '@computer-use/libnut-darwin'
            : platform === 'linux'
              ? '@computer-use/libnut-linux'
              : '@computer-use/libnut-win32',
        );
    const names = [
      'getActiveWindow',
      'getWindowRect',
      'setKeyboardDelay',
      'setMouseDelay',
      'moveMouse',
      'dragMouse',
      'mouseClick',
      'mouseToggle',
      'keyTap',
      'keyToggle',
      'typeString',
      'scrollMouse',
    ];
    if (
      !value ||
      typeof value !== 'object' ||
      names.some((name) => typeof Reflect.get(value, name) !== 'function')
    )
      throw new Error('LOCAL_DRIVER_UNAVAILABLE');
    loaded = value as Automation;
    loaded.setKeyboardDelay(0);
    loaded.setMouseDelay(0);
    return loaded;
  };
  const permissions = () => ({
    screen:
      platform === 'win32' ||
      x11 ||
      (platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'granted'),
    accessibility:
      platform === 'win32' ||
      x11 ||
      (platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false)),
  });
  const point = (frame: LocalCapture, x: number, y: number) => {
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height)
      throw new Error('LOCAL_INVALID_COORDINATE');
    const result = {
      x: Math.round(frame.bounds.x + (x / frame.width) * frame.bounds.width),
      y: Math.round(frame.bounds.y + (y / frame.height) * frame.bounds.height),
    };
    return platform === 'win32' ? screen.dipToScreenPoint(result) : result;
  };
  return {
    supported: ['darwin', 'win32'].includes(platform) || x11,
    platform:
      platform === 'darwin'
        ? 'darwin'
        : platform === 'win32'
          ? 'win32'
          : platform === 'linux'
            ? 'linux'
            : 'unsupported',
    ...(platform === 'linux' && !x11
      ? { reason: wayland ? 'LOCAL_WAYLAND_UNAVAILABLE' : 'LOCAL_DISPLAY_UNAVAILABLE' }
      : {}),
    permissions,
    prepare() {
      native();
      return undefined;
    },
    async requestPermissions() {
      if (platform === 'win32') return;
      if (platform !== 'darwin') throw new Error('LOCAL_PLATFORM_UNSUPPORTED');
      if (!systemPreferences.isTrustedAccessibilityClient(true)) {
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        );
        return;
      }
      // A zero-sized thumbnail only enumerates sources and cannot register the first recording request.
      // Discard this one-pixel permission probe; model frames still require a separate Bot grant.
      if (!permissions().screen)
        await desktopCapturer
          .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
          .catch(() => []);
      if (!permissions().screen)
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        );
    },
    async context() {
      return String(native().getActiveWindow());
    },
    async capture() {
      const display = screen.getPrimaryDisplay(),
        context = native().getActiveWindow();
      if (context) {
        const bounds = native().getWindowRect(context);
        const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        // Native Windows bounds are physical pixels; Electron display bounds are DIP. Reject unseen foreground windows.
        const point = platform === 'win32' ? screen.screenToDipPoint(center) : center;
        if (
          point.x < display.bounds.x ||
          point.y < display.bounds.y ||
          point.x >= display.bounds.x + display.bounds.width ||
          point.y >= display.bounds.y + display.bounds.height
        )
          throw new Error('LOCAL_OTHER_DISPLAY');
      }
      const height = Math.round((1280 * display.bounds.height) / display.bounds.width);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const sources = await Promise.race([
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height } }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('LOCAL_SCREEN_UNAVAILABLE')), 3000);
        }),
      ]).finally(() => clearTimeout(timeout));
      const source =
        sources.find((item) => item.display_id === String(display.id)) ??
        (sources.length === 1 ? sources[0] : undefined);
      if (!source || source.thumbnail.isEmpty()) throw new Error('LOCAL_SCREEN_UNAVAILABLE');
      if (native().getActiveWindow() !== context) throw new Error('LOCAL_SCREEN_CHANGED');
      const image = source.thumbnail.resize({ width: 1280 });
      return {
        image: `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`,
        ...image.getSize(),
        context: String(context),
        bounds: { ...display.bounds },
      };
    },
    async input(input, frame, check) {
      await yieldInput();
      check();
      const api = native();
      // Focus can change while Unicode input yields; never send the remaining chunks to an unseen window.
      const checkContext = () => {
        check();
        if (String(api.getActiveWindow()) !== frame.context)
          throw new Error('LOCAL_SCREEN_CHANGED');
      };
      checkContext();
      if (input.type === 'key') {
        const parts = input.key.toLowerCase().split('+'),
          last = parts.pop()!;
        const key = keys[last] || last;
        const mods = parts.map((value) =>
          value === 'controlormeta' && platform !== 'darwin'
            ? 'control'
            : modifiers[value === 'win' ? 'super' : value],
        );
        if (
          mods.some((value) => !value) ||
          !/^([a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|enter|tab|space|escape|up|down|left|right|backspace|delete|home|end|pageup|pagedown|insert)$/.test(
            key,
          )
        )
          throw new Error('LOCAL_INVALID_KEY');
        api.keyTap(key, [...new Set(mods)]);
      } else if (input.type === 'text') {
        const characters = Array.from(input.text);
        // Yield between bounded Unicode chunks so pause/stop can fence the remaining input.
        for (let offset = 0; offset < characters.length; offset += 64) {
          checkContext();
          api.typeString(characters.slice(offset, offset + 64).join(''));
          await yieldInput();
        }
      } else {
        const location = point(frame, input.x ?? frame.width / 2, input.y ?? frame.height / 2);
        const button = ['left', 'middle', 'right'][
          ('button' in input ? input.button : undefined) ?? 0
        ];
        if (input.type === 'scroll') {
          api.moveMouse(location.x, location.y);
          api.scrollMouse(
            0,
            -Math.sign(input.deltaY) * Math.max(1, Math.round(Math.abs(input.deltaY) / 40)),
          );
        } else if (input.type === 'click') {
          api.moveMouse(location.x, location.y);
          checkContext();
          api.mouseClick(button);
        } else if (input.phase === 'down') {
          api.moveMouse(location.x, location.y);
          pressed.add(button);
          api.mouseToggle('down', button);
        } else if (input.phase === 'up') {
          api.moveMouse(location.x, location.y);
          api.mouseToggle('up', button);
          pressed.delete(button);
        } else if (pressed.size) api.dragMouse(location.x, location.y);
        else api.moveMouse(location.x, location.y);
      }
      check();
    },
    async openApp(name) {
      if (platform === 'linux') {
        const programs: Record<string, string[]> = {
          terminal: ['/usr/bin/x-terminal-emulator', '/usr/bin/gnome-terminal', '/usr/bin/konsole'],
          files: ['/usr/bin/nautilus', '/usr/bin/thunar', '/usr/bin/dolphin'],
          editor: [
            '/usr/bin/gnome-text-editor',
            '/usr/bin/gedit',
            '/usr/bin/mousepad',
            '/usr/bin/kate',
          ],
          browser: ['/usr/bin/x-www-browser', '/usr/bin/chromium', '/usr/bin/firefox'],
        };
        for (const program of programs[name] ?? []) {
          if (
            !(await access(program).then(
              () => true,
              () => false,
            ))
          )
            continue;
          await new Promise<undefined>((resolve, reject) => {
            const child = spawn(program, [], { stdio: 'ignore', detached: true });
            child.once('error', () => reject(Error('LOCAL_APP_UNAVAILABLE')));
            child.once('spawn', () => {
              child.unref();
              resolve(undefined);
            });
          });
          return;
        }
        throw Error('LOCAL_APP_UNAVAILABLE');
      }
      if (platform === 'win32') {
        const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
        const result =
          name === 'browser'
            ? await shell.openExternal('about:blank')
            : await shell.openPath(
                name === 'files'
                  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
                  : path.join(system, name === 'terminal' ? 'cmd.exe' : 'notepad.exe'),
              );
        if (typeof result === 'string' && result) throw new Error('LOCAL_APP_UNAVAILABLE');
        return;
      }
      const applications: Record<string, string> = {
        terminal: '/System/Applications/Utilities/Terminal.app',
        files: '/System/Library/CoreServices/Finder.app',
        editor: '/System/Applications/TextEdit.app',
        browser: '/Applications/Safari.app',
      };
      if (!applications[name]) throw new Error('LOCAL_INVALID_REQUEST');
      const result = await shell.openPath(applications[name]);
      if (result) throw new Error('LOCAL_APP_UNAVAILABLE');
    },
    async release() {
      if (!loaded) return;
      // Escape cancels a drag before releasing our injected button, avoiding an unintended drop.
      if (pressed.size) loaded.keyTap('escape');
      for (const button of pressed) loaded.mouseToggle('up', button);
      pressed.clear();
    },
    async hide() {
      const current = window();
      if (!current || current.isDestroyed()) throw new Error('LOCAL_CLIENT_UNAVAILABLE');
      current.hide();
    },
  };
}
