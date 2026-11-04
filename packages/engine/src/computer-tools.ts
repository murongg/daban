import type { BrowserBinding, BrowserView } from '@daban/protocol';
import type { BrowserDriver } from './browser-tools.js';
import type { Control } from './control.js';
import { errorCode, Fault } from './control.js';
import { nativeInput } from './desktop.js';

export const computerToolList = [
  {
    name: 'screenshot',
    description:
      'Observe your own screen. desktop is the full Linux display (1280x800); browser is your shared-login web page (960x640). Only needed before GUI actions, and again after human takeover. Ordinary conversation and workspace tools need no screenshot.',
    inputSchema: {
      type: 'object',
      properties: { surface: { type: 'string', enum: ['desktop', 'browser'] } },
      required: ['surface'],
      additionalProperties: false,
    },
  },
  {
    name: 'act',
    description:
      'Operate the most recently observed surface. Send 1–4 sequential inputs per call; split longer sequences across calls and inspect each returned screenshot. Desktop keys use lowercase modifiers ctrl/alt/shift/super and named keys Return, Home, End, Left, Right, Page_Up, Page_Down, e.g. ctrl+End. Browser keys use Enter, Home, End, ArrowLeft, Alt+ArrowLeft, ControlOrMeta+A. Text pastes UTF-8. Coordinates are pixels of that surface. Returns a fresh screenshot. Do not call computer tools in parallel.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['desktop', 'browser'] },
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['click', 'key', 'text', 'scroll', 'pointer'] },
              x: { type: 'number' },
              y: { type: 'number' },
              key: {
                type: 'string',
                description:
                  'Required for key input. Desktop: ctrl+End, Home, Return. Browser: ControlOrMeta+A, Alt+ArrowLeft, Enter.',
              },
              text: { type: 'string' },
              button: { type: 'integer' },
              phase: { type: 'string' },
              deltaY: { type: 'number' },
            },
            required: ['type'],
            additionalProperties: false,
          },
        },
      },
      required: ['surface', 'actions'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_app',
    description:
      'Open or focus a real native application on your desktop. Shared browser is a native viewer; use the browser surface tools for web interaction. Returns the complete desktop screenshot.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', enum: ['terminal', 'files', 'editor', 'browser'] } },
      required: ['app'],
      additionalProperties: false,
    },
  },
];

export interface ToolTrace {
  name: string;
  surface: string;
  args?: Record<string, unknown>;
  at: string;
  phase: 'running' | 'settled' | 'rejected';
  code?: string;
}
export interface ToolRun {
  id?: string;
  conversationId?: string;
  bot: string;
  abort: AbortController;
  toolCount: number;
  limit: number;
  seen: Record<string, number>;
  browserSeen?: BrowserBinding;
  desktopSeen?: string;
  trace: ToolTrace[];
  waitingForComputer?: boolean;
  onComputerWait?: () => unknown;
  onLimit?: () => unknown;
}
export interface ComputerFacade {
  available?: (bot: string) => boolean;
  admit?: (bot: string) => boolean;
  stopWorker?: (bot: string) => Promise<unknown>;
  control: Control;
  frame: (bot: string, instance?: string, epoch?: number) => Promise<Buffer>;
  screens: {
    instance?: (bot: string) => string;
    openApp: (bot: string, app: string) => Promise<unknown>;
    input: (bot: string, input: unknown) => Promise<unknown>;
  };
  browser: {
    available?: (bot: string) => boolean;
    tabs?: BrowserDriver;
    frame: (bot: string) => Promise<Buffer>;
    view?: (bot: string) => Promise<BrowserView>;
    input: (
      bot: string,
      epoch: number,
      input: unknown,
      actor?: string,
      binding?: BrowserBinding,
    ) => Promise<unknown>;
  };
}
export interface ToolResult {
  isError?: boolean;
  content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string })[];
}
export class ComputerTools {
  authorize?: (run: ToolRun) => Promise<unknown>;
  private readonly waiters = new WeakMap<ToolRun, number>();
  constructor(readonly runtime: ComputerFacade) {}
  private assertDesktop(run: ToolRun) {
    const instance = this.runtime.screens.instance?.(run.bot);
    if (instance !== undefined && run.desktopSeen !== instance)
      throw new Fault('DESKTOP_VIEW_STALE');
  }
  async ready(run: ToolRun) {
    await this.authorize?.(run);
    await this.runtime.stopWorker?.(run.bot);
    const waiting = this.runtime.control.state(run.bot).owner !== 'agent';
    if (waiting) this.waiters.set(run, (this.waiters.get(run) || 0) + 1);
    run.waitingForComputer = (this.waiters.get(run) || 0) > 0;
    try {
      run.onComputerWait?.();
      while (this.runtime.control.state(run.bot).owner !== 'agent') {
        if (run.abort.signal.aborted) throw new Fault('MODEL_CANCELLED');
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      if (run.abort.signal.aborted) throw new Fault('MODEL_CANCELLED');
      await this.authorize?.(run);
      return this.runtime.control.state(run.bot);
    } finally {
      if (waiting) this.waiters.set(run, Math.max(0, (this.waiters.get(run) || 0) - 1));
      run.waitingForComputer = (this.waiters.get(run) || 0) > 0;
      run.onComputerWait?.();
    }
  }
  async shot(run: ToolRun, surface: string, epoch: number): Promise<ToolResult> {
    await this.authorize?.(run);
    const view = surface === 'browser' ? await this.runtime.browser.view?.(run.bot) : undefined;
    const instance = surface === 'desktop' ? this.runtime.screens.instance?.(run.bot) : undefined;
    if (view && (!view.image || view.paused)) throw new Fault('BROWSER_HUMAN_REQUIRED');
    const image =
      surface === 'desktop'
        ? await this.runtime.frame(run.bot, instance, epoch)
        : view
          ? Buffer.from(view.image!.slice('data:image/jpeg;base64,'.length), 'base64')
          : await this.runtime.browser.frame(run.bot);
    await this.authorize?.(run);
    if (this.runtime.control.state(run.bot).epoch !== epoch) throw new Fault('STALE_CONTROL');
    if (surface === 'desktop') {
      if (this.runtime.screens.instance?.(run.bot) !== instance)
        throw new Fault('DESKTOP_VIEW_STALE');
      run.desktopSeen = instance;
    }
    run.seen[surface] = epoch;
    if (surface === 'browser') run.browserSeen = view?.binding;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            bot: run.bot,
            surface,
            width: surface === 'desktop' ? 1280 : 960,
            height: surface === 'desktop' ? 800 : 640,
            epoch,
          }),
        },
        { type: 'image', mimeType: 'image/jpeg', data: image.toString('base64') },
      ],
    };
  }
  async invoke(
    run: ToolRun,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    let trace: ToolTrace | undefined;
    try {
      if (run.abort.signal.aborted) throw new Fault('MODEL_CANCELLED');
      if (++run.toolCount > run.limit) {
        run.onLimit?.();
        throw new Fault('TOOL_LIMIT');
      }
      const fields =
        name === 'screenshot'
          ? ['surface']
          : name === 'act'
            ? ['surface', 'actions']
            : name === 'open_app'
              ? ['app']
              : [];
      if (
        !fields.length ||
        !args ||
        typeof args !== 'object' ||
        Object.keys(args).some((key) => !fields.includes(key))
      )
        throw new Fault('INVALID_TOOL_ARGS', 400);
      const surface = (name === 'open_app' ? 'desktop' : args.surface) as string;
      if (!['desktop', 'browser'].includes(surface)) throw new Fault('INVALID_TOOL_ARGS', 400);
      if (
        name === 'act' &&
        (!Array.isArray(args.actions) || args.actions.length < 1 || args.actions.length > 4)
      )
        throw new Fault('INVALID_TOOL_ARGS', 400);
      if (
        name === 'open_app' &&
        !['terminal', 'files', 'editor', 'browser'].includes(String(args.app))
      )
        throw new Fault('INVALID_TOOL_ARGS', 400);
      if (name === 'act' && surface === 'desktop') (args.actions as unknown[]).forEach(nativeInput);
      const lease = await this.ready(run);
      if (name !== 'screenshot' && run.seen[surface] !== lease.epoch)
        throw new Fault('FRESH_SCREENSHOT_REQUIRED');
      trace = { name, surface, args, at: new Date().toISOString(), phase: 'running' };
      run.trace.push(trace);
      try {
        // A failed refresh or lost action acknowledgement must never leave older coordinates authorized.
        if (surface === 'desktop') delete run.seen.desktop;
        if (name === 'screenshot')
          return await this.runtime.control.execute(run.bot, 'agent', lease.epoch, () =>
            this.shot(run, surface, lease.epoch),
          );
        if (name === 'open_app') {
          return await this.runtime.control.execute(run.bot, 'agent', lease.epoch, async () => {
            await this.authorize?.(run);
            this.assertDesktop(run);
            await this.runtime.screens.openApp(run.bot, String(args.app));
            return this.shot(run, surface, lease.epoch);
          });
        }
        if (surface === 'desktop') {
          return await this.runtime.control.execute(run.bot, 'agent', lease.epoch, async () => {
            for (const input of args.actions as unknown[]) {
              if (run.abort.signal.aborted) throw new Fault('MODEL_CANCELLED');
              await this.authorize?.(run);
              this.assertDesktop(run);
              await this.runtime.screens.input(run.bot, input);
            }
            return this.shot(run, surface, lease.epoch);
          });
        }
        // Each browser input uses the same lease queue, rather than nesting that queue.
        if (this.runtime.browser.view && !run.browserSeen)
          throw new Fault('FRESH_SCREENSHOT_REQUIRED');
        for (const input of args.actions as unknown[]) {
          await this.authorize?.(run);
          await this.runtime.browser.input(run.bot, lease.epoch, input, 'agent', run.browserSeen);
        }
        return await this.runtime.control.execute(run.bot, 'agent', lease.epoch, () =>
          this.shot(run, surface, lease.epoch),
        );
      } finally {
        trace.phase = 'settled';
      }
    } catch (error) {
      if (errorCode(error) === 'STALE_CONTROL') await this.ready(run).catch(() => {});
      if (trace) {
        trace.phase = 'rejected';
        trace.code = errorCode(error) || 'COMPUTER_TOOL_FAILED';
      } else
        run.trace.push({
          name,
          surface: typeof args?.surface === 'string' ? args.surface : 'desktop',
          phase: 'rejected',
          code: errorCode(error) || 'COMPUTER_TOOL_FAILED',
          at: new Date().toISOString(),
        });
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `${errorCode(error) || 'COMPUTER_TOOL_FAILED'}: ${['WEB_APPROVAL_PENDING', 'WEB_APPROVAL_REJECTED'].includes(errorCode(error) || '') ? 'A web permission is pending or was rejected in this task. Do not switch to browser or computer tools to bypass it. Wait for a new explicit user request.' : ['STALE_CONTROL', 'FRESH_SCREENSHOT_REQUIRED', 'BROWSER_VIEW_STALE', 'DESKTOP_VIEW_STALE'].includes(errorCode(error) || '') ? 'The observed screen or control changed. Take a new screenshot before acting; do not reuse old coordinates.' : 'The action was not completed. Inspect the screen and correct the request.'}`,
          },
        ],
      };
    }
  }
}
