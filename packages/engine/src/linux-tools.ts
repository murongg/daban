import { createHash } from 'node:crypto';
import {
  type ExecutionSnapshot,
  isComputerAck,
  isComputerStatus,
  isRuntimeDownload,
  isTaskFileName,
  type SkillPackage,
  validAgentId,
} from '@daban/protocol';
import { type AgentToolRun, AgentTools, agentToolList } from './agent-tools.js';
import { browserToolList } from './browser-tools.js';
import { computerToolList, type ToolResult } from './computer-tools.js';
import { errorCode, Fault } from './control.js';
import { processToolList } from './process-catalog.js';
import { RemoteWorkspace, type WorkspaceExecutor } from './remote-workspace.js';
import type { AgentWorkspace } from './workspace.js';

const files = agentToolList.filter((tool) =>
  ['list_files', 'read_file', 'write_file', 'read_image'].includes(tool.name),
);
const transfers = [
  {
    name: 'linux_upload',
    description:
      'Copy one file from this native task into its Linux task, starting installed Linux on demand. Relative paths only. The destination is its filename; existing Linux inputs are never overwritten.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'linux_download',
    description:
      'Copy one Linux task output into this native task under linux-outputs, making it available for download. Relative paths only. Existing native outputs are never overwritten.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

/** Linux has its own directory and leases. A native task never becomes a guest task mid-turn. */
export class LinuxTools {
  enabled = false;
  online = false;
  private readonly files: RemoteWorkspace;
  get workspace() {
    return this.files;
  }
  private readonly remote: AgentTools;
  private readonly runs = new WeakMap<AgentToolRun, AgentToolRun>();
  private readonly bindings = new WeakMap<AgentToolRun, { boot: string; nonce: string }>();
  private readonly preparing = new WeakMap<AgentToolRun, Promise<AgentToolRun>>();
  readonly list = [
    {
      ...agentToolList.find((tool) => tool.name === 'shell')!,
      description:
        'Execute Bash/Python in the Linux VM only when the human explicitly requests VM execution. For local task scripts, use workspace_shell when offered. This tool starts the VM on demand and uses a separate Linux task directory with copies of captured attachments. Use relative paths; native task paths do not exist in Linux. Full guest files, network and sudo are available under host command approval. Use linux_upload for other native task files and linux_download to return generated outputs. Use process_start for long commands.',
    },
    ...processToolList,
    ...files.map((tool) => ({
      ...tool,
      name: `linux_${tool.name}`,
      description: `In the separate Linux workspace, starting it on demand: ${tool.description}`,
    })),
    ...transfers,
  ];
  constructor(
    private readonly execution: WorkspaceExecutor & { snapshot?: ExecutionSnapshot },
    private readonly native: AgentWorkspace,
    owner: AgentTools,
    private readonly observe?: () => Promise<unknown>,
  ) {
    this.files = new RemoteWorkspace(execution);
    this.remote = new AgentTools(undefined, this.files, { execution });
    this.remote.executeRemote = (run, name, args, wireId, dispatch) => {
      if (!owner.executeRemote) throw new Fault('COMMAND_APPROVAL_UNAVAILABLE');
      return owner.executeRemote(run, name, args, wireId, dispatch);
    };
    this.remote.authorizeComputer = (run) => owner.authorizeComputer?.(run) ?? Promise.resolve();
  }
  hasComputer(bot: string) {
    return (
      this.enabled &&
      this.online &&
      this.execution.snapshot?.status.items.some(
        (item) => item.bot === bot && item.phase === 'connected',
      ) === true
    );
  }
  async connectComputer(run: AgentToolRun, id: string) {
    if (!this.enabled) throw new Fault('LOCAL_VM_UNAVAILABLE');
    if (this.hasComputer(run.bot)) return;
    const signal = run.abort.signal;
    await this.files.base();
    const status = await this.execution.call('computer.status', {}, signal);
    if (!isComputerStatus(status)) throw new Fault('EXECUTION_INVALID_RESPONSE');
    const current = status.items.find((item) => item.bot === run.bot);
    if (current?.phase !== 'connected') {
      const ack = await this.execution.call(
        'computer.request',
        {
          method: 'POST',
          path: '/api/computers/action',
          body: { id, bot: run.bot, action: 'connect', revision: current?.revision ?? 0 },
        },
        signal,
      );
      if (!isComputerAck(ack) || ack.receipt.id !== id || ack.state.bot !== run.bot)
        throw new Fault('EXECUTION_INVALID_RESPONSE');
      if (ack.state.phase !== 'connected')
        throw new Fault(ack.receipt.error || 'COMPUTER_NOT_CONNECTED');
    }
    await this.observe?.();
    signal.throwIfAborted();
    if (!this.hasComputer(run.bot)) throw new Fault('COMPUTER_NOT_CONNECTED');
  }
  listFor(bot: string, vision: boolean, local: boolean) {
    return [
      ...this.list.filter((tool) => tool.name !== 'linux_read_image' || vision),
      ...(!local && this.hasComputer(bot)
        ? [...(vision ? computerToolList : []), ...browserToolList]
        : []),
    ];
  }
  owns(name: string) {
    return [...this.list, ...computerToolList, ...browserToolList].some(
      (tool) => tool.name === name,
    );
  }
  restarted(run: AgentToolRun, snapshot: ExecutionSnapshot) {
    const binding = this.bindings.get(run);
    return !!binding && (binding.boot !== snapshot.boot || binding.nonce !== snapshot.nonce);
  }
  private async use(run: AgentToolRun) {
    const guest = await this.prepare(run);
    await this.observe?.();
    run.abort.signal.throwIfAborted();
    return guest;
  }
  async stageSkill(run: AgentToolRun, bundle: SkillPackage) {
    if (!this.enabled) throw new Fault('LOCAL_VM_UNAVAILABLE');
    const guest = await this.use(run);
    return this.files
      .scope(guest.workdir, guest.canonicalRoot)
      .stageSkill(bundle, run.abort.signal);
  }
  private prepare(run: AgentToolRun) {
    const existing = this.runs.get(run);
    if (existing) return Promise.resolve(existing);
    let pending = this.preparing.get(run);
    if (!pending) {
      pending = this.create(run).finally(() => this.preparing.delete(run));
      this.preparing.set(run, pending);
    }
    return pending;
  }
  private async create(run: AgentToolRun) {
    if (!validAgentId(run.id) || !validAgentId(run.bot))
      throw new Fault('EXECUTION_INVALID_REQUEST');
    run.abort.signal.throwIfAborted();
    await this.files.base();
    const snapshot = this.execution.snapshot;
    if (snapshot) this.bindings.set(run, { boot: snapshot.boot, nonce: snapshot.nonce });
    // Bind after waking: the task that cold-started Linux belongs to its new boot, not the cached old one.
    await this.observe?.();
    run.abort.signal.throwIfAborted();
    const directory = await this.files.create(['model-runs', run.id, run.bot]);
    try {
      const input = this.native.scope(run.workdir, run.canonicalRoot);
      for (const name of run.inputs ?? []) {
        if (!isTaskFileName(name)) throw new Fault('INVALID_FILE');
        run.abort.signal.throwIfAborted();
        const source = await input.download(name);
        await directory.write(name, Buffer.from(source.data, 'base64'), run.abort.signal);
      }
      await directory.verify();
      run.abort.signal.throwIfAborted();
      const mirror: AgentToolRun = {
        ...run,
        beforeTool: undefined,
        workdir: directory.path,
        canonicalRoot: directory.canonical,
        get executionId() {
          return run.executionId;
        },
        get toolCount() {
          return run.toolCount;
        },
        set toolCount(value) {
          run.toolCount = value;
        },
        get waitingForComputer() {
          return run.waitingForComputer;
        },
        set waitingForComputer(value) {
          run.waitingForComputer = value;
        },
      };
      this.runs.set(run, mirror);
      return mirror;
    } finally {
      await directory.close();
    }
  }
  async invoke(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
    wireId?: string,
  ): Promise<ToolResult> {
    let delegated = false;
    try {
      if (run.toolCount >= run.limit) {
        run.onLimit?.();
        throw new Fault('TOOL_LIMIT');
      }
      if (!this.enabled) throw new Fault('LOCAL_VM_UNAVAILABLE');
      if (
        (computerToolList.some((tool) => tool.name === name) || name.startsWith('browser_')) &&
        !this.hasComputer(run.bot)
      )
        throw new Fault('COMPUTER_NOT_CONNECTED');
      run.abort.signal.throwIfAborted();
      if (name === 'linux_upload' || name === 'linux_download') {
        delegated = true;
        return await this.transfer(run, name, args);
      }
      const guest = await this.use(run);
      delegated = true;
      return await this.remote.invoke(
        guest,
        name.startsWith('linux_') ? name.slice(6) : name,
        args,
        wireId,
      );
    } catch (error) {
      if (!delegated) run.toolCount++;
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: run.abort.signal.aborted
              ? 'MODEL_CANCELLED'
              : errorCode(error) || 'LINUX_TOOL_UNAVAILABLE',
          },
        ],
      };
    }
  }
  private async transfer(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (++run.toolCount > run.limit) {
      run.onLimit?.();
      throw new Fault('TOOL_LIMIT');
    }
    if (
      Object.keys(args).some((key) => key !== 'path') ||
      typeof args.path !== 'string' ||
      !args.path ||
      args.path.startsWith('/') ||
      args.path.includes('\\') ||
      args.path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Fault('INVALID_FILE');
    const trace = {
      name,
      surface: 'workspace',
      at: new Date().toISOString(),
      phase: 'running' as 'running' | 'settled' | 'rejected',
    };
    run.trace.push(trace);
    try {
      const guest = await this.use(run);
      const source = await (name === 'linux_upload' ? this.native : this.files)
        .scope(
          name === 'linux_upload' ? run.workdir : guest.workdir,
          name === 'linux_upload' ? run.canonicalRoot : guest.canonicalRoot,
        )
        .download(args.path);
      if (!isRuntimeDownload(source) || !isTaskFileName(source.name))
        throw new Fault('INVALID_EXECUTOR_RESPONSE');
      const bytes = Buffer.from(source.data, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256)
        throw new Fault('INVALID_EXECUTOR_RESPONSE');
      const target =
        name === 'linux_upload'
          ? await this.files.create(['model-runs', run.id!, run.bot])
          : await this.native.scope(run.workdir, run.canonicalRoot).create(['linux-outputs']);
      try {
        await target.write(source.name, bytes, run.abort.signal);
      } finally {
        await target.close();
      }
      trace.phase = 'settled';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              path: name === 'linux_upload' ? source.name : `linux-outputs/${source.name}`,
              bytes: bytes.length,
            }),
          },
        ],
      };
    } catch (error) {
      trace.phase = 'rejected';
      throw error;
    }
  }
  async drain(run: AgentToolRun) {
    await this.preparing.get(run)?.catch(() => {});
    const guest = this.runs.get(run);
    if (guest) await this.remote.drain(guest);
  }
  async cancel(run: AgentToolRun) {
    const guest = this.runs.get(run);
    if (guest) await this.remote.cancel(guest);
  }
}
