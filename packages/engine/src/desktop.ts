import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validAgentId } from '@daban/protocol';
import type { BrowserContext } from 'playwright';
import { ViewerGrants } from './authority.js';
import { errorCode, Fault } from './control.js';
import { DesktopSandbox } from './desktop-sandbox.js';
import { Native, nativeInput } from './native.js';

export { nativeInput } from './native.js';

import { type Browser, createBrowser } from './runtime.js';
import type { LegacySnapshot, WindowInfo } from './snapshot.js';

const dimensions = { width: 1280, height: 800 };
const quote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const running = (child: ChildProcess) =>
  child.pid !== undefined && child.exitCode === null && child.signalCode === null;
function exited(child: ChildProcess) {
  if (!running(child)) return Promise.resolve();
  return new Promise<unknown>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener('exit', finish);
      child.removeListener('close', finish);
      resolve(undefined);
    };
    const timer = setTimeout(finish, 1500);
    child.once('exit', finish);
    child.once('close', finish);
  });
}

async function waitFor<T>(
  action: () => Promise<T | undefined | false>,
  timeout = 10000,
): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  let failure: unknown;
  while (Date.now() < end) {
    try {
      const value = await action();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      failure = error;
    }
    await pause(100);
  }
  throw failure || new Error('Desktop operation timed out');
}

export interface DesktopOptions {
  profileDir: string;
  origin: string;
  viewers?: ViewerGrants;
  interval?: number;
  fixture?: boolean;
  dir?: string;
  displayBase?: number;
  fullGuest?: boolean;
}
export async function createDesktop({
  profileDir,
  origin,
  viewers,
  interval = 1600,
  dir,
  displayBase = 11,
  fixture = false,
  fullGuest = false,
}: DesktopOptions) {
  if (process.platform !== 'linux') throw new Error('Native desktops require Linux');
  dir ||= path.resolve(profileDir, '../desktops');
  const screens = new Screens({ dir, origin, viewers, displayBase, fullGuest });
  let browser: Browser | undefined;
  try {
    await screens.start();
    browser = await createBrowser({
      profileDir,
      origin,
      interval,
      fixture,
      workerAction: async (id, page) => {
        // Web and native tools share one lease; a takeover must pause both together.
        if (await page.locator('#increment').isEnabled()) await page.locator('#increment').click();
        await screens.step(id);
      },
    });
    return new Desktop(browser, screens);
  } catch (error) {
    if (browser) await browser.close();
    await screens.close();
    throw error;
  }
}

export interface ScreenInfo {
  id: string;
  instance: string;
  directory: string;
  workspace: string;
  env: NodeJS.ProcessEnv & { DISPLAY: string; XAUTHORITY: string };
  display: string;
  steps: number;
  lastAction: string;
  note: string;
  file: string;
  error?: string;
  sandbox?: DesktopSandbox;
}
export class Screens {
  private stopping?: Promise<unknown>;
  private stopped = false;
  dir: string;
  origin: string;
  readonly viewers: ViewerGrants;
  private readonly privateDirectory: string;
  displayBase: number;
  bots: Map<string, ScreenInfo>;
  children: ChildProcess[];
  closed: boolean;
  log?: FileHandle;
  logFd?: number;
  constructor({
    dir,
    origin,
    viewers,
    displayBase,
    fullGuest = false,
    workspace,
  }: {
    dir: string;
    origin: string;
    viewers?: ViewerGrants;
    displayBase: number;
    fullGuest?: boolean;
    workspace?: string;
  }) {
    this.dir = dir;
    this.origin = origin;
    this.viewers = viewers ?? new ViewerGrants();
    this.privateDirectory = path.resolve(dir, '../model/graphics', randomUUID());
    this.displayBase = displayBase;
    this.bots = new Map();
    this.children = [];
    this.fullGuest = fullGuest;
    this.workspaceRoot = workspace;
    this.closed = false;
  }
  private readonly fullGuest: boolean;
  private readonly workspaceRoot?: string;
  screen(id: string) {
    // A successor can reuse the display and Xauthority path; retired drivers must never resolve either again.
    if (this.closed) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
    const screen = this.bots.get(id);
    if (!screen) throw new Fault('UNKNOWN_BOT', 404);
    return screen;
  }
  instance(id: string) {
    return this.screen(id).instance;
  }
  private sandbox(screen: ScreenInfo) {
    if (!screen.sandbox) throw new Fault('DESKTOP_SANDBOX_UNAVAILABLE', 503);
    return screen.sandbox;
  }
  private write(
    screen: ScreenInfo,
    file: string,
    text: string,
    options: { mode?: number; flag?: string } = {},
  ) {
    return this.sandbox(screen).io(screen, {
      op: 'write',
      file,
      text,
      mode: options.mode,
      exclusive: options.flag === 'wx',
    });
  }
  private read(screen: ScreenInfo, file: string) {
    return this.sandbox(screen).io(screen, { op: 'read', file });
  }
  async run(id: string, program: string, args: string[]) {
    const screen = this.screen(id);
    const result = await this.sandbox(screen).exec(screen, program, args);
    return { stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
  }
  spawn(id: string, program: string, args: string[]) {
    const screen = this.screen(id);
    const command = this.sandbox(screen).command(screen, program, args);
    const child = spawn(command.program, command.args, {
      env: command.env,
      detached: true,
      stdio: ['ignore', this.logFd ?? 'ignore', this.logFd ?? 'ignore', ...command.fds],
    });
    child.on('error', (error) => {
      screen.error = error.message;
    });
    this.children.push(child);
    child.unref();
    return child;
  }
  async start(ids: readonly string[] = ['a', 'b']) {
    if (this.closed) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 16 ||
      !ids.every(validAgentId) ||
      new Set(ids).size !== ids.length
    )
      throw new Fault('INVALID_COMPUTER_ID', 400);
    await mkdir(this.privateDirectory, { recursive: true, mode: 0o700 });
    this.log = await open(path.join(this.privateDirectory, 'desktop.log'), 'ax', 0o600);
    this.logFd = this.log.fd;
    for (const [offset, id] of ids.entries()) {
      const directory = path.join(this.dir, id);
      const workspace = this.workspaceRoot ?? path.join(this.dir, 'shared');
      const env: ScreenInfo['env'] = {
        HOME: workspace,
        PATH: `${workspace}/.local/bin:/usr/bin:/bin`,
        LANG: 'C.UTF-8',
        DISPLAY: `:${this.displayBase + offset}`,
        XAUTHORITY: path.join(directory, 'Xauthority'),
        XDG_CONFIG_HOME: path.join(directory, 'config'),
        XDG_CACHE_HOME: path.join(directory, 'cache'),
        XDG_DATA_HOME: path.join(directory, 'data'),
        XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
      };
      delete env.DBUS_SESSION_BUS_ADDRESS;
      const screen: ScreenInfo = {
        id,
        instance: randomUUID(),
        directory,
        workspace,
        env,
        display: env.DISPLAY,
        steps: 0,
        lastAction: '桌面已准备',
        note: path.join(workspace, `note-${id}.txt`),
        file: path.join(workspace, `bot-${id}.txt`),
      };
      this.bots.set(id, screen);
      screen.sandbox = new DesktopSandbox(
        this.dir,
        path.join(this.privateDirectory, screen.instance),
        this.fullGuest,
      );
      await screen.sandbox.start();
      for (const name of ['', 'config', 'cache', 'data', 'runtime'])
        await screen.sandbox.io(screen, { op: 'mkdir', file: path.join(directory, name) });
      await screen.sandbox.io(screen, { op: 'mkdir', file: workspace });
      await this.write(
        screen,
        path.join(directory, 'viewer-token'),
        this.viewers.issue(id, screen.instance),
      );
      // Seed new notes only; rebuilding a desktop must never alter edited documents.
      try {
        await this.write(screen, screen.note, `Bot ${id.toUpperCase()} 的独立 Linux 桌面笔记\n`, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      await this.write(screen, env.XAUTHORITY, '', { mode: 0o600 });
      await this.run(id, 'xauth', [
        '-f',
        env.XAUTHORITY,
        'add',
        env.DISPLAY,
        '.',
        randomBytes(16).toString('hex'),
      ]);
      this.spawn(id, 'Xvfb', [
        env.DISPLAY,
        '-screen',
        '0',
        '1280x800x24',
        '-nolisten',
        'tcp',
        '-auth',
        env.XAUTHORITY,
        '-noreset',
      ]);
      await waitFor(async () => {
        await this.run(id, 'xdpyinfo', []);
        return true;
      });
      await this.configure(screen);
      const session = path.join(directory, 'session.sh');
      await this.write(
        screen,
        session,
        `#!/bin/sh\nprintf '%s' "$DBUS_SESSION_BUS_ADDRESS" > ${quote(path.join(directory, 'bus'))}\nxsetroot -solid '#e6e8e3'\ntint2 -c ${quote(path.join(directory, 'tint2rc'))} &\nexec openbox --config-file ${quote(path.join(directory, 'rc.xml'))}\n`,
        { mode: 0o700 },
      );
      this.spawn(id, 'dbus-run-session', ['--', '/bin/sh', session]);
      screen.env.DBUS_SESSION_BUS_ADDRESS = await waitFor(async () =>
        (await this.read(screen, path.join(directory, 'bus'))).trim(),
      );
      await waitFor(async () => {
        const { stdout } = await this.run(id, 'wmctrl', ['-m']);
        if (!stdout.includes('Openbox')) return false;
        // The manager name can appear before its EWMH client list is ready for application discovery.
        await this.windows(id);
        return true;
      });
      await this.openApp(id, 'terminal');
      await this.openApp(id, 'files');
    }
  }
  async configure(screen: ScreenInfo) {
    const { id, directory, workspace } = screen;
    const launch = path.join(directory, 'launch.sh');
    const viewerArgs = [
      'python3',
      this.fullGuest ? fileURLToPath(new URL('./viewer.py', import.meta.url)) : '/app/viewer.py',
      '--bot',
      id,
      '--origin',
      this.origin,
      '--token-file',
      path.join(directory, 'viewer-token'),
      '--layout-file',
      path.join(directory, 'viewer-layout.json'),
    ]
      .map(quote)
      .join(' ');
    const commands = {
      terminal: `env PS1=${quote(`Bot ${id.toUpperCase()} $ `)} xterm -title 'Bot ${id.toUpperCase()} Terminal' -fa 'DejaVu Sans Mono' -fs 11 -geometry 67x20+20+55 -e /bin/bash --noprofile --norc`,
      files: `thunar ${quote(workspace)}`,
      editor: `mousepad ${quote(screen.note)}`,
      browser: viewerArgs,
    };
    await this.write(
      screen,
      launch,
      `#!/bin/sh\ncd ${quote(workspace)}\ncase "$1" in\n${Object.entries(commands)
        .map(([app, command]) => `${app}) exec ${command} ;;`)
        .join('\n')}\nesac\n`,
      { mode: 0o700 },
    );
    const labels: Record<string, string> = {
      terminal: '终端',
      files: '文件管理器',
      editor: '文本编辑器',
      browser: '共享浏览器',
    };
    const icons: Record<string, string> = {
      terminal: 'utilities-terminal',
      files: 'system-file-manager',
      editor: 'accessories-text-editor',
      browser: 'web-browser',
    };
    const menu = Object.entries(labels)
      .map(
        ([app, name]) =>
          `<item label="${name}"><action name="Execute"><command>${launch} ${app}</command></action></item>`,
      )
      .join('');
    await this.write(
      screen,
      path.join(directory, 'menu.xml'),
      `<openbox_menu xmlns="http://openbox.org/3.4/menu"><menu id="root-menu" label="Bot ${id.toUpperCase()} Linux 桌面">${menu}</menu></openbox_menu>`,
    );
    const config = (await readFile('/etc/xdg/openbox/rc.xml', 'utf8'))
      .replace('<file>menu.xml</file>', `<file>${directory}/menu.xml</file>`)
      .replace('<number>4</number>', '<number>1</number>')
      .replace(
        '</keyboard>',
        `<keybind key="C-A-t"><action name="Execute"><command>${launch} terminal</command></action></keybind></keyboard>`,
      );
    await this.write(screen, path.join(directory, 'rc.xml'), config);
    for (const app of Object.keys(commands))
      await this.write(
        screen,
        path.join(directory, `${app}.desktop`),
        `[Desktop Entry]\nType=Application\nName=${labels[app]}\nIcon=${icons[app]}\nExec=${launch} ${app}\nTerminal=false\n`,
      );
    const items = Object.keys(commands)
      .map((app) => `launcher_item_app = ${directory}/${app}.desktop`)
      .join('\n');
    await this.write(
      screen,
      path.join(directory, 'tint2rc'),
      `rounded = 0\nborder_width = 0\nbackground_color = #252724 100\npanel_items = LTSC\npanel_size = 100% 38\npanel_position = bottom center horizontal\npanel_background_id = 1\npanel_padding = 10 5 10\nlauncher_icon_size = 24\nlauncher_padding = 4 0 8\n${items}\ntaskbar_mode = single_desktop\ntask_icon = 1\ntask_text = 1\ntask_font = Noto Sans 9\ntask_font_color = #ffffff 100\ntask_maximum_size = 220 30\nmouse_left = toggle_iconify\nmouse_middle = close\ntime1_format = %H:%M\ntime1_font = Noto Sans 10\nclock_font_color = #ffffff 100\n`,
    );
  }
  async windows(id: string): Promise<WindowInfo[]> {
    const { stdout } = await this.run(id, 'wmctrl', ['-lpGx']);
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const p = line.trim().split(/\s+/);
        return {
          id: p[0],
          pid: Number(p[2]),
          x: Number(p[3]),
          y: Number(p[4]),
          width: Number(p[5]),
          height: Number(p[6]),
          class: p[7],
          title: p.slice(9).join(' '),
        };
      });
  }
  async openApp(id: string, app: string) {
    const screen = this.screen(id);
    const patterns: Record<string, RegExp> = {
      terminal: /xterm/i,
      files: /thunar/i,
      editor: /mousepad/i,
      browser: /BotBrowser/i,
    };
    if (!patterns[app]) throw new Fault('INVALID_APP', 400);
    let window = (await this.windows(id)).filter((win) => patterns[app].test(win.class)).at(-1);
    const created = !window;
    if (!window) {
      this.spawn(id, '/bin/sh', [path.join(screen.directory, 'launch.sh'), app]);
      window = await waitFor(async () =>
        (await this.windows(id)).find((win) => patterns[app].test(win.class)),
      );
    }
    if (!window) throw new Fault('WINDOW_NOT_FOUND');
    const windowId = window.id;
    // Existing editors may show documents opened by the user, not the initial note.
    if (app === 'editor' && created)
      await waitFor(async () =>
        (await this.windows(id)).some(
          (win) => win.id === windowId && win.title.includes(path.basename(screen.note)),
        ),
      );
    // A window-manager activation request is asynchronous; synchronize before sending shortcuts.
    await this.run(id, 'xdotool', ['windowactivate', '--sync', window.id]);
    await this.run(id, 'xdotool', ['windowfocus', '--sync', window.id]);
    if (app === 'files') await this.run(id, 'wmctrl', ['-ir', window.id, '-e', '0,660,65,590,530']);
    if (app === 'browser') {
      await this.run(id, 'wmctrl', ['-ir', window.id, '-e', '0,100,20,1060,720']);
      const movedAt = Date.now();
      await waitFor(
        async () =>
          JSON.parse(await this.read(screen, path.join(screen.directory, 'viewer-layout.json')))
            .updatedAt >= movedAt,
      );
    }
    return window;
  }
  async input(id: string, input: unknown) {
    const action = nativeInput(input);
    if (Array.isArray(action)) await this.run(id, 'xdotool', action);
    else {
      const screen = this.screen(id);
      await this.sandbox(screen).exec(screen, 'python3', ['/app/desktop.py', 'text'], action.text);
    }
  }
  async release(id: string) {
    await this.input(id, { type: 'release' });
  }
  async frame(id: string) {
    const screen = this.screen(id);
    return (await this.sandbox(screen).exec(screen, 'python3', ['/app/desktop.py', 'frame']))
      .stdout;
  }
  async step(id: string) {
    const screen = this.screen(id);
    const number = screen.steps + 1;
    await this.openApp(id, 'terminal');
    await this.run(id, 'xdotool', ['key', '--clearmodifiers', 'ctrl+c', 'key', 'ctrl+u']);
    const command = `printf 'Bot ${id.toUpperCase()} GUI step ${number}\\n' >> ${quote(screen.file)}`;
    await this.run(id, 'xdotool', ['type', '--clearmodifiers', '--delay', '0', '--', command]);
    await this.run(id, 'xdotool', ['key', 'Return']);
    await waitFor(async () =>
      (await this.read(screen, screen.file)).includes(`GUI step ${number}`),
    );
    if (number % 3 === 2) await this.openApp(id, 'files');
    if (number % 3 === 0) await this.openApp(id, 'editor');
    screen.steps = number;
    screen.lastAction = `终端已写入真实文件，第 ${number} 步`;
  }
  async close() {
    if (this.stopped) return;
    if (this.stopping) return this.stopping;
    this.closed = true;
    for (const screen of this.bots.values()) this.viewers.retire(screen.id, screen.instance);
    const pending = this.stop()
      .then(() => {
        this.stopped = true;
      })
      .finally(() => {
        this.stopping = undefined;
      });
    this.stopping = pending;
    return pending;
  }
  private async stop() {
    for (const child of [...this.children].reverse()) {
      if (running(child)) {
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {}
      }
    }
    await Promise.all(this.children.map(exited));
    for (const child of this.children) {
      if (running(child)) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }
    }
    await Promise.all(this.children.map(exited));
    // Retire IO immediately, but keep cleanup retryable until every owned root process is confirmed exited.
    if (this.children.some(running)) throw new Fault('COMPUTER_STOP_UNCONFIRMED', 503);
    if (this.log) {
      await this.log.close();
      this.log = undefined;
      this.logFd = undefined;
    }
    for (const screen of this.bots.values()) await screen.sandbox?.close();
    await rm(this.privateDirectory, { recursive: true, force: true });
  }
}

export class Desktop extends Native {
  constructor(
    readonly browser: Browser,
    screens: Screens,
  ) {
    super(browser.control, screens);
    this.context = browser.context;
    browser.log('system', '两个独立 Linux 桌面已就绪，可操作终端、文件和应用');
  }
  context: BrowserContext;
  page(id: string) {
    return this.browser.page(id);
  }
  async transfer(id: string, epoch: number, owner: string, instance?: string) {
    this.assertInstance(id, instance);
    return this.browser.transfer(id, epoch, owner, () => {
      this.assertInstance(id, instance);
      return this.screens.release(id);
    });
  }
  browserFrame(id: string) {
    return this.browser.frame(id);
  }
  browserInput(id: string, epoch: number, input: unknown) {
    return this.browser.input(id, epoch, input);
  }
  startWorker(id: string) {
    return this.browser.startWorker(id);
  }
  stopWorker(id: string) {
    return this.browser.stopWorker(id);
  }
  async snapshot(): Promise<LegacySnapshot> {
    const state = await this.browser.snapshot();
    state.mode = 'desktop';
    state.viewport = dimensions;
    for (const id of ['a', 'b']) {
      const screen = this.screens.screen(id);
      state.bots[id].instance = screen.instance;
      state.bots[id].desktop = {
        display: screen.display,
        steps: screen.steps,
        lastAction: screen.lastAction,
        windows: await this.screens.windows(id),
      };
      this.assertInstance(id, screen.instance);
    }
    return state;
  }
  async close() {
    try {
      await this.browser.close();
    } finally {
      await super.close();
    }
  }
}
