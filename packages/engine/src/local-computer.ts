import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import {
  isLocalComputerFrame,
  isLocalComputerInput,
  isLocalComputerStatus,
  type LocalComputerFrame,
  type LocalComputerStatus,
  modelHasVision,
  unavailableLocalComputer,
} from '@daban/protocol';
import type { AgentToolRun } from './agent-tools.js';
import { privateClientOptions } from './private-channel.js';
import { privateMetadata } from './private-files.js';

export type { AgentToolRun } from './agent-tools.js';

import type { ToolResult } from './computer-tools.js';

export interface LocalComputerPort {
  readonly list: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  selected(bot: string): boolean;
  prepare(run: AgentToolRun): Promise<boolean>;
  resolveApp?(run: AgentToolRun, name: string): Promise<{ id: string; name: string }>;
  connectApp?(run: AgentToolRun, app: string): Promise<unknown>;
  invoke(run: AgentToolRun, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  cancel(run: AgentToolRun): Promise<unknown>;
}
export function localComputerPaths(dataRoot: string) {
  const hash = createHash('sha256').update(path.resolve(dataRoot)).digest('hex').slice(0, 24);
  return {
    socket:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\daban-local-${hash}`
        : `/tmp/daban-local-${process.getuid?.() ?? 0}-${hash}/s`,
    token: path.join(dataRoot, 'local-computer-token'),
    certificate: path.join(dataRoot, 'local-certificate.pem'),
  };
}
const actionProperties = {
  type: { type: 'string', enum: ['click', 'key', 'text', 'scroll', 'pointer'] },
  x: { type: 'number' },
  y: { type: 'number' },
  button: { type: 'integer' },
  phase: { type: 'string', enum: ['down', 'move', 'up'] },
  key: { type: 'string' },
  text: { type: 'string' },
  deltaY: { type: 'number' },
};
export const localComputerToolList: LocalComputerPort['list'] = [
  {
    name: 'screenshot',
    description:
      "Observe the person's approved real local desktop or application window. Requires an explicit local-computer connection and a vision model. Use surface desktop only. Follow the returned image dimensions. Ordinary conversation needs no screenshot.",
    inputSchema: {
      type: 'object',
      properties: { surface: { type: 'string', enum: ['desktop'] } },
      required: ['surface'],
      additionalProperties: false,
    },
  },
  {
    name: 'act',
    description:
      'Operate the real local surface observed by your latest screenshot. Coordinates are image pixels. For scope window, use one action at a time. Left-click an accessible control on macOS or Windows. On macOS, use text with x/y pointing at an editable field. Ask the user to handle unsupported controls. For desktop scope, use up to four sequential inputs. Use cmd on macOS, ctrl on Windows; win is the Windows key. A failed or uncertain action must not be replayed: observe first.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['desktop'] },
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: actionProperties,
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
      'Open a native app in a foreground desktop session after a fresh screenshot. For scope window, ask the user to connect the desired window. On macOS: Terminal, Finder, TextEdit, Safari. On Windows: command prompt, Explorer, Notepad, browser. Returns a fresh screenshot.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', enum: ['terminal', 'files', 'editor', 'browser'] } },
      required: ['app'],
      additionalProperties: false,
    },
  },
];
export class LocalComputerClient implements LocalComputerPort {
  readonly list = localComputerToolList;
  modelRevision: () => Promise<number> = async () => 0;
  authorize?: (run: AgentToolRun) => Promise<unknown>;
  private cached: LocalComputerStatus = unavailableLocalComputer();
  private selection?: string;
  private readonly leases = new WeakMap<AgentToolRun, string>();
  private readonly observed = new WeakMap<AgentToolRun, LocalComputerFrame>();
  constructor(readonly dataRoot: string) {}
  private async rpc(
    method: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const locations = localComputerPaths(this.dataRoot);
    if (process.platform !== 'win32') {
      const folder = await lstat(path.dirname(locations.socket)).catch(() => undefined);
      if (
        !folder?.isDirectory() ||
        folder.isSymbolicLink() ||
        folder.uid !== process.getuid?.() ||
        (folder.mode & 0o777) !== 0o700
      )
        throw new Error('LOCAL_CLIENT_UNAVAILABLE');
      const socket = await lstat(locations.socket).catch(() => undefined);
      if (
        !socket?.isSocket() ||
        socket.isSymbolicLink() ||
        socket.uid !== process.getuid?.() ||
        (socket.mode & 0o077) !== 0
      )
        throw new Error('LOCAL_CLIENT_UNAVAILABLE');
    }
    const metadata = await lstat(locations.token).catch(() => undefined);
    if (
      !metadata?.isFile() ||
      metadata.isSymbolicLink() ||
      !(await privateMetadata(locations.token, metadata, 0o600)) ||
      metadata.size !== 64
    )
      throw new Error('LOCAL_CLIENT_UNAVAILABLE');
    const token = await readFile(locations.token, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('LOCAL_CLIENT_UNAVAILABLE');
    const body = JSON.stringify({ method, ...args });
    const tls = await privateClientOptions(locations.certificate);
    return new Promise((resolve, reject) => {
      const send = process.platform === 'win32' ? httpsRequest : httpRequest;
      const req = send(
        {
          ...tls,
          socketPath: locations.socket,
          path: '/',
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 6 * 1024 * 1024) req.destroy(new Error('LOCAL_INVALID_RESPONSE'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                ok?: boolean;
                value?: unknown;
                error?: unknown;
              };
              if (value.ok !== true)
                throw new Error(
                  typeof value.error === 'string' && /^LOCAL_[A-Z_]{1,70}$/.test(value.error)
                    ? value.error
                    : 'LOCAL_DRIVER_FAILED',
                );
              resolve(value.value);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(method === 'status' ? 500 : method === 'app.connect' ? 30_000 : 10_000, () =>
        req.destroy(new Error('LOCAL_CLIENT_UNAVAILABLE')),
      );
      req.on('error', reject);
      req.end(body);
    });
  }
  async status() {
    try {
      const value = await this.rpc('status', { scope: true }).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'LOCAL_INVALID_REQUEST')
          return this.rpc('status');
        throw error;
      });
      if (!isLocalComputerStatus(value)) throw new Error('LOCAL_INVALID_RESPONSE');
      this.cached = value;
      this.selection = value.session?.bot;
    } catch {
      this.cached = unavailableLocalComputer();
    }
    return this.cached;
  }
  selected(bot: string) {
    // Losing transport is not a human switch to the VM. Keep the backend choice until a trusted status releases it.
    return (this.cached.available ? this.cached.session?.bot : this.selection) === bot;
  }
  async prepare(run: AgentToolRun) {
    const previous = this.selected(run.bot);
    const status = await this.status();
    if (previous && !status.available) throw new Error('LOCAL_CLIENT_UNAVAILABLE');
    if (status.session?.bot !== run.bot) return false;
    this.leases.set(run, status.session.id);
    return true;
  }
  async resolveApp(run: AgentToolRun, name: string) {
    const value = await this.rpc('app.resolve', { name }, run.abort.signal);
    if (
      !value ||
      typeof value !== 'object' ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !('name' in value) ||
      typeof value.name !== 'string'
    )
      throw new Error('LOCAL_INVALID_RESPONSE');
    return { id: value.id, name: value.name };
  }
  async connectApp(run: AgentToolRun, app: string) {
    if (!run.id || !run.model) throw new Error('LOCAL_INVALID_REQUEST');
    await this.authorize?.(run);
    const modelRevision = await this.modelRevision();
    const value = await this.rpc(
      'app.connect',
      { app, bot: run.bot, runId: run.id, model: run.model, modelRevision },
      run.abort.signal,
    );
    if (!isLocalComputerStatus(value) || !value.session?.window || value.session.bot !== run.bot)
      throw new Error('LOCAL_INVALID_RESPONSE');
    this.leases.set(run, value.session.id);
    try {
      if ((await this.modelRevision()) !== modelRevision) throw new Error('LOCAL_MODEL_CHANGED');
      await this.authorize?.(run);
      run.abort.signal.throwIfAborted();
    } catch (error) {
      await this.cancel(run);
      throw error;
    }
  }
  private async binding(run: AgentToolRun) {
    const session = this.leases.get(run);
    if (!run.id || !run.model || !session) throw new Error('LOCAL_INVALID_REQUEST');
    return {
      session,
      bot: run.bot,
      runId: run.id,
      model: run.model,
      modelRevision: await this.modelRevision(),
    };
  }
  private async ready(run: AgentToolRun) {
    let status = await this.status();
    try {
      while (status.session?.bot === run.bot && status.session.owner === 'human') {
        run.abort.signal.throwIfAborted();
        run.waitingForComputer = true;
        run.onComputerWait?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await this.status();
      }
    } finally {
      run.waitingForComputer = false;
      run.onComputerWait?.();
    }
    if (status.session?.bot !== run.bot) throw new Error('LOCAL_NOT_CONNECTED');
    if (status.session.id !== this.leases.get(run)) throw new Error('LOCAL_SESSION_STALE');
    return status.session;
  }
  async invoke(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    let trace: AgentToolRun['trace'][number] | undefined;
    try {
      run.abort.signal.throwIfAborted();
      if (++run.toolCount > run.limit) {
        run.onLimit?.();
        throw new Error('TOOL_LIMIT');
      }
      if (!(run.vision ?? (!run.model || modelHasVision(run.model))))
        throw new Error('MODEL_COMPUTER_UNSUPPORTED');
      if (
        !this.list.some((tool) => tool.name === name) ||
        Object.keys(args).some(
          (key) =>
            !(
              name === 'act'
                ? ['surface', 'actions']
                : name === 'screenshot'
                  ? ['surface']
                  : ['app']
            ).includes(key),
        )
      )
        throw new Error('LOCAL_INVALID_REQUEST');
      if (name !== 'open_app' && args.surface !== 'desktop')
        throw new Error('LOCAL_INVALID_REQUEST');
      if (
        name === 'act' &&
        (!Array.isArray(args.actions) ||
          !args.actions.length ||
          args.actions.length > 4 ||
          !args.actions.every(isLocalComputerInput))
      )
        throw new Error('LOCAL_INVALID_REQUEST');
      await this.authorize?.(run);
      const session = await this.ready(run);
      await this.authorize?.(run);
      const binding = await this.binding(run);
      const previous = this.observed.get(run);
      if (name !== 'screenshot' && !previous) throw new Error('FRESH_SCREENSHOT_REQUIRED');
      trace = { name, surface: 'desktop', at: new Date().toISOString(), phase: 'running' };
      run.trace.push(trace);
      // Never retain an old observation across a failed/unknown native action acknowledgement.
      this.observed.delete(run);
      const value = await this.rpc(
        name,
        {
          ...binding,
          ...(name === 'act'
            ? { observation: previous!.observation, actions: args.actions }
            : name === 'open_app'
              ? { observation: previous!.observation, app: args.app }
              : {}),
        },
        run.abort.signal,
      );
      if (!isLocalComputerFrame(value) || value.bot !== run.bot || value.runId !== run.id)
        throw new Error('LOCAL_INVALID_RESPONSE');
      this.observed.set(run, value);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              computer: process.platform === 'win32' ? 'local-windows' : 'local-mac',
              surface: 'desktop',
              ...(session.window ? { scope: 'window' } : {}),
              width: value.width,
              height: value.height,
            }),
          },
          {
            type: 'image',
            mimeType: 'image/jpeg',
            data: value.image.slice('data:image/jpeg;base64,'.length),
          },
        ],
      };
    } catch (error) {
      if (trace) trace.phase = 'rejected';
      const code =
        error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : 'LOCAL_DRIVER_FAILED';
      return { isError: true, content: [{ type: 'text', text: code }] };
    } finally {
      if (trace?.phase === 'running') trace.phase = 'settled';
    }
  }
  async cancel(run: AgentToolRun) {
    const session = this.leases.get(run);
    this.observed.delete(run);
    // Retain the lease until cancellation is acknowledged, so a lost bridge response can be retried safely.
    if (run.id && session) await this.rpc('cancel', { runId: run.id, session });
    this.leases.delete(run);
  }
}

export { privateClientOptions, privateServer, windowsPrivatePipe } from './private-channel.js';
export { privateMetadata, secureDirectory } from './private-files.js';
