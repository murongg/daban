import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, link, lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectAccess, ProjectScope } from '@daban/protocol';
import {
  browserTaskCapability,
  documentLimit,
  isTaskFileName,
  type ModelId,
  modelExecutionCapability,
  modelHasVision,
  type TaskRequest,
} from '@daban/protocol';
import { BrowserTools } from './browser-tools.js';
import type { CatalogTools } from './catalog.js';
import {
  type ComputerFacade,
  ComputerTools,
  computerToolList,
  type ToolResult,
  type ToolRun,
  type ToolTrace,
} from './computer-tools.js';
import { errorCode, errorMessage, Fault } from './control.js';
import type { GroupTools } from './group-tools.js';
import type { HistoryTools } from './history.js';
import { imageInput } from './images.js';
import type { IntegrationTools } from './integration-tools.js';
import type { McpSnapshot } from './integrations.js';
import type { KnowledgeTools } from './knowledge-tools.js';
import type { LocalComputerPort } from './local-computer.js';
import type { MemoryTools } from './memory.js';
import type { NotesTools } from './notes-tools.js';
import type { ProjectResources } from './project-resources.js';
import type { WorkspaceExecutor } from './remote-workspace.js';
import { scheduleToolList } from './schedule-catalog.js';
import type { ScheduleTools } from './schedule-tools.js';
import type { SkillTools } from './skill-tools.js';
import type { SkillSnapshot } from './skills.js';
import type { SoftwareTools } from './software.js';
import type { WorkTools } from './work-tools.js';
import { type AgentWorkspace, WorkspaceFiles } from './workspace.js';

export interface AgentToolRun extends ToolRun {
  project?: ProjectScope;
  vision?: boolean;
  skills?: SkillSnapshot;
  sessionId?: string;
  integrations?: McpSnapshot;
  task?: TaskRequest;
  model?: ModelId;
  intentId?: string;
  redact?: (value: string) => string;
  redactResponse?: (value: string) => string;
  workdir: string;
  canonicalRoot: string;
}
const workspaceToolList = [
  {
    name: 'read_image',
    description:
      'Read an existing PNG/JPEG/GIF/WebP image from this task or /shared as actual pixels. Use for generated document previews. Requires an image-capable model; no desktop is needed.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List actual files without a screen. Relative paths and /workspace refer to this task. Use /shared for authorized shared files; returned paths are relative to the listed directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read text without opening an application. Relative paths and /workspace refer to this task; /shared reads the authorized shared workspace. offset/limit are character counts; follow nextOffset for a long file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 64000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Write UTF-8 text directly inside the current task directory. Existing parent directories are required. Use this for documents/code; do not open an editor unless the user asks.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'shell',
    description:
      'Execute Bash/Python in an isolated Linux workspace. /workspace is the writable current task; /shared contains read-only shared/prior Bot files. Save new results under /workspace; copy input there if mutable staging is needed. No network, private directories or credentials; 30-second/output limits. No GUI is opened.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
];
export const agentToolList = [...workspaceToolList, ...computerToolList];
const fields: Record<string, string[]> = {
  list_files: ['path'],
  read_image: ['path'],
  read_file: ['path', 'offset', 'limit'],
  write_file: ['path', 'content'],
  shell: ['command'],
};
const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
// Workspace paths are protocol values, including when the host filesystem uses backslashes.
const workspacePath = (root: string, file: string) =>
  path.relative(root, file).split(path.sep).join('/');

export class AgentTools {
  readonly browser?: BrowserTools;
  localComputer?: LocalComputerPort;
  private readonly localRequests = new WeakMap<AgentToolRun, Set<string>>();
  private readonly localRuns = new WeakMap<AgentToolRun, boolean>();
  groups?: GroupTools;
  memory?: MemoryTools;
  history?: HistoryTools;
  knowledge?: KnowledgeTools;
  work?: WorkTools;
  notes?: NotesTools;
  catalog?: CatalogTools;
  schedules?: ScheduleTools;
  integrations?: IntegrationTools;
  software?: SoftwareTools;
  skills?: SkillTools;
  readonly computer: ComputerTools | undefined;
  authorizeComputer?: (run: ToolRun) => Promise<unknown>;
  executeRemote?: (
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
    wireId: string | undefined,
    dispatch: (assertPolicy?: () => unknown) => Promise<ToolResult>,
  ) => Promise<ToolResult>;
  shellRunner?: (run: AgentToolRun, command: string) => Promise<unknown>;
  private readonly remoteCatalogs = new Map<
    string,
    { name: string; description: string; inputSchema: Record<string, unknown> }[]
  >();
  private readonly opened = new WeakSet<AgentToolRun>();
  private readonly active = new WeakMap<AgentToolRun, Set<Promise<ToolResult>>>();
  constructor(
    runtime: ComputerFacade | undefined,
    readonly workspace: AgentWorkspace,
    readonly options: {
      execution?: WorkspaceExecutor;
      nativeOnly?: boolean;
      projects?: ProjectResources;
      projectAccess?: (run: AgentToolRun, access: ProjectAccess) => unknown;
    } = {},
  ) {
    if (runtime) {
      this.computer = new ComputerTools(runtime);
      if (runtime.browser.tabs)
        this.browser = new BrowserTools(this.computer, runtime.browser.tabs, {
          read: (run, file) => this.browserInput(run, file),
          write: (run, name, bytes) => this.browserOutput(run, name, bytes),
        });
    }
  }
  localSelected(bot: string, run?: AgentToolRun) {
    return run ? this.localRuns.get(run) === true : this.localComputer?.selected(bot) === true;
  }
  hasComputer(bot: string, model?: ModelId, vision?: boolean, run?: AgentToolRun) {
    if (this.localSelected(bot, run)) return vision ?? (!model || modelHasVision(model));
    if (this.options.execution)
      return (
        (vision ?? (!model || modelHasVision(model))) &&
        !!this.remoteCatalogs.get(bot)?.some((tool) => tool.name === 'screenshot')
      );
    if (!this.computer || !(vision ?? (!model || modelHasVision(model)))) return false;
    try {
      if (this.computer.runtime.available?.(bot) === false) return false;
      this.computer.runtime.control.state(bot);
      return true;
    } catch {
      return false;
    }
  }
  hasBrowser(bot: string, run?: AgentToolRun) {
    if (this.localSelected(bot, run)) return false;
    if (this.options.execution)
      return !!this.remoteCatalogs.get(bot)?.some((tool) => tool.name === 'browser_snapshot');
    if (!this.browser || !this.computer) return false;
    try {
      if (
        this.computer.runtime.available?.(bot) === false ||
        this.computer.runtime.browser.available?.(bot) === false
      )
        return false;
      this.computer.runtime.control.state(bot);
      return true;
    } catch {
      return false;
    }
  }
  list(bot: string, model?: ModelId, conversationId?: string, run?: AgentToolRun) {
    const tools = this.options.execution
      ? this.remoteCatalogs.get(bot) || workspaceToolList
      : this.hasComputer(bot, model, run?.vision)
        ? agentToolList
        : workspaceToolList;
    const local = this.localSelected(bot, run);
    const offered = this.options.nativeOnly
      ? tools.filter((tool) => !workspaceToolList.some((item) => item.name === tool.name))
      : tools;
    const visible = offered.filter(
      (tool) => tool.name !== 'read_image' || (run?.vision ?? (!model || modelHasVision(model))),
    );
    return [
      ...(local
        ? visible.filter(
            (tool) =>
              !computerToolList.some((item) => item.name === tool.name) &&
              !tool.name.startsWith('browser_'),
          )
        : visible),
      ...(local && (run?.vision ?? (!model || modelHasVision(model)))
        ? this.localComputer?.list || []
        : []),
      ...(!this.options.execution && this.hasBrowser(bot, run) ? this.browser?.list || [] : []),
      ...(this.schedules ? scheduleToolList : []),
      ...(this.memory?.list || []),
      ...(this.history?.list || []),
      ...(this.knowledge?.list || []),
      ...(this.work?.list || []),
      ...(this.notes?.list || []),
      ...(this.software?.list || []),
      ...(run?.skills?.skills.length ? this.skills?.list || [] : []),
      ...(this.catalog?.list || []),
      ...(conversationId
        ? this.groups?.list || []
        : run?.bot === bot && run.task && !run.conversationId
          ? this.groups?.collaborationList || []
          : []),
      ...(run?.bot === bot && run.conversationId === conversationId
        ? this.integrations?.list(run) || []
        : []),
    ];
  }
  checkProject(run: AgentToolRun, access: ProjectAccess = 'read') {
    if (!run.project) return;
    this.options.projectAccess?.(run, access);
    this.options.projects?.get(run.project, run.bot, access);
    if (!this.options.projectAccess && !this.options.projects)
      throw new Fault('PROJECT_ACCESS_DENIED', 403);
  }
  async open(run: AgentToolRun) {
    this.checkProject(run);
    if (!this.localRuns.has(run))
      this.localRuns.set(run, (await this.localComputer?.prepare(run)) ?? false);
    if (!this.options.execution || this.opened.has(run)) return;
    const capabilities =
      this.options.execution.snapshot?.capabilities.includes(modelExecutionCapability);
    // Older guests validate exact fields and know only the two original model IDs.
    if (
      !capabilities &&
      run.model &&
      (!['deepseek-flash', 'deepseek-v4-pro'].includes(run.model) ||
        (run.vision !== undefined && run.vision !== modelHasVision(run.model)))
    )
      throw new Fault('EXECUTION_UPGRADE_REQUIRED', 409);
    // Pick execution fields explicitly: the live job also contains host credentials and private DSH paths.
    const result = (await this.options.execution.call(
      'tools.open',
      {
        id: run.id,
        bot: run.bot,
        ...(run.project ? { project: run.project } : {}),
        workdir: run.workdir,
        canonicalRoot: run.canonicalRoot,
        ...(run.model ? { model: run.model } : {}),
        ...(capabilities && run.vision !== undefined ? { vision: run.vision } : {}),
        // Pass the authorized prompt only. The host task also carries private memory and attachments.
        ...(this.options.execution.snapshot?.capabilities.includes(browserTaskCapability) &&
        run.task?.prompt.trim()
          ? { prompt: run.task.prompt }
          : {}),
        limit: run.limit,
      },
      run.abort.signal,
    )) as { tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
    if (
      !Array.isArray(result?.tools) ||
      !result.tools.every(
        (tool) =>
          tool &&
          typeof tool.name === 'string' &&
          typeof tool.description === 'string' &&
          tool.inputSchema &&
          typeof tool.inputSchema === 'object',
      )
    )
      throw new Fault('INVALID_EXECUTOR_RESPONSE', 503);
    this.remoteCatalogs.set(run.bot, result.tools);
    this.opened.add(run);
  }
  invoke(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown> = {},
    wireId?: string,
  ): Promise<ToolResult> {
    let calls = this.active.get(run);
    if (!calls) {
      calls = new Set();
      this.active.set(run, calls);
    }
    const call = this.perform(run, name, args, wireId);
    calls.add(call);
    return call.finally(() => {
      calls.delete(call);
    });
  }
  async drain(run: AgentToolRun) {
    await Promise.allSettled([...(this.active.get(run) || [])]);
    if (this.localRuns.get(run)) await this.localComputer?.cancel(run);
    if (this.options.execution && this.opened.has(run)) {
      await this.options.execution.call('tools.drain', { runId: run.id });
      this.opened.delete(run);
    }
  }
  async cancel(run: AgentToolRun) {
    if (this.localRuns.get(run)) await this.localComputer?.cancel(run);
    if (this.options.execution && this.opened.has(run))
      await this.options.execution.call('tools.cancel', { runId: run.id });
  }
  private async remote(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
    wireId?: string,
  ): Promise<ToolResult> {
    let trace: ToolTrace | undefined;
    try {
      this.checkProject(run, name.startsWith('browser_') ? 'browser' : 'read');
      args = structuredClone(args);
      run.abort.signal.throwIfAborted();
      if (++run.toolCount > run.limit) {
        run.onLimit?.();
        throw new Fault('TOOL_LIMIT');
      }
      const raw = ['shell', 'process_start', 'process_input'].includes(name);
      const computer =
        raw || computerToolList.some((tool) => tool.name === name) || name.startsWith('browser_');
      if (computer) await this.authorizeComputer?.(run);
      trace = {
        name,
        surface: name.startsWith('browser_')
          ? 'browser'
          : computerToolList.some((tool) => tool.name === name)
            ? String(args.surface || 'desktop')
            : 'workspace',
        at: new Date().toISOString(),
        phase: 'running',
      };
      run.trace.push(trace);
      const dispatch = (assertPolicy?: () => unknown) =>
        this.dispatchRemote(run, name, args, wireId, computer, assertPolicy);
      if (raw && !this.executeRemote) throw new Fault('COMMAND_APPROVAL_UNAVAILABLE');
      const result = raw
        ? await this.executeRemote!(run, name, args, wireId, dispatch)
        : await dispatch();
      trace.phase = result.isError ? 'rejected' : 'settled';
      return result;
    } catch (error) {
      const code = run.abort.signal.aborted
        ? 'MODEL_CANCELLED'
        : errorCode(error) || 'EXECUTOR_TOOL_FAILED';
      if (trace) {
        trace.phase = 'rejected';
        trace.code = code;
      }
      return { isError: true, content: [{ type: 'text', text: code }] };
    } finally {
      if (run.waitingForComputer) {
        run.waitingForComputer = false;
        run.onComputerWait?.();
      }
    }
  }
  private async dispatchRemote(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
    wireId: string | undefined,
    computer: boolean,
    assertPolicy?: () => unknown,
  ): Promise<ToolResult> {
    run.abort.signal.throwIfAborted();
    if (computer) await this.authorizeComputer?.(run);
    await this.open(run);
    // Opening the guest may wait; revalidate consent after that wait and before sending an effect.
    assertPolicy?.();
    this.checkProject(run, name.startsWith('browser_') ? 'browser' : 'read');
    const operationId = randomUUID();
    let status = (await this.options.execution!.call(
      'tools.invoke',
      {
        runId: run.id,
        operationId,
        name,
        args,
        // Host receipts retain the typed RPC identity; only the Guest-safe wire field is encoded.
        ...(wireId ? { wireId: createHash('sha256').update(wireId).digest('hex') } : {}),
      },
      run.abort.signal,
    )) as { phase: string; waitingForComputer?: boolean; result?: ToolResult };
    while (true) {
      const waiting = status.waitingForComputer === true;
      if (run.waitingForComputer !== waiting) {
        run.waitingForComputer = waiting;
        run.onComputerWait?.();
      }
      if (status.phase === 'settled') break;
      if (status.phase !== 'running') throw new Fault('EXECUTION_OUTCOME_UNKNOWN');
      await new Promise((resolve) => setTimeout(resolve, 40));
      run.abort.signal.throwIfAborted();
      // Poll the accepted operation; repeating invoke after a lost acknowledgement can repeat its effects.
      status = (await this.options.execution!.call(
        'tools.poll',
        { runId: run.id, operationId },
        run.abort.signal,
      )) as typeof status;
    }
    if (!status.result || !Array.isArray(status.result.content))
      throw new Fault('INVALID_EXECUTOR_RESPONSE', 503);
    if (computer) await this.authorizeComputer?.(run);
    this.checkProject(run, name.startsWith('browser_') ? 'browser' : 'read');
    return status.result;
  }
  private async target(run: AgentToolRun, value: unknown = '', write = false) {
    if (
      typeof value !== 'string' ||
      value.length > 512 ||
      value.includes('\\') ||
      value.includes('\0') ||
      value.split('/').includes('..')
    )
      throw new Fault('INVALID_FILE', 400);
    this.checkProject(run);
    if (run.project && this.options.projects) {
      const resources = this.options.projects;
      const reference = resources.reference(run.project, run.bot, run.id!);
      const shared = value === '/shared' || value.startsWith('/shared/');
      this.checkProject(run, shared && write ? 'write' : 'read');
      const root = shared ? resources.files(reference) : run.canonicalRoot;
      if (
        (await realpath(run.workdir)) !== resources.workdir(reference) ||
        run.canonicalRoot !== resources.workdir(reference)
      )
        throw new Fault('TASK_DIRECTORY_MOVED');
      const relative = shared
        ? value.slice('/shared'.length).replace(/^\/+/, '')
        : value === '/workspace' || value.startsWith('/workspace/')
          ? value.slice('/workspace'.length).replace(/^\/+/, '')
          : value;
      const file = path.resolve(root, relative);
      if (!inside(root, file)) throw new Fault('INVALID_FILE', 400);
      return { root, file };
    }
    const root = await this.workspace.base();
    if ((await realpath(run.workdir)) !== run.canonicalRoot || !inside(root, run.canonicalRoot))
      throw new Fault('TASK_DIRECTORY_MOVED');
    const shared = value === '/shared' || value.startsWith('/shared/');
    const current = value === '/workspace' || value.startsWith('/workspace/');
    if (shared && write) throw new Fault('INVALID_FILE', 400);
    const file = shared
      ? path.resolve(root, value.slice('/shared'.length).replace(/^\/+/, ''))
      : current
        ? path.resolve(run.canonicalRoot, value.slice('/workspace'.length).replace(/^\/+/, ''))
        : path.isAbsolute(value)
          ? path.join(await realpath(path.dirname(value)), path.basename(value))
          : path.resolve(run.canonicalRoot, value);
    if (!inside(write ? run.canonicalRoot : root, file)) throw new Fault('INVALID_FILE', 400);
    return { root, file };
  }
  private async browserInput(run: AgentToolRun, value: unknown) {
    run.abort.signal.throwIfAborted();
    const { root, file } = await this.target(run, value);
    const source = await this.workspace.scope(root, root).download(workspacePath(root, file));
    run.abort.signal.throwIfAborted();
    const types: Record<string, string> = {
      pdf: 'application/pdf',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return {
      name: source.name,
      mimeType: types[source.name.split('.').at(-1)!.toLowerCase()] || 'application/octet-stream',
      buffer: Buffer.from(source.data, 'base64'),
    };
  }
  private async browserOutput(run: AgentToolRun, name: string, bytes: Buffer) {
    this.checkProject(run);
    if (
      !isTaskFileName(name) ||
      name.startsWith('.') ||
      !Buffer.isBuffer(bytes) ||
      bytes.length > documentLimit
    )
      throw new Fault('INVALID_BROWSER_FILE', 400);
    const { file } = await this.target(run, name, true);
    const directory = await open(
      run.canonicalRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const base = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : run.canonicalRoot;
    const temporary = path.join(base, `.browser-download-${randomUUID()}`);
    let handle: FileHandle | undefined;
    try {
      if ((await realpath(base)) !== run.canonicalRoot) throw new Fault('TASK_DIRECTORY_MOVED');
      run.abort.signal.throwIfAborted();
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const opened =
        process.platform === 'linux'
          ? await realpath(`/proc/self/fd/${handle.fd}`)
          : await realpath(temporary);
      const identity = await handle.stat();
      if (!inside(run.canonicalRoot, opened) || !identity.isFile() || identity.nlink !== 1)
        throw new Fault('INVALID_FILE', 400);
      run.abort.signal.throwIfAborted();
      this.checkProject(run);
      await handle.writeFile(bytes);
      run.abort.signal.throwIfAborted();
      const source = await lstat(temporary);
      if (
        source.ino !== identity.ino ||
        source.dev !== identity.dev ||
        !source.isFile() ||
        source.nlink !== 1 ||
        (await realpath(base)) !== run.canonicalRoot
      )
        throw new Fault('TASK_DIRECTORY_MOVED');
      // Publish complete bytes with a create-only link; cancellation and filename collisions cannot overwrite an input.
      this.checkProject(run);
      await link(temporary, path.join(base, name));
      return { path: file, bytes: bytes.length };
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new Fault('BROWSER_FILE_EXISTS');
      throw error;
    } finally {
      try {
        if (handle) {
          const expected = await handle.stat();
          const remaining = await lstat(temporary).catch(() => undefined);
          if (remaining?.ino === expected.ino && remaining.dev === expected.dev)
            await unlink(temporary);
        }
      } finally {
        await handle?.close();
        await directory.close();
      }
    }
  }
  async writeText(run: AgentToolRun, value: unknown, content: unknown, createOnly = false) {
    this.checkProject(run);
    if (this.options.nativeOnly) throw new Fault('NATIVE_WORKSPACE_TOOL_UNAVAILABLE');
    if (
      typeof value !== 'string' ||
      !value ||
      typeof content !== 'string' ||
      Buffer.byteLength(content) > 200 * 1024 ||
      content.includes('\0')
    )
      throw new Fault('INVALID_TOOL_ARGS', 400);
    if (this.options.execution) {
      await this.open(run);
      return this.options.execution.call(
        'tools.write',
        { runId: run.id, path: value, content, createOnly },
        run.abort.signal,
      );
    }
    const { file } = await this.target(run, value, true);
    return this.write(run, file, content, createOnly);
  }
  private async write(
    run: AgentToolRun,
    file: string,
    content: string | Buffer,
    createOnly = false,
  ) {
    const root =
      run.project && this.options.projects && !inside(run.canonicalRoot, file)
        ? this.options.projects.files(
            this.options.projects.reference(run.project, run.bot, run.id!),
          )
        : run.canonicalRoot;
    this.checkProject(run, root === run.canonicalRoot ? 'read' : 'write');
    const parent = await realpath(path.dirname(file));
    if (!inside(root, parent)) throw new Fault('INVALID_FILE', 400);
    const directory = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const base = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : parent;
      if ((await realpath(base)) !== parent) throw new Fault('TASK_DIRECTORY_MOVED');
      // Pin the parent before O_CREAT; checking only the opened file would already leave an empty file outside the workspace.
      const handle = await open(
        path.join(base, path.basename(file)),
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          (createOnly ? constants.O_EXCL : 0),
        0o600,
      );
      try {
        const info = await handle.stat();
        const opened = await realpath(
          process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : file,
        );
        if (!info.isFile() || info.nlink !== 1 || !inside(root, opened))
          throw new Fault('INVALID_FILE', 400);
        run.abort.signal.throwIfAborted();
        this.checkProject(run, root === run.canonicalRoot ? 'read' : 'write');
        await handle.truncate(0);
        await handle.writeFile(content, 'utf8');
        return { path: file, bytes: Buffer.byteLength(content) };
      } finally {
        await handle.close();
      }
    } finally {
      await directory.close();
    }
  }

  private async shell(run: AgentToolRun, command: string) {
    if (this.shellRunner) return this.shellRunner(run, command);
    if (process.platform !== 'linux') throw new Fault('SHELL_SANDBOX_UNAVAILABLE');
    const { root } = await this.target(run);
    const directory = await open(
      run.canonicalRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let shared: FileHandle | undefined;
    try {
      shared = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const sharedFd = shared.fd;
      if ((await realpath(`/proc/self/fd/${sharedFd}`)) !== root)
        throw new Fault('WORKSPACE_MOVED');
      if ((await realpath(`/proc/self/fd/${directory.fd}`)) !== run.canonicalRoot)
        throw new Fault('TASK_DIRECTORY_MOVED');
      // Bind the opened directory, never a path another Bot could replace between validation and mounting.
      const args = [
        '--die-with-parent',
        '--new-session',
        '--unshare-user',
        '--unshare-all',
        '--disable-userns',
        '--cap-drop',
        'ALL',
        '--ro-bind',
        '/usr',
        '/usr',
        '--symlink',
        'usr/bin',
        '/bin',
        '--symlink',
        'usr/lib',
        '/lib',
        '--symlink',
        'usr/sbin',
        '/sbin',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
        // A separate read-only mount permits shared computation without granting writes to another task.
        '--ro-bind-fd',
        '4',
        '/shared',
        '--bind-fd',
        '3',
        '/workspace',
        '--chdir',
        '/workspace',
        '--clearenv',
        '--setenv',
        'PATH',
        '/usr/bin:/bin',
        '--setenv',
        'HOME',
        '/tmp',
        '--setenv',
        'LANG',
        'C.UTF-8',
        '--',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        command,
      ];
      return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          // No raw-shell fallback: the harness process carries the provider credential.
          const child = spawn('bwrap', args, {
            env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
            stdio: ['ignore', 'pipe', 'pipe', directory.fd, sharedFd],
            timeout: 30000,
            signal: run.abort.signal,
            killSignal: 'SIGKILL',
          });
          const stdout: Buffer[] = [],
            stderr: Buffer[] = [];
          let bytes = 0,
            limited = false,
            failure: Error | undefined;
          const capture = (target: Buffer[], chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) {
              limited = true;
              child.kill('SIGKILL');
            } else target.push(chunk);
          };
          child.stdout!.on('data', (chunk: Buffer) => capture(stdout, chunk));
          child.stderr!.on('data', (chunk: Buffer) => capture(stderr, chunk));
          child.once('error', (error) => {
            failure = error;
          });
          child.once('close', (code, signal) => {
            if (run.abort.signal.aborted) reject(new Fault('MODEL_CANCELLED'));
            else if (errorCode(failure) === 'ENOENT')
              reject(new Fault('SHELL_SANDBOX_UNAVAILABLE'));
            else if (limited || signal) reject(new Fault('SHELL_LIMIT'));
            else if (failure) reject(failure);
            else
              resolve({
                exitCode: code,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
              });
          });
        },
      );
    } finally {
      await shared?.close();
      await directory.close();
    }
  }
  private async perform(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
    wireId?: string,
  ): Promise<ToolResult> {
    try {
      this.checkProject(run, name.startsWith('browser_') ? 'browser' : 'read');
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: errorCode(error) ?? 'PROJECT_ACCESS_DENIED' }],
      };
    }
    const unavailable =
      this.options.nativeOnly && (Object.hasOwn(fields, name) || name.startsWith('process_'))
        ? 'NATIVE_WORKSPACE_TOOL_UNAVAILABLE'
        : this.localRuns.get(run) && name.startsWith('browser_')
          ? 'LOCAL_BROWSER_SURFACE_UNAVAILABLE'
          : undefined;
    if (name === 'read_image' && !(run.vision ?? (!run.model || modelHasVision(run.model))))
      return { isError: true, content: [{ type: 'text', text: 'MODEL_IMAGE_UNSUPPORTED' }] };
    if (!unavailable && this.localRuns.get(run)) {
      if (computerToolList.some((tool) => tool.name === name)) {
        await this.authorizeComputer?.(run);
        if (!this.localComputer) throw new Fault('LOCAL_CLIENT_UNAVAILABLE');
        if (wireId) {
          let requests = this.localRequests.get(run);
          if (!requests) {
            requests = new Set();
            this.localRequests.set(run, requests);
          }
          const identity = createHash('sha256').update(wireId).digest('hex');
          // Replayed MCP identities must neither repeat desktop effects nor present an old image as a fresh observation.
          if (requests.has(identity))
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: 'LOCAL_REQUEST_REPLAYED: capture a fresh screenshot in a new tool call.',
                },
              ],
            };
          if (requests.size >= run.limit + 1) {
            run.onLimit?.();
            return { isError: true, content: [{ type: 'text', text: 'TOOL_LIMIT' }] };
          }
          requests.add(identity);
        }
        return this.localComputer.invoke(run, name, args);
      }
    }
    if (
      !unavailable &&
      this.options.execution &&
      (Object.hasOwn(fields, name) ||
        computerToolList.some((tool) => tool.name === name) ||
        name.startsWith('browser_') ||
        name.startsWith('process_'))
    )
      return this.remote(run, name, args, wireId);
    if (this.schedules && scheduleToolList.some((tool) => tool.name === name))
      return this.schedules.invoke(run, name, args);
    if (computerToolList.some((tool) => tool.name === name)) {
      // Screen actions return images; a text-only route must not operate blindly or receive unsupported image content.
      if (!(run.vision ?? (!run.model || modelHasVision(run.model))))
        return { isError: true, content: [{ type: 'text', text: 'MODEL_COMPUTER_UNSUPPORTED' }] };
      return this.computer && this.hasComputer(run.bot, run.model, run.vision)
        ? this.computer.invoke(run, name, args)
        : { isError: true, content: [{ type: 'text', text: 'COMPUTER_NOT_CONNECTED' }] };
    }
    const dataTool = [
      this.memory,
      this.history,
      this.knowledge,
      this.work,
      this.notes,
      this.catalog,
      this.software,
      this.skills,
      this.groups,
      this.hasBrowser(run.bot) ? this.browser : undefined,
    ].find((tools) => tools && Object.hasOwn(tools.fields, name));
    const external = this.integrations?.owns(run, name);
    const surface = external ? 'integration' : dataTool?.surface || 'workspace';
    let trace: ToolTrace | undefined;
    try {
      if (run.abort.signal.aborted) throw new Fault('MODEL_CANCELLED');
      if (++run.toolCount > run.limit) {
        run.onLimit?.();
        throw new Fault('TOOL_LIMIT');
      }
      if (unavailable) throw new Fault(unavailable);
      if (external) {
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new Fault('INVALID_TOOL_ARGS', 400);
        trace = { name, surface, phase: 'running', at: new Date().toISOString() };
        run.trace.push(trace);
        const result = await this.integrations!.invoke(run, name, args, wireId, () =>
          this.checkProject(run),
        );
        trace.phase = result.isError ? 'rejected' : 'settled';
        return result;
      }
      if (args?.path !== undefined && typeof args.path !== 'string')
        throw new Fault('INVALID_TOOL_ARGS', 400);
      const allowed = dataTool ? dataTool.fields[name] : fields[name];
      if (
        !allowed ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some((key) => !allowed.includes(key))
      )
        throw new Fault('INVALID_TOOL_ARGS', 400);
      trace = { name, surface, phase: 'running', at: new Date().toISOString() };
      run.trace.push(trace);
      if (dataTool && (dataTool === this.software || dataTool === this.skills)) {
        const response = await dataTool.invoke(run, name, args);
        trace.phase = response.isError ? 'rejected' : 'settled';
        return response;
      }
      let result: unknown;
      if (dataTool) result = await dataTool.invoke(run, name, args);
      else if (name === 'shell') {
        if (
          typeof args.command !== 'string' ||
          !args.command.trim() ||
          args.command.length > 12000 ||
          args.command.includes('\0')
        )
          throw new Fault('INVALID_TOOL_ARGS', 400);
        result = await this.shell(run, args.command);
      } else {
        if (name !== 'list_files' && (typeof args.path !== 'string' || !args.path))
          throw new Fault('INVALID_TOOL_ARGS', 400);
        const { file, root } = await this.target(run, args.path ?? '', name === 'write_file');
        if (name === 'write_file') {
          if (
            typeof args.content !== 'string' ||
            Buffer.byteLength(args.content) > 200 * 1024 ||
            args.content.includes('\0')
          )
            throw new Fault('INVALID_TOOL_ARGS', 400);
          result = await this.write(run, file, args.content);
        } else {
          const info = await lstat(file);
          const canonical = await realpath(file);
          if (
            info.isSymbolicLink() ||
            !inside(root, canonical) ||
            (!info.isDirectory() && info.nlink !== 1)
          )
            throw new Fault('INVALID_FILE', 400);
          if (name === 'read_image') {
            this.checkProject(run);
            const source = await this.workspace
              .scope(root, root)
              .download(workspacePath(root, file));
            const image = imageInput(source);
            run.abort.signal.throwIfAborted();
            trace.phase = 'settled';
            return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
          }
          if (name === 'list_files') {
            if (!info.isDirectory()) throw new Fault('INVALID_FILE', 400);
            this.checkProject(run);
            result = { directory: file, files: await new WorkspaceFiles(canonical).list() };
          } else {
            const offset = args.offset ?? 0,
              limit = args.limit ?? 12000;
            if (
              !Number.isSafeInteger(offset) ||
              Number(offset) < 0 ||
              !Number.isSafeInteger(limit) ||
              Number(limit) < 1 ||
              Number(limit) > 64000
            )
              throw new Fault('INVALID_TOOL_ARGS', 400);
            this.checkProject(run);
            const actual = await this.workspace.scope(root, root).read(workspacePath(root, file)),
              content = actual.content || '';
            const end = Number(offset) + Number(limit);
            result = {
              path: file,
              content: content.slice(Number(offset), end),
              ...(end < content.length ? { nextOffset: end } : {}),
            };
          }
        }
      }
      const failed =
        dataTool === this.browser &&
        result &&
        typeof result === 'object' &&
        'error' in result &&
        typeof result.error === 'string'
          ? result.error
          : undefined;
      trace.phase = failed ? 'rejected' : 'settled';
      if (failed) trace.code = failed;
      return { ...text(result), ...(failed ? { isError: true } : {}) };
    } catch (error) {
      const code = run.abort.signal.aborted
        ? 'MODEL_CANCELLED'
        : errorCode(error) || 'WORKSPACE_TOOL_FAILED';
      if (trace) {
        trace.phase = 'rejected';
        trace.code = code;
      } else
        run.trace.push({
          name,
          surface,
          phase: 'rejected',
          code,
          at: new Date().toISOString(),
        });
      return {
        isError: true,
        content: [{ type: 'text', text: dataTool ? code : `${code}: ${errorMessage(error)}` }],
      };
    }
  }
}
