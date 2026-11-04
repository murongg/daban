import path from 'node:path';
import type { ProjectFileScope } from '@daban/protocol';
import { type RuntimeDownload, type SkillPackage, skillPackageCapability } from '@daban/protocol';
import { Fault } from './control.js';
import type { AgentWorkspace, TaskDirectory, WorkspaceFile } from './workspace.js';

export interface WorkspaceExecutor {
  readonly snapshot?: {
    capabilities: string[];
    computer?: import('@daban/protocol').ExecutionComputerSnapshot;
  };
  call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
interface DirectoryReference {
  root: string;
  path: string;
  canonical: string;
  handleId: string;
}

export class RemoteWorkspace implements AgentWorkspace {
  constructor(
    readonly execution: WorkspaceExecutor,
    public root = '',
    private readonly canonical?: string,
    private readonly initialRoot?: string,
    private readonly project?: ProjectFileScope,
    private readonly authorize?: () => unknown,
  ) {}
  private params(extra: Record<string, unknown> = {}) {
    this.authorize?.();
    return {
      ...(this.project ? { project: this.project } : {}),
      ...(this.root ? { root: this.root } : {}),
      ...(this.canonical ? { canonical: this.canonical } : {}),
      ...extra,
    };
  }
  async prepare() {
    // Offline composition may restore a previously verified guest path, never a host filesystem adapter.
    if (this.initialRoot) return this.initialRoot;
    return this.base();
  }
  async base() {
    const root = await this.execution.call('workspace.base', this.params());
    if (typeof root !== 'string' || !path.posix.isAbsolute(root))
      throw new Fault('INVALID_EXECUTOR_RESPONSE', 503);
    if (this.initialRoot && root !== this.initialRoot) throw new Fault('WORKSPACE_CHANGED');
    this.root = root;
    return root;
  }
  scope(root: string, canonical?: string) {
    return new RemoteWorkspace(
      this.execution,
      root,
      canonical,
      undefined,
      this.project,
      this.authorize,
    );
  }
  async create(parts: string[]): Promise<TaskDirectory> {
    const reference = (await this.execution.call(
      'workspace.create',
      this.params({ parts }),
    )) as DirectoryReference;
    if (
      !reference ||
      ![reference.root, reference.path, reference.canonical].every(
        (value) => typeof value === 'string' && path.posix.isAbsolute(value),
      ) ||
      typeof reference.handleId !== 'string'
    )
      throw new Fault('INVALID_EXECUTOR_RESPONSE', 503);
    const call = (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
      if (method !== 'workspace.close') this.authorize?.();
      return this.execution.call(method, { handleId: reference.handleId, ...params }, signal);
    };
    return {
      root: reference.root,
      path: reference.path,
      canonical: reference.canonical,
      verify: () => call('workspace.verify'),
      write: (name, data, signal) =>
        call('workspace.write', { name, data: Buffer.from(data).toString('base64') }, signal),
      close: () => call('workspace.close'),
    };
  }
  async list() {
    return (await this.execution.call('workspace.list', this.params())) as WorkspaceFile[];
  }
  async read(relative: string, limit?: number) {
    return (await this.execution.call(
      'workspace.read',
      this.params({ path: relative, ...(limit === undefined ? {} : { limit }) }),
    )) as WorkspaceFile & { content: string };
  }
  async download(relative: string) {
    return (await this.execution.call(
      'workspace.download',
      this.params({ path: relative }),
    )) as RuntimeDownload;
  }
  async stageSkill(bundle: SkillPackage, signal?: AbortSignal) {
    if (!this.execution.snapshot?.capabilities.includes(skillPackageCapability))
      throw new Fault('EXECUTION_UPGRADE_REQUIRED', 409);
    const result = await this.execution.call(
      'workspace.skill',
      this.params({ package: bundle }),
      signal,
    );
    const root = this.canonical ?? this.root;
    if (
      typeof result !== 'string' ||
      !result.startsWith(root + '/.skills-') ||
      result.slice(root.length + 1).includes('/')
    )
      throw new Fault('INVALID_EXECUTOR_RESPONSE', 503);
    return result;
  }
}
