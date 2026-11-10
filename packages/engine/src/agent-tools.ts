import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, link, lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  browserFilesCapability,
  browserTaskCapability,
  documentLimit,
  isRuntimeDownload,
  isTaskFileName,
  type ModelId,
  modelExecutionCapability,
  modelHasVision,
  type TaskRequest,
  validAgentId,
} from '@daban/protocol';
import type { BotTools } from './bot-tools.js';
import { BrowserTools } from './browser-tools.js';
import type { CatalogTools } from './catalog.js';
import {
  browserComputerToolList,
  type ComputerFacade,
  ComputerTools,
  computerToolList,
  type ToolResult,
  type ToolRun,
  type ToolTrace,
} from './computer-tools.js';
import { errorCode, errorMessage, Fault } from './control.js';
import { type CsvCheck, checkCsv, csvCheck } from './csv.js';
import type { GroupTools } from './group-tools.js';
import type { HistoryTools } from './history.js';
import { imageInput } from './images.js';
import type { IntegrationTools } from './integration-tools.js';
import type { McpSnapshot } from './integrations.js';
import type { KnowledgeTools } from './knowledge-tools.js';
import type { LinuxTools } from './linux-tools.js';
import type { LocalCommandTools } from './local-command-tools.js';
import type { LocalComputerPort } from './local-computer.js';
import type { LocalTools } from './local-tools.js';
import type { MemoryTools } from './memory.js';
import type { NotesTools } from './notes-tools.js';
import type { WorkspaceExecutor } from './remote-workspace.js';
import { scheduleToolList } from './schedule-catalog.js';
import type { ScheduleTools } from './schedule-tools.js';
import type { SkillTools } from './skill-tools.js';
import type { SkillSnapshot } from './skills.js';
import type { SoftwareTools } from './software.js';
import type { WorkTools } from './work-tools.js';
import { type AgentWorkspace, type TaskDirectory, WorkspaceFiles } from './workspace.js';

export interface AgentToolRun extends ToolRun {
  assistant?: string;
  inputs?: string[];
  executionId?: string;
  beforeTool?: () => Promise<unknown>;
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
  localTaskDirectory?: Pick<TaskDirectory, 'canonical' | 'verify'>;
}
// Guest leases derive from persisted run/attempt identities; they never replace the logical task root.
export const executionAttemptId = (runId: string, attemptId: string) =>
  createHash('sha256')
    .update(JSON.stringify([runId, attemptId]))
    .digest('hex');
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
      'Discover file names when you do not already know them. File paths are relative to the listed directory. Use a returned reference directly for a later read.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory to list. Omit for /workspace (this task). Use /shared for prior work.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read UTF-8 text such as CSV, Markdown or JSON by exact filename or reference, including a saved output you need to verify. Omit offset and limit on the first read. Returns the actual content and a reusable reference. If nextOffset is present, continue from it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description:
            'Exact input path relative to this task, or the reference from a file result.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Omit for the first read. For another page, use the returned nextOffset.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 64000,
          description: 'Optional custom page size in UTF-16 code units. The default is 12000.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Save a complete UTF-8 text file such as CSV, Markdown or JSON. Returns the byte count and a reference for reading it back. Use a new filename for a new deliverable; writing an existing path replaces its contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description:
            'Output filename or path relative to this task. Parent directories must exist.',
        },
        content: {
          type: 'string',
          description: 'Complete file contents as text. For CSV, include the header and rows.',
        },
      },
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
  write_file: ['path', 'content', 'createOnly'],
  verify_csv: ['path', 'rows', 'sum'],
  shell: ['command'],
};
const csvTool = {
  name: 'verify_csv',
  description:
    'Use immediately after saving a CSV that must be checked for row count or amounts. Compute expectations from the inputs. The result includes the actual values, so read_file is only needed for other properties. Correct a failed output without changing expectations to match it. The runtime retains these checks and re-runs them before the task can complete.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Output filename or workspace reference.' },
      rows: {
        type: 'integer',
        minimum: 0,
        description: 'Expected data rows, excluding the header.',
      },
      sum: {
        type: 'object',
        additionalProperties: false,
        properties: {
          column: { type: 'string', description: 'Exact amount column header.' },
          total: {
            type: 'string',
            description: 'Expected decimal total, with at most two decimal places.',
          },
        },
        required: ['column', 'total'],
      },
    },
    required: ['path', 'rows'],
  },
};
const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
// Workspace paths are protocol values, including when the host filesystem uses backslashes.
const workspacePath = (root: string, file: string) =>
  path.relative(root, file).split(path.sep).join('/');
function fileReference(run: AgentToolRun, root: string, file: string) {
  const current = inside(run.canonicalRoot, file);
  const relative = workspacePath(current ? run.canonicalRoot : root, file);
  const prefix = current ? '/workspace' : '/shared';
  return relative ? `${prefix}/${relative}` : prefix;
}
const windowsName = (name: string) =>
  !/[<>:"|?*]/.test(name) &&
  !/[. ]$/.test(name) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
export const validWindowsPath = (value: string) =>
  // Only an absolute drive prefix may contain a colon; other colons can address NTFS alternate streams.
  value
    .replace(/^[a-z]:\//i, '')
    .split('/')
    .every((name) => !name || windowsName(name));

export class AgentTools {
  linux?: LinuxTools;
  readonly browser?: BrowserTools;
  localComputer?: LocalComputerPort;
  private readonly computerRequests = new WeakMap<AgentToolRun, Set<string>>();
  localFiles?: LocalTools;
  localCommands?: LocalCommandTools;
  private readonly localRuns = new WeakMap<AgentToolRun, boolean>();
  private readonly csvChecks = new WeakMap<AgentToolRun, Map<string, CsvCheck>>();
  groups?: GroupTools;
  bots?: BotTools;
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
  private readonly hostComputer?: ComputerTools;
  private readonly hostBrowser?: BrowserTools;
  private readonly hostRuns = new WeakMap<AgentToolRun, boolean>();
  private readonly hostStarts = new WeakMap<
    ToolRun,
    { scope: 'bot' | 'task'; pending?: Promise<(() => Promise<unknown>) | undefined> }
  >();
  authorizeComputer?: (run: ToolRun) => Promise<unknown>;
  executeRemote?: (
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
    wireId: string | undefined,
    dispatch: () => Promise<ToolResult>,
  ) => Promise<ToolResult>;
  shellRunner?: (run: AgentToolRun, command: string) => Promise<unknown>;
  private readonly remoteCatalogs = new Map<
    string,
    { name: string; description: string; inputSchema: Record<string, unknown> }[]
  >();
  private readonly opened = new WeakMap<AgentToolRun, string>();
  private readonly active = new WeakMap<AgentToolRun, Set<Promise<ToolResult>>>();
  constructor(
    runtime: ComputerFacade | undefined,
    readonly workspace: AgentWorkspace,
    readonly options: {
      execution?: WorkspaceExecutor;
      nativeOnly?: boolean;
      hostBrowser?: ComputerFacade;
    } = {},
  ) {
    if (runtime) {
      this.computer = new ComputerTools(runtime);
      if (runtime.browser.tabs)
        this.browser = new BrowserTools(this.computer, runtime.browser.tabs, {
          read: (run, file) => this.browserInput(run, file),
          write: (run, name, bytes) => this.writeBinary(run, name, bytes),
        });
    }
    if (options.hostBrowser?.browser.tabs) {
      const autoStart = options.hostBrowser.browser.autoStart;
      this.hostComputer = new ComputerTools(options.hostBrowser, (run) => {
        const start = this.hostStarts.get(run);
        if (!start || !autoStart) return undefined;
        // Once the run tries to open a browser, losing that instance cannot start a replacement.
        start.pending ??= autoStart.open(run.bot, start.scope, run.abort.signal);
        return start.pending;
      });
      this.hostComputer.authorize = (run) => this.authorizeComputer?.(run) ?? Promise.resolve();
      this.hostBrowser = new BrowserTools(this.hostComputer, options.hostBrowser.browser.tabs, {
        read: (run, file) => this.browserInput(run, file),
        write: (run, name, bytes) => this.writeBinary(run, name, bytes),
      });
    }
  }
  hostSelected(bot: string, run?: AgentToolRun) {
    return run
      ? this.hostRuns.get(run) === true
      : this.options.hostBrowser?.available?.(bot) === true;
  }
  localSelected(bot: string, run?: AgentToolRun) {
    return run ? this.localRuns.get(run) === true : this.localComputer?.selected(bot) === true;
  }
  hasComputer(bot: string, model?: ModelId, vision?: boolean, run?: AgentToolRun) {
    if (this.localSelected(bot, run)) return vision ?? (!model || modelHasVision(model));
    if (this.hostSelected(bot, run)) return false;
    if (this.linux?.hasComputer(bot)) return vision ?? (!model || modelHasVision(model));
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
    if (this.hostSelected(bot, run))
      return (
        !!this.hostBrowser &&
        ((run && this.hostStarts.has(run)) || this.options.hostBrowser?.available?.(bot) === true)
      );
    if (this.linux?.hasComputer(bot)) return true;
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
      : this.hasComputer(bot, model, run?.vision) &&
          (!this.options.nativeOnly || this.localSelected(bot, run))
        ? agentToolList
        : workspaceToolList;
    const local = this.localSelected(bot, run);
    const hosted = this.hostSelected(bot, run);
    const offered = this.options.nativeOnly ? tools.filter((tool) => tool.name !== 'shell') : tools;
    const visible = offered
      .filter(
        (tool) => tool.name !== 'read_image' || (run?.vision ?? (!model || modelHasVision(model))),
      )
      .map((tool) =>
        this.options.nativeOnly && !this.options.execution && tool.name === 'write_file'
          ? {
              ...tool,
              description:
                'Save complete UTF-8 text such as CSV, Markdown or JSON in this task. Returns the byte count and a reference for verification. Set createOnly for a new deliverable. On a known filename conflict or FILE_EXISTS, preserve the original. If the user has not authorized another name, use ask_user_question and wait for the answer. Replace an existing file only when the user requested it.',
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...(typeof tool.inputSchema.properties === 'object'
                    ? tool.inputSchema.properties
                    : {}),
                  createOnly: {
                    type: 'boolean',
                    description:
                      'Set true when creating a new deliverable. An existing file is preserved and reported as FILE_EXISTS.',
                  },
                },
              },
            }
          : tool,
      );
    return [
      ...(local || hosted
        ? visible.filter(
            (tool) =>
              !computerToolList.some((item) => item.name === tool.name) &&
              !tool.name.startsWith('browser_'),
          )
        : visible),
      ...(this.options.nativeOnly && !this.options.execution ? [csvTool] : []),
      ...(local && (run?.vision ?? (!model || modelHasVision(model)))
        ? this.localComputer?.list || []
        : []),
      ...(hosted && (run?.vision ?? (!model || modelHasVision(model)))
        ? browserComputerToolList
        : []),
      ...(this.hasBrowser(bot, run)
        ? hosted
          ? this.hostBrowser!.list.filter(
              (tool) =>
                this.browserFiles() || !['browser_upload', 'browser_download'].includes(tool.name),
            )
          : !this.options.execution
            ? this.browser?.list || []
            : []
        : []),
      ...(this.linux?.enabled
        ? this.linux.listFor(bot, run?.vision ?? (!model || modelHasVision(model)), local || hosted)
        : []),
      ...(this.schedules ? scheduleToolList : []),
      ...(this.memory?.listFor(run?.assistant) || []),
      ...(run?.task ? this.bots?.list || [] : []),
      ...(this.history?.list || []),
      ...(this.knowledge?.listFor(run?.assistant) || []),
      ...(this.work?.list || []),
      ...(this.notes?.list || []),
      ...(this.localFiles?.list || []),
      ...(this.localCommands?.list || []),
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
  async open(run: AgentToolRun) {
    if (!this.localRuns.has(run))
      this.localRuns.set(run, (await this.localComputer?.prepare(run)) ?? false);
    // Capture the surface once. Auto-start must not displace a connected computer.
    if (!this.hostRuns.has(run)) {
      const autoStart = this.options.hostBrowser?.browser.autoStart;
      const connected = this.hostSelected(run.bot);
      const eligible =
        !!autoStart &&
        !connected &&
        !this.localSelected(run.bot, run) &&
        !this.linux?.hasComputer(run.bot) &&
        !!run.task?.prompt.trim() &&
        validAgentId(run.id);
      const saved = eligible && (await autoStart.allowed(run.bot).catch(() => false));
      const task =
        eligible &&
        !run.conversationId &&
        run.task?.approvalMode === 'full' &&
        run.task.browserAutoStart === true;
      if (!this.hostRuns.has(run)) {
        this.hostRuns.set(run, connected || saved || task);
        if (saved || task) this.hostStarts.set(run, { scope: saved ? 'bot' : 'task' });
      }
    }
    if (!this.options.execution) return;
    const id = run.executionId ?? run.id;
    if (!id) throw new Fault('EXECUTION_INVALID_REQUEST');
    const opened = this.opened.get(run);
    if (opened) {
      if (opened !== id) throw new Fault('EXECUTION_RUN_CONFLICT');
      return;
    }
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
        id,
        bot: run.bot,
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
    this.opened.set(run, id);
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
    const call = run.beforeTool
      ? this.fenced(run, name, args, wireId)
      : this.perform(run, name, args, wireId);
    calls.add(call);
    return call.finally(() => {
      calls.delete(call);
    });
  }
  private async fenced(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
    wireId?: string,
  ) {
    const identity = () =>
      JSON.stringify([
        run.bot,
        run.id,
        run.executionId,
        run.intentId,
        run.sessionId,
        run.model,
        run.vision,
        run.workdir,
        run.canonicalRoot,
        run.integrations?.key,
      ]);
    const owner = identity();
    const input = structuredClone(args);
    await run.beforeTool?.();
    // Fence persistence must not move the read/permission snapshot past a change of task ownership.
    if (identity() !== owner) throw new Fault('TOOL_CONTEXT_CHANGED', 403);
    return this.perform(run, name, input, wireId);
  }
  async drain(run: AgentToolRun) {
    await Promise.allSettled([...(this.active.get(run) || [])]);
    await this.linux?.drain(run);
    if (this.localRuns.get(run)) await this.localComputer?.cancel(run);
    // An active call may still be opening its lease; capture it only after that call has settled.
    const id = this.opened.get(run);
    if (this.options.execution && id) {
      await this.options.execution.call('tools.drain', { runId: id });
      if (this.opened.get(run) === id) this.opened.delete(run);
    }
  }
  async cancel(run: AgentToolRun) {
    await this.linux?.cancel(run);
    if (this.localRuns.get(run)) await this.localComputer?.cancel(run);
    const id = this.opened.get(run);
    if (this.options.execution && id)
      await this.options.execution.call('tools.cancel', { runId: id });
  }
  async finish(run: AgentToolRun) {
    try {
      await this.drain(run);
    } finally {
      // Attempt fallback drains tools too; only final task shutdown releases this connection.
      const start = this.hostStarts.get(run);
      this.hostStarts.delete(run);
      const release = await start?.pending?.catch(() => undefined);
      await release?.();
    }
  }
  private async remote(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
    wireId?: string,
  ): Promise<ToolResult> {
    let trace: ToolTrace | undefined;
    try {
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
      const dispatch = () => this.dispatchRemote(run, name, args, wireId, computer);
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
  ): Promise<ToolResult> {
    run.abort.signal.throwIfAborted();
    if (computer) await this.authorizeComputer?.(run);
    await this.open(run);
    const runId = this.opened.get(run);
    if (!runId) throw new Fault('EXECUTION_RUN_CLOSED');
    const operationId = randomUUID();
    let status = (await this.options.execution!.call(
      'tools.invoke',
      {
        runId,
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
        { runId, operationId },
        run.abort.signal,
      )) as typeof status;
    }
    if (!status.result || !Array.isArray(status.result.content))
      throw new Fault('INVALID_EXECUTOR_RESPONSE', 503);
    if (computer) await this.authorizeComputer?.(run);
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
    if (!this.options.execution && process.platform === 'win32' && !validWindowsPath(value))
      throw new Fault('INVALID_FILE', 400);
    const root = await this.workspace.base();
    if (this.options.execution) {
      const canonical = await this.workspace.scope(run.workdir, run.canonicalRoot).base();
      if (canonical !== run.canonicalRoot || !canonical.startsWith(`${root}/`))
        throw new Fault('TASK_DIRECTORY_MOVED');
      const shared = value === '/shared' || value.startsWith('/shared/');
      const current = value === '/workspace' || value.startsWith('/workspace/');
      if (shared && write) throw new Fault('INVALID_FILE', 400);
      const file = shared
        ? path.posix.resolve(root, value.slice('/shared'.length).replace(/^\/+/, ''))
        : current
          ? path.posix.resolve(canonical, value.slice('/workspace'.length).replace(/^\/+/, ''))
          : path.posix.resolve(canonical, value);
      const boundary = write ? canonical : root;
      if (file !== boundary && !file.startsWith(`${boundary}/`))
        throw new Fault('INVALID_FILE', 400);
      return { root, file };
    }
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
    if (this.hostSelected(run.bot, run) && !this.browserFiles())
      throw new Fault('EXECUTION_UPGRADE_REQUIRED');
    run.abort.signal.throwIfAborted();
    const { root, file } = await this.target(run, value);
    const reference = this.options.execution
      ? path.posix.relative(root, file)
      : workspacePath(root, file);
    const source = await this.workspace.download(reference);
    // Verify transferred bytes before exposing them to a website in the signed-in browser.
    if (!isRuntimeDownload(source) || source.path !== reference)
      throw new Fault('INVALID_EXECUTOR_RESPONSE');
    const buffer = Buffer.from(source.data, 'base64');
    if (
      buffer.toString('base64') !== source.data ||
      createHash('sha256').update(buffer).digest('hex') !== source.sha256
    )
      throw new Fault('INVALID_EXECUTOR_RESPONSE');
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
      buffer,
    };
  }
  private browserFiles() {
    // Older executors reject unknown RPCs; keep DOM browsing available without advertising unsupported transfers.
    return (
      !this.options.execution ||
      this.options.execution.snapshot?.capabilities.includes(browserFilesCapability) === true
    );
  }
  private async directory(parent: string) {
    const identity = await lstat(parent);
    if (!identity.isDirectory() || identity.isSymbolicLink())
      throw new Fault('TASK_DIRECTORY_MOVED');
    // Windows cannot open directories as ordinary file handles; retain canonical identity checks around each write.
    const handle =
      process.platform === 'win32'
        ? undefined
        : await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const base = process.platform === 'linux' ? `/proc/self/fd/${handle!.fd}` : parent;
    const verify = async () => {
      const current = await lstat(parent);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.ino !== identity.ino ||
        current.dev !== identity.dev ||
        (await realpath(base)) !== parent
      )
        throw new Fault('TASK_DIRECTORY_MOVED');
    };
    try {
      await verify();
      return {
        path: base,
        verify,
        close: async () => {
          await handle?.close();
        },
      };
    } catch (error) {
      await handle?.close();
      throw error;
    }
  }
  async writeBinary(
    run: AgentToolRun,
    name: string,
    bytes: Buffer,
  ): Promise<{ path: string; bytes: number }> {
    if (
      !isTaskFileName(name) ||
      name.startsWith('.') ||
      !Buffer.isBuffer(bytes) ||
      bytes.length > documentLimit
    )
      throw new Fault('INVALID_BROWSER_FILE', 400);
    if (this.options.execution) {
      if (!this.browserFiles()) throw new Fault('EXECUTION_UPGRADE_REQUIRED');
      await this.open(run);
      const runId = this.opened.get(run);
      if (!runId) throw new Fault('EXECUTION_RUN_CLOSED');
      const result = await this.options.execution.call(
        'tools.publish',
        { runId, name, data: bytes.toString('base64') },
        run.abort.signal,
      );
      const expected = path.posix.join(run.canonicalRoot, name);
      if (
        !result ||
        typeof result !== 'object' ||
        !('path' in result) ||
        result.path !== expected ||
        !('bytes' in result) ||
        result.bytes !== bytes.length
      )
        throw new Fault('INVALID_EXECUTOR_RESPONSE');
      return { path: expected, bytes: bytes.length };
    }
    if (process.platform === 'win32' && !windowsName(name))
      throw new Fault('INVALID_BROWSER_FILE', 400);
    const { file } = await this.target(run, name, true);
    return this.publishFile(run, file, bytes, 'BROWSER_FILE_EXISTS');
  }
  private async publishFile(
    run: AgentToolRun,
    file: string,
    bytes: Buffer,
    collision: 'BROWSER_FILE_EXISTS' | 'FILE_EXISTS',
  ) {
    const parent = await realpath(path.dirname(file));
    if (!inside(run.canonicalRoot, parent)) throw new Fault('INVALID_FILE', 400);
    const directory = await this.directory(parent);
    const base = directory.path;
    const prefix = collision === 'BROWSER_FILE_EXISTS' ? '.browser-download-' : '.file-publish-';
    const temporary = path.join(base, `${prefix}${randomUUID()}`);
    let handle: FileHandle | undefined;
    try {
      await directory.verify();
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
      await handle.writeFile(bytes);
      run.abort.signal.throwIfAborted();
      const source = await lstat(temporary);
      if (
        source.ino !== identity.ino ||
        source.dev !== identity.dev ||
        !source.isFile() ||
        source.nlink !== 1
      )
        throw new Fault('TASK_DIRECTORY_MOVED');
      await directory.verify();
      run.abort.signal.throwIfAborted();
      // Publish complete bytes with a create-only link; cancellation and filename collisions cannot overwrite an input.
      await link(temporary, path.join(base, path.basename(file)));
      return { path: file, bytes: bytes.length };
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new Fault(collision);
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
  private async checkCsvFile(run: AgentToolRun, reference: string, expected: CsvCheck) {
    try {
      const relative = reference.slice('/workspace/'.length);
      const file = await this.workspace.scope(run.workdir, run.canonicalRoot).read(relative);
      return { reference, expected, ...checkCsv(file.content, expected) };
    } catch (error) {
      return { reference, expected, passed: false, code: errorCode(error) || 'CSV_READ_FAILED' };
    }
  }
  async csvFailures(run: AgentToolRun) {
    const failures = [];
    for (const [reference, expected] of this.csvChecks.get(run) ?? []) {
      const result = await this.checkCsvFile(run, reference, expected);
      if (result.code) failures.push(result);
    }
    return failures;
  }
  hasCsvChecks(run: AgentToolRun) {
    return this.csvChecks.has(run);
  }
  private async verifyCsv(run: AgentToolRun, reference: string, expected: CsvCheck) {
    if (
      !this.options.nativeOnly ||
      this.options.execution ||
      !reference.toLowerCase().endsWith('.csv')
    )
      throw new Fault('INVALID_FILE', 400);
    let checks = this.csvChecks.get(run);
    if (!checks) {
      checks = new Map();
      this.csvChecks.set(run, checks);
    }
    const previous = checks.get(reference);
    // A repair can change the output. It cannot lower the expectation to match a failed output.
    if (previous && JSON.stringify(previous) !== JSON.stringify(expected))
      throw new Fault('CSV_CHECK_ALREADY_SET');
    checks.set(reference, expected);
    return this.checkCsvFile(run, reference, expected);
  }
  async writeText(run: AgentToolRun, value: unknown, content: unknown, createOnly = false) {
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
      const runId = this.opened.get(run);
      if (!runId) throw new Fault('EXECUTION_RUN_CLOSED');
      return this.options.execution.call(
        'tools.write',
        { runId, path: value, content, createOnly },
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
    const parent = await realpath(path.dirname(file));
    if (!inside(run.canonicalRoot, parent)) throw new Fault('INVALID_FILE', 400);
    const directory = await this.directory(parent);
    try {
      const base = directory.path;
      await directory.verify();
      // Pin the parent before O_CREAT; checking only the opened file would already leave an empty file outside the workspace.
      const target = path.join(base, path.basename(file));
      const previous = await lstat(target).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
        return undefined;
      });
      // Windows creating opens can follow dangling links even with O_EXCL; reject reparse points before any create.
      if (previous?.isSymbolicLink()) throw new Fault('INVALID_FILE', 400);
      const flags = constants.O_RDWR | constants.O_NOFOLLOW;
      const handle = await open(
        target,
        previous && !createOnly ? flags : flags | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        const info = await handle.stat();
        const named = await lstat(target);
        const opened = await realpath(
          process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : file,
        );
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          named.isSymbolicLink() ||
          named.nlink !== 1 ||
          named.ino !== info.ino ||
          named.dev !== info.dev ||
          (previous && (previous.ino !== info.ino || previous.dev !== info.dev)) ||
          !inside(run.canonicalRoot, opened)
        )
          throw new Fault('INVALID_FILE', 400);
        await directory.verify();
        run.abort.signal.throwIfAborted();
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
    const hosted = this.hostSelected(run.bot, run);
    const hostInput = hosted && ['screenshot', 'act'].includes(name) && args?.surface === 'browser';
    const linuxOnly = name === 'shell' || name.startsWith('process_') || name.startsWith('linux_');
    // Shared GUI names follow the task's captured surface; Linux-only tools stay on the VM.
    if (this.linux?.owns(name) && (linuxOnly || (!this.localSelected(run.bot, run) && !hosted)))
      return this.linux.invoke(run, name, args, wireId);
    const computer = computerToolList.some((tool) => tool.name === name);
    const vision = run.vision ?? (!run.model || modelHasVision(run.model));
    let unavailable: string | undefined;
    if (hosted && computer) {
      if (!hostInput) unavailable = 'HOST_DESKTOP_UNAVAILABLE';
      else if (!vision) unavailable = 'MODEL_COMPUTER_UNSUPPORTED';
    } else if (
      hosted &&
      ['browser_upload', 'browser_download'].includes(name) &&
      !this.browserFiles()
    ) {
      unavailable = 'EXECUTION_UPGRADE_REQUIRED';
    } else if (this.options.nativeOnly && (name === 'shell' || name.startsWith('process_'))) {
      unavailable = 'NATIVE_WORKSPACE_TOOL_UNAVAILABLE';
    } else if (this.localRuns.get(run) && name.startsWith('browser_')) {
      unavailable = 'LOCAL_BROWSER_SURFACE_UNAVAILABLE';
    }
    if (name === 'read_image' && !(run.vision ?? (!run.model || modelHasVision(run.model))))
      return { isError: true, content: [{ type: 'text', text: 'MODEL_IMAGE_UNSUPPORTED' }] };
    if (!unavailable && (this.localRuns.get(run) || hostInput)) {
      if (computerToolList.some((tool) => tool.name === name)) {
        await this.authorizeComputer?.(run);
        if (!hostInput && !this.localComputer) throw new Fault('LOCAL_CLIENT_UNAVAILABLE');
        if (wireId) {
          let requests = this.computerRequests.get(run);
          if (!requests) {
            requests = new Set();
            this.computerRequests.set(run, requests);
          }
          const identity = createHash('sha256').update(wireId).digest('hex');
          // Replayed MCP identities must neither repeat GUI effects nor present an old image as a fresh observation.
          if (requests.has(identity))
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `${hostInput ? 'BROWSER_REQUEST_REPLAYED' : 'LOCAL_REQUEST_REPLAYED'}: capture a fresh screenshot in a new tool call.`,
                },
              ],
            };
          if (requests.size >= run.limit + 1) {
            run.onLimit?.();
            return { isError: true, content: [{ type: 'text', text: 'TOOL_LIMIT' }] };
          }
          requests.add(identity);
        }
        return hostInput
          ? this.hostComputer!.invoke(run, name, args)
          : this.localComputer!.invoke(run, name, args);
      }
    }
    if (
      !unavailable &&
      this.options.execution &&
      (Object.hasOwn(fields, name) ||
        computerToolList.some((tool) => tool.name === name) ||
        (name.startsWith('browser_') && !this.hostSelected(run.bot, run)) ||
        name.startsWith('process_'))
    )
      return this.remote(run, name, args, wireId);
    if (this.schedules && scheduleToolList.some((tool) => tool.name === name))
      return this.schedules.invoke(run, name, args);
    if (!unavailable && computerToolList.some((tool) => tool.name === name)) {
      // Screen actions return images; a text-only route must not operate blindly or receive unsupported image content.
      if (!(run.vision ?? (!run.model || modelHasVision(run.model))))
        return { isError: true, content: [{ type: 'text', text: 'MODEL_COMPUTER_UNSUPPORTED' }] };
      return this.computer && this.hasComputer(run.bot, run.model, run.vision)
        ? this.computer.invoke(run, name, args)
        : { isError: true, content: [{ type: 'text', text: 'COMPUTER_NOT_CONNECTED' }] };
    }
    const dataTool = [
      this.bots,
      this.memory,
      this.history,
      this.knowledge,
      this.work,
      this.notes,
      this.localFiles,
      this.localCommands,
      this.catalog,
      this.software,
      this.skills,
      this.groups,
      this.hasBrowser(run.bot, run)
        ? this.hostSelected(run.bot, run)
          ? this.hostBrowser
          : this.browser
        : undefined,
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
        const result = await this.integrations!.invoke(run, name, args, wireId);
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
      if (
        dataTool &&
        (dataTool === this.software || dataTool === this.skills || dataTool === this.localCommands)
      ) {
        // Command approvals and deduplication require the original model call identity.
        const response = await dataTool.invoke(run, name, args, wireId);
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
        const { file, root } = await this.target(
          run,
          args.path ?? '',
          name === 'write_file' || name === 'verify_csv',
        );
        // Keep legacy path fields while giving the model a reusable path in this tool's workspace.
        const reference = fileReference(run, root, file);
        if (name === 'verify_csv') {
          const checked = await this.verifyCsv(run, reference, csvCheck(args.rows, args.sum));
          trace.phase = checked.code ? 'rejected' : 'settled';
          trace.code = checked.code;
          return { ...text(checked), ...(checked.code ? { isError: true } : {}) };
        }
        if (name === 'write_file') {
          if (
            typeof args.content !== 'string' ||
            Buffer.byteLength(args.content) > 200 * 1024 ||
            args.content.includes('\0') ||
            (args.createOnly !== undefined && typeof args.createOnly !== 'boolean')
          )
            throw new Fault('INVALID_TOOL_ARGS', 400);
          const saved = args.createOnly
            ? await this.publishFile(run, file, Buffer.from(args.content), 'FILE_EXISTS')
            : await this.write(run, file, args.content);
          result = { ...saved, reference };
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
            const source = await this.workspace.download(workspacePath(root, file));
            const image = imageInput(source);
            run.abort.signal.throwIfAborted();
            trace.phase = 'settled';
            return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
          }
          if (name === 'list_files') {
            if (!info.isDirectory()) throw new Fault('INVALID_FILE', 400);
            const files = await new WorkspaceFiles(canonical).list();
            result = {
              directory: file,
              reference,
              files: files.map((entry) => ({
                ...entry,
                reference: fileReference(run, root, path.join(canonical, entry.path)),
              })),
            };
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
            const actual = await this.workspace.read(workspacePath(root, file)),
              content = actual.content || '';
            const end = Number(offset) + Number(limit);
            result = {
              path: file,
              reference,
              content: content.slice(Number(offset), end),
              ...(end < content.length ? { nextOffset: end } : {}),
            };
          }
        }
      }
      const failed =
        (dataTool === this.browser || dataTool === this.hostBrowser) &&
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
        content: [
          {
            type: 'text',
            text:
              code === 'FILE_EXISTS'
                ? 'FILE_EXISTS: The existing file was preserved. Use another path if the user allows it, or ask before replacing this file.'
                : dataTool
                  ? code
                  : `${code}: ${errorMessage(error)}`,
          },
        ],
      };
    }
  }
}
